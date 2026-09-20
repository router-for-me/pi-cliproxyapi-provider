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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

interface TranscriptMessage {
	role?: string;
	content?: unknown;
	sections?: Record<string, string | null | undefined>;
	toolsAdded?: unknown[];
	toolsRemoved?: Array<{ name: string }>;
	[key: string]: unknown;
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text.trim())
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Adapt a pi >=0.86.0 TranscriptContext into a classic Context with top-level systemPrompt and tools.
 *
 * In pi >=0.86.0, custom provider stream handlers receive a normalized TranscriptContext where
 * system prompt sections and tool declarations are encoded into system messages inside context.messages.
 * Classic openai-codex-responses expects context.systemPrompt and context.tools, and fails when
 * encountering system messages inside context.messages during token estimation or payload generation.
 */
export function adaptTranscriptContext(context: Context | { messages?: unknown[]; [key: string]: unknown }): Context {
	if (!context || !Array.isArray(context.messages)) {
		return context as Context;
	}

	const rawMessages = context.messages as TranscriptMessage[];
	const hasSystemMessage = rawMessages.some((m) => m && m.role === "system");

	if (!hasSystemMessage) {
		return context as Context;
	}

	let leadingText = "";
	const sections = new Map<string, string>();
	const toolsMap = new Map<string, unknown>();

	if (Array.isArray(context.tools)) {
		for (const tool of context.tools) {
			if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
				toolsMap.set(tool.name, tool);
			}
		}
	}

	const nonSystemMessages: unknown[] = [];

	for (const msg of rawMessages) {
		if (!msg || typeof msg !== "object") continue;

		if (msg.role === "system") {
			const text = extractContentText(msg.content);
			if (text) {
				leadingText = leadingText ? `${leadingText}\n\n${text}` : text;
			}
			if (msg.sections && typeof msg.sections === "object") {
				for (const [name, sectionText] of Object.entries(msg.sections)) {
					if (sectionText === null || sectionText === undefined) {
						sections.delete(name);
					} else if (typeof sectionText === "string" && sectionText.trim()) {
						sections.set(name, sectionText.trim());
					}
				}
			}
			if (Array.isArray(msg.toolsRemoved)) {
				for (const tool of msg.toolsRemoved) {
					if (tool && typeof tool.name === "string") {
						toolsMap.delete(tool.name);
					}
				}
			}
			if (Array.isArray(msg.toolsAdded)) {
				for (const tool of msg.toolsAdded) {
					if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
						toolsMap.set(tool.name, tool);
					}
				}
			}
		} else {
			nonSystemMessages.push(msg);
		}
	}

	const sectionParts = [...sections.values()];
	const extractedSystemPrompt = [leadingText, ...sectionParts].filter(Boolean).join("\n\n");
	const finalSystemPrompt =
		extractedSystemPrompt || (typeof context.systemPrompt === "string" ? context.systemPrompt : undefined);
	const finalTools =
		toolsMap.size > 0
			? [...toolsMap.values()]
			: Array.isArray(context.tools) && context.tools.length > 0
				? context.tools
				: undefined;

	return {
		...(context as Record<string, unknown>),
		systemPrompt: finalSystemPrompt,
		tools: finalTools as Context["tools"],
		messages: nonSystemMessages as Context["messages"],
	};
}

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
		const adaptedContext = adaptTranscriptContext(context);
		if (!shouldUseFast?.(model)) {
			return streamSimple(model, adaptedContext, streamOptions);
		}
		return streamSimple(model, adaptedContext, {
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

function rewriteRelativeImports(source: string, originalDir: string): string {
	return source.replace(/from\s+"((?:\.\.?\/)[^"]+)"/g, (_full, relPath: string) => {
		const absolute = pathToFileURL(join(originalDir, relPath)).href;
		return `from ${JSON.stringify(absolute)}`;
	});
}

function patchWebSocketOnlyTransport(source: string): string {
	const sessionIdExpression = String.raw`(?:options\?\.sessionId|cacheSessionId)`;
	const retryVariables = /let retriedWebSocketConnectionLimit\s*=\s*false;/;
	const connectionLimitRetry =
		/if \(!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit\) \{\s*retriedWebSocketConnectionLimit = true;\s*continue;\s*\}/;
	const websocketFailureHandling = new RegExp(
		String.raw`if \(aborted \|\| \(isCodexNonTransportError\(error\) && !connectionLimitBeforeStart\)\) \{[\s\S]*?recordWebSocketFailure\((${sessionIdExpression}), error\);[\s\S]*?recordWebSocketSseFallback\(\1\);\s*break;`,
	);

	for (const pattern of [retryVariables, connectionLimitRetry, websocketFailureHandling]) {
		if (!pattern.test(source)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket transport patch");
		}
	}

	return source
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
			(_match, activeSessionId: string) => `if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
                            throw error;
                        }
                        if (!websocketStarted && websocketRetries < maxWebSocketRetries) {
                            websocketRetries++;
                            continue;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport,
                            fallbackTransport: websocketStarted ? undefined : "sse",
                            eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
                            requestBytes: new TextEncoder().encode(bodyJson).byteLength,
                        }));
                        recordWebSocketFailure(${activeSessionId}, error);
                        recordWebSocketSseFallback(${activeSessionId});
                        break;`,
		);
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
	const patched = rewriteRelativeImports(patchCodexSource(originalSource, providerIds), originalDir);

	const hash = createHash("sha1").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `openai-codex-responses-cpa-${hash}.mjs`);
	if (!existsSync(outPath)) {
		writeFileSync(outPath, patched, "utf8");
	}

	const mod = (await import(pathToFileURL(outPath).href)) as {
		streamSimple: CliproxyCodexStreamSimple;
		stream: CliproxyCodexStreamSimple;
	};

	if (typeof mod.streamSimple !== "function" || typeof mod.stream !== "function") {
		throw new Error("patched openai-codex-responses module missing streamSimple/stream exports");
	}

	const adaptedStreamSimple: CliproxyCodexStreamSimple = (model, context, streamOptions) => {
		return mod.streamSimple(model, adaptTranscriptContext(context), streamOptions);
	};
	const adaptedStream: CliproxyCodexStreamSimple = (model, context, streamOptions) => {
		return mod.stream(model, adaptTranscriptContext(context), streamOptions);
	};

	const streamSimple = wrapStreamSimpleForFast(adaptedStreamSimple, options.shouldUseFast);

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		stream: adaptedStream,
	};
}
