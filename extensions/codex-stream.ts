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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

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

const IMPORT_FROM_SPECIFIER = /from\s+(["'])([^"']+)\1/g;

function stripSourceMappingUrl(source: string): string {
	return source.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
}
const CODEX_MODULE_RELATIVE = join(
	"node_modules",
	"@earendil-works",
	"pi-ai",
	"dist",
	"api",
	"openai-codex-responses.js",
);

/**
 * Well-known filesystem locations for openai-codex-responses.js on bundled hosts.
 *
 * @param homeDirectory - User home used as the root for `.omp` and `.pi` plugin trees
 * @returns Candidate absolute paths in probe order
 */
export function wellKnownCodexModuleCandidates(homeDirectory: string): string[] {
	return [
		join(homeDirectory, ".omp", "plugins", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".omp",
			"plugins",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join(homeDirectory, ".pi", "agent", "npm", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".pi",
			"agent",
			"npm",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
	];
}

/**
 * Rewrite one module so relative and bare imports become absolute file URLs
 * resolved from `originalPath`'s package graph.
 *
 * @param source - Module source containing `from "..."` specifiers
 * @param originalPath - Physical file used as the resolve base
 * @returns Source with resolvable file URL imports
 */
export function rewritePatchedModuleImports(source: string, originalPath: string): string {
	const requireFromOriginal = createRequire(pathToFileURL(originalPath));
	const originalDir = dirname(originalPath);
	return stripSourceMappingUrl(
		source.replace(IMPORT_FROM_SPECIFIER, (full, _quote: string, specifier: string) => {
			if (specifier.startsWith("node:") || isBuiltin(specifier)) {
				return full;
			}
			if (specifier.startsWith(".")) {
				return `from ${JSON.stringify(pathToFileURL(join(originalDir, specifier)).href)}`;
			}
			const resolved = requireFromOriginal.resolve(specifier);
			return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
		}),
	);
}

/**
 * Write a patched module (and rewritten local relatives) so a cache file
 * outside the original tree can still resolve bare deps such as `partial-json`.
 *
 * @param outputPath - Destination `.mjs` path, typically under tmpdir
 * @param source - Patched entry source
 * @param originalPath - Physical openai-codex-responses.js used for resolution
 */
export function writePatchedModuleCache(outputPath: string, source: string, originalPath: string): void {
	mkdirSync(dirname(outputPath), { recursive: true });
	const cacheDir = dirname(outputPath);
	const rewrittenLocals = new Map<string, string>();

	const rewrite = (moduleSource: string, moduleOriginalPath: string): string => {
		const requireFromOriginal = createRequire(pathToFileURL(moduleOriginalPath));
		const originalDir = dirname(moduleOriginalPath);
		return stripSourceMappingUrl(
			moduleSource.replace(IMPORT_FROM_SPECIFIER, (full, _quote: string, specifier: string) => {
				if (specifier.startsWith("node:") || isBuiltin(specifier)) {
					return full;
				}
				if (specifier.startsWith(".")) {
					const targetOriginal = normalize(join(originalDir, specifier));
					let targetUrl = rewrittenLocals.get(targetOriginal);
					if (!targetUrl) {
						if (!existsSync(targetOriginal)) {
							return `from ${JSON.stringify(pathToFileURL(targetOriginal).href)}`;
						}
						const localName = `local-${createHash("sha1").update(targetOriginal).digest("hex").slice(0, 12)}.mjs`;
						const localPath = join(cacheDir, localName);
						targetUrl = pathToFileURL(localPath).href;
						rewrittenLocals.set(targetOriginal, targetUrl);
						writeFileSync(localPath, rewrite(readFileSync(targetOriginal, "utf8"), targetOriginal), "utf8");
					}
					return `from ${JSON.stringify(targetUrl)}`;
				}
				const resolved = requireFromOriginal.resolve(specifier);
				return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
			}),
		);
	};

	writeFileSync(outputPath, rewrite(source, originalPath), "utf8");
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

export interface ResolveOriginalCodexModulePathOptions {
	/** Override `import.meta.resolve`. Throw to simulate a bundled host with no package graph. */
	resolveSpecifier?: (specifier: string) => string;
	/** Override `process.argv[1]`. Pass a non-Node host path to skip createRequire success. */
	nodeEntry?: string | undefined;
	/** Override `HOME` / `USERPROFILE` for well-known filesystem fallbacks. */
	homeDirectory?: string | undefined;
}

/**
 * Locate the physical openai-codex-responses.js used as the patch source.
 *
 * Probe order: import.meta.resolve, argv/createRequire, then HOME/well-known paths.
 *
 * @param options - Optional resolve/argv/home overrides for tests and bundled hosts
 * @returns Existing module path and its directory
 * @throws If no candidate exists on disk
 */
export function resolveOriginalCodexModulePath(options: ResolveOriginalCodexModulePathOptions = {}): {
	path: string;
	dir: string;
} {
	// Under pi's extension loader, `@earendil-works/pi-ai` may resolve to dist/compat.js
	// and package subpath resolve for `/api/*` can fail. Prefer locating the physical
	// dist file next to the resolved package entry.
	const resolveSpecifier = options.resolveSpecifier ?? ((specifier: string) => import.meta.resolve(specifier));
	const nodeEntry = "nodeEntry" in options ? options.nodeEntry : process.argv[1];
	const homeDirectory =
		"homeDirectory" in options ? options.homeDirectory : process.env.HOME || process.env.USERPROFILE;
	const candidates: string[] = [];

	try {
		const subpath = resolveSpecifier("@earendil-works/pi-ai/api/openai-codex-responses");
		candidates.push(fileURLToPath(subpath));
	} catch {
		// ignore and try filesystem candidates
	}

	try {
		const main = fileURLToPath(resolveSpecifier("@earendil-works/pi-ai"));
		const distDir = dirname(main);
		candidates.push(join(distDir, "api/openai-codex-responses.js"));
		candidates.push(join(distDir, "openai-codex-responses.js"));
	} catch {
		// ignore
	}

	// pi 0.84.3's bundled Node CLI exposes pi-ai as a virtual module to
	// extensions. Resolve its physical nested dependency from the CLI entry so
	// the source-patching transport can still read the installed implementation.
	// Oh My Pi Mach-O hosts do not have a Node entry at argv[1]; skip quietly.
	if (nodeEntry) {
		const bundledHostModule = resolveCodexModuleFromNodeEntry(nodeEntry);
		if (bundledHostModule) {
			candidates.push(bundledHostModule);
		}
	}

	if (homeDirectory) {
		candidates.push(...wellKnownCodexModuleCandidates(homeDirectory));
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
	const { path: originalPath } = resolveOriginalCodexModulePath();
	const originalSource = readFileSync(originalPath, "utf8");
	const patched = patchCodexSource(originalSource, providerIds);

	const hash = createHash("sha1").update("resolved-imports-v1\n").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `openai-codex-responses-cpa-${hash}.mjs`);
	if (!existsSync(outPath)) {
		writePatchedModuleCache(outPath, patched, originalPath);
	}

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
