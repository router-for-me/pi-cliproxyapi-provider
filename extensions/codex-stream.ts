/**
 * Load a patched openai-codex-responses implementation for CLIProxyAPI.
 *
 * Differences from stock pi-ai:
 * - extractAccountId never throws; plain API keys are allowed
 * - chatgpt-account-id header is omitted when account id is unavailable
 * - provider id(s) are added to CODEX_TOOL_CALL_PROVIDERS for tool-call id handling
 * - model/message api id uses cliproxyapi-codex-responses
 *
 * The patched module is derived at runtime from the installed
 * @earendil-works/pi-ai openai-codex-responses implementation so we track
 * upstream protocol fixes without vendoring 1200+ lines.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { autoDetectProtocol, type ProtocolMode } from "./lib.ts";

export const CLIPROXYAPI_CODEX_API = "cliproxyapi-codex-responses" as const;

export type CliproxyCodexStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CliproxyCodexStreams = {
	streamSimple: CliproxyCodexStreamSimple;
	stream: CliproxyCodexStreamSimple;
	api: typeof CLIPROXYAPI_CODEX_API;
};

export interface CliproxyCodexStreamOptions {
	shouldUseFast?: (model: Model<Api>) => boolean;
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}

/** Apply Fast before pi's shared payload hooks so later extensions retain final control. */
export async function applyFastPayloadHook(
	payload: unknown,
	model: Model<Api>,
	onPayload?: PayloadHook,
): Promise<unknown> {
	const fastPayload = withPriorityServiceTier(payload);
	const nextPayload = await onPayload?.(fastPayload, model);
	return nextPayload === undefined ? fastPayload : nextPayload;
}

export function wrapStreamSimpleForFast(
	streamSimple: CliproxyCodexStreamSimple,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamSimple {
	return (model, context, streamOptions) => {
		if (!shouldUseFast?.(model)) {
			return streamSimple(model, context, streamOptions);
		}
		return streamSimple(model, context, {
			...streamOptions,
			onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, streamOptions?.onPayload),
		});
	};
}

export function isBunEmbeddedRuntimeEntry(entryPath: string | undefined): boolean {
	return entryPath?.replaceAll("\\", "/").includes("/$bunfs/") ?? false;
}

function cacheContentMatches(path: string, expected: string): boolean {
	try {
		return readFileSync(path, "utf8") === expected;
	} catch {
		return false;
	}
}

export function ensurePatchedModuleCache(
	targetPath: string,
	expected: string,
	options: { rename?: (temporaryPath: string, finalPath: string) => void } = {},
): void {
	if (cacheContentMatches(targetPath, expected)) return;

	const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	let failure: { error: unknown } | undefined;
	try {
		writeFileSync(temporaryPath, expected, { encoding: "utf8", flag: "wx" });
		try {
			(options.rename ?? renameSync)(temporaryPath, targetPath);
		} catch (error) {
			if (!cacheContentMatches(targetPath, expected)) throw error;
		}
	} catch (error) {
		failure = { error };
	}

	try {
		unlinkSync(temporaryPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !failure) failure = { error };
	}
	if (failure) throw failure.error;
}

const EXTRACT_ACCOUNT_ID_PATCH = `function extractAccountId(token) {
    // CLIProxyAPI accepts plain API keys as well as ChatGPT JWTs.
    // Never throw: missing account id simply means no chatgpt-account-id header.
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return "";
        const payload = JSON.parse(atob(parts[1]));
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        return typeof accountId === "string" && accountId.trim() ? accountId : "";
    }
    catch {
        return "";
    }
}`;

function rewriteModuleImports(source: string, originalDir: string): string {
	const require = createRequire(pathToFileURL(join(originalDir, "__pi_ai_resolver__.cjs")));
	return source.replace(/from\s+(["'])([^"']+)\1/g, (full, _quote: string, specifier: string) => {
		if (specifier.startsWith("node:") || isBuiltin(specifier)) return full;
		const resolved = specifier.startsWith(".") ? join(originalDir, specifier) : require.resolve(specifier);
		return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
	});
}

function patchWebSocketOnlyTransport(source: string): string {
	const sessionIdExpression = String.raw`(?:options\?\.sessionId|cacheSessionId)`;
	const disabledForSession = new RegExp(
		String.raw`const websocketDisabledForSession\s*=\s*transport !== "sse" && isWebSocketSseFallbackActive\(${sessionIdExpression}\);`,
	);
	const retryVariables = /let retriedWebSocketConnectionLimit\s*=\s*false;/;
	const connectionLimitRetry =
		/if \(!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit\) \{\s*retriedWebSocketConnectionLimit = true;\s*continue;\s*\}/;
	const websocketFailureHandling = new RegExp(
		String.raw`if \(aborted \|\| \(isCodexNonTransportError\(error\) && !connectionLimitBeforeStart\)\) \{[\s\S]*?recordWebSocketFailure\((${sessionIdExpression}), error\);[\s\S]*?recordWebSocketSseFallback\(\1\);\s*break;`,
	);
	const fallbackSessionRecord = "websocketSseFallbackSessions.add(sessionId);";
	const fallbackActiveRecord = "stats.websocketFallbackActive = true;";

	for (const fragment of [fallbackSessionRecord, fallbackActiveRecord]) {
		if (!source.includes(fragment)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket-only transport patch");
		}
	}
	for (const pattern of [disabledForSession, retryVariables, connectionLimitRetry, websocketFailureHandling]) {
		if (!pattern.test(source)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket-only transport patch");
		}
	}

	return source
		.replace(disabledForSession, "const websocketDisabledForSession = false;")
		.replace(
			retryVariables,
			`let websocketRetries = 0;
                const maxWebSocketRetries = Number.isFinite(options?.maxRetries)
                    ? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)
                    : 3;`,
		)
		.replace(connectionLimitRetry, "")
		.replace(
			websocketFailureHandling,
			(
				_match,
				activeSessionId: string,
			) => `if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
                            throw error;
                        }
                        if (!websocketStarted && websocketRetries < maxWebSocketRetries) {
                            websocketRetries++;
                            continue;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport,
                            fallbackTransport: undefined,
                            eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
                            requestBytes: new TextEncoder().encode(bodyJson).byteLength,
                        }));
                        recordWebSocketFailure(${activeSessionId}, error);
                        throw error;`,
		)
		.replace(fallbackSessionRecord, "")
		.replace(fallbackActiveRecord, "stats.websocketFallbackActive = false;");
}

export function patchCodexSource(source: string, providerIds: string[]): string {
	let src = source;

	if (!/function extractAccountId\(token\) \{/.test(src)) {
		throw new Error("openai-codex-responses source no longer contains extractAccountId(token)");
	}
	src = src.replace(/function extractAccountId\(token\) \{[\s\S]*?\n\}/, EXTRACT_ACCOUNT_ID_PATCH);

	if (!src.includes(`headers.set("chatgpt-account-id", accountId);`)) {
		throw new Error("openai-codex-responses source no longer sets chatgpt-account-id");
	}
	src = src.replace(
		`headers.set("chatgpt-account-id", accountId);`,
		`if (accountId) {\n        headers.set("chatgpt-account-id", accountId);\n    }`,
	);

	const providersMatch = src.match(/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/);
	if (!providersMatch) {
		throw new Error("openai-codex-responses source no longer defines CODEX_TOOL_CALL_PROVIDERS");
	}
	const existing = providersMatch[1];
	const extras = providerIds
		.filter((id) => id.trim())
		.map((id) => JSON.stringify(id.trim()))
		.join(", ");
	src = src.replace(
		/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/,
		`const CODEX_TOOL_CALL_PROVIDERS = new Set([${existing}${extras ? `, ${extras}` : ""}]);`,
	);

	// Keep assistant message api metadata aligned with the registered custom api id.
	src = src.replaceAll(`api: "openai-codex-responses"`, `api: ${JSON.stringify(CLIPROXYAPI_CODEX_API)}`);

	// CLIProxyAPI needs a persistent WebSocket transport. Reconnect before the
	// response starts and surface a failure rather than silently switching to SSE.
	src = patchWebSocketOnlyTransport(src);

	// The generated module lives outside the original source map directory.
	src = src.replace(/^\/\/# sourceMappingURL=.*$/gm, "");

	return src;
}

export function resolveCodexModuleFromNodeEntry(entryPath: string): string | undefined {
	try {
		const require = createRequire(pathToFileURL(realpathSync(entryPath)));
		for (const nodeModulesDir of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
			const candidate = join(nodeModulesDir, "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js");
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	} catch {
		// Ignore invalid or unavailable runtime entrypoints.
	}
	return undefined;
}

function resolveOriginalCodexModulePath(): { path: string; dir: string } {
	// Under pi's extension loader, `@earendil-works/pi-ai` may resolve to dist/compat.js
	// and package subpath resolve for `/api/*` can fail. Prefer locating the physical
	// dist file next to the resolved package entry.
	const candidates: string[] = [];

	try {
		const subpath = import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses");
		candidates.push(fileURLToPath(subpath));
	} catch {
		// ignore and try filesystem candidates
	}

	try {
		const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
		const distDir = dirname(main);
		candidates.push(join(distDir, "api/openai-codex-responses.js"));
		candidates.push(join(distDir, "openai-codex-responses.js"));
	} catch {
		// ignore
	}

	// pi 0.84.3's bundled Node CLI exposes pi-ai as a virtual module to
	// extensions. Resolve its physical nested dependency from the CLI entry so
	// the source-patching transport can still read the installed implementation.
	if (process.argv[1]) {
		const bundledHostModule = resolveCodexModuleFromNodeEntry(process.argv[1]);
		if (bundledHostModule) {
			candidates.push(bundledHostModule);
		}
	}

	for (const path of candidates) {
		if (path && existsSync(path)) {
			return { path, dir: dirname(path) };
		}
	}

	throw new Error(`Cannot resolve openai-codex-responses.js (tried: ${candidates.join(", ") || "none"})`);
}

export async function loadCliproxyCodexStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	const { path: originalPath, dir: originalDir } = resolveOriginalCodexModulePath();
	const originalSource = readFileSync(originalPath, "utf8");
	const patched = rewriteModuleImports(patchCodexSource(originalSource, providerIds), originalDir);

	const hash = createHash("sha1").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `openai-codex-responses-cpa-${hash}.mjs`);
	ensurePatchedModuleCache(outPath, patched);

	const mod = (await import(pathToFileURL(outPath).href)) as {
		streamSimple: CliproxyCodexStreamSimple;
		stream: CliproxyCodexStreamSimple;
	};

	if (typeof mod.streamSimple !== "function" || typeof mod.stream !== "function") {
		throw new Error("patched openai-codex-responses module missing streamSimple/stream exports");
	}

	const streamSimple = wrapStreamSimpleForFast(mod.streamSimple, options.shouldUseFast);

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		stream: mod.stream,
	};
}

export function patchResponsesSource(source: string, providerIds: string[]): string {
	const providersMatch = source.match(/const OPENAI_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/);
	if (!providersMatch) {
		throw new Error("openai-responses source no longer defines OPENAI_TOOL_CALL_PROVIDERS");
	}
	const existing = providersMatch[1];
	const extras = providerIds
		.filter((id) => id.trim())
		.map((id) => JSON.stringify(id.trim()))
		.join(", ");
	let patched = source.replace(
		/const OPENAI_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/,
		`const OPENAI_TOOL_CALL_PROVIDERS = new Set([${existing}${extras ? `, ${extras}` : ""}]);`,
	);
	patched = patched.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
	return patched;
}

function resolveOriginalResponsesModulePath(): { path: string; dir: string } {
	const candidates: string[] = [];
	const embeddedBun = isBunEmbeddedRuntimeEntry(process.argv[1]);

	if (!embeddedBun) {
		try {
			const subpath = import.meta.resolve("@earendil-works/pi-ai/api/openai-responses");
			candidates.push(fileURLToPath(subpath));
		} catch {
			// Ignore and try filesystem candidates.
		}

		try {
			const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
			const distDir = dirname(main);
			candidates.push(join(distDir, "api/openai-responses.js"));
			candidates.push(join(distDir, "openai-responses.js"));
		} catch {
			// Ignore and try the runtime entrypoint.
		}
	} else {
		candidates.push(
			join(process.cwd(), "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-responses.js"),
		);
	}

	if (process.argv[1]) {
		try {
			const require = createRequire(pathToFileURL(realpathSync(process.argv[1])));
			for (const nodeModulesDir of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
				const candidate = join(nodeModulesDir, "@earendil-works", "pi-ai", "dist", "api", "openai-responses.js");
				if (existsSync(candidate)) candidates.push(candidate);
			}
		} catch {
			// Ignore invalid or unavailable runtime entrypoints.
		}
	}

	for (const path of candidates) {
		if (path && existsSync(path)) return { path, dir: dirname(path) };
	}

	if (embeddedBun) {
		throw new Error(
			"embedded Bun could not locate a physical openai-responses.js; openai-responses protocol is unavailable in this runtime",
		);
	}
	throw new Error(`Cannot resolve openai-responses.js (tried: ${candidates.join(", ") || "none"})`);
}

export async function loadCliproxyResponsesStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	const { path: originalPath, dir: originalDir } = resolveOriginalResponsesModulePath();
	const originalSource = readFileSync(originalPath, "utf8");
	const patched = rewriteModuleImports(patchResponsesSource(originalSource, providerIds), originalDir);

	const hash = createHash("sha1").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `openai-responses-cpa-${hash}.mjs`);
	ensurePatchedModuleCache(outPath, patched);

	const mod = (await import(pathToFileURL(outPath).href)) as {
		streamSimple?: CliproxyCodexStreamSimple;
		stream?: CliproxyCodexStreamSimple;
	};
	if (typeof mod.streamSimple !== "function" || typeof mod.stream !== "function") {
		throw new Error("patched openai-responses module missing streamSimple/stream exports");
	}

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple: wrapStreamSimpleForFast(mod.streamSimple, options.shouldUseFast),
		stream: mod.stream,
	};
}

export function detectProtocolFromBaseUrl(baseUrl: string | undefined): ProtocolMode {
	return autoDetectProtocol(baseUrl ?? "");
}

export function createProtocolStreamDispatcher(
	codexStreamSimple: CliproxyCodexStreamSimple,
	responsesStreamSimple?: CliproxyCodexStreamSimple,
	responsesUnavailableError?: unknown,
): CliproxyCodexStreamSimple {
	return (model, context, options) => {
		if (detectProtocolFromBaseUrl(model.baseUrl) !== "openai-responses") {
			return codexStreamSimple(model, context, options);
		}
		if (!responsesStreamSimple) {
			const reason =
				responsesUnavailableError === undefined
					? ""
					: `: ${responsesUnavailableError instanceof Error ? responsesUnavailableError.message : String(responsesUnavailableError)}`;
			throw new Error(`openai-responses protocol is unavailable for this runtime${reason}`, {
				cause: responsesUnavailableError,
			});
		}
		return responsesStreamSimple(model, context, options);
	};
}
