import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CliproxyCodexStreamSimple, CloseCodexWebSocketSessions } from "./codex-stream.ts";

export const PROACTIVE_COMPACTION_ERROR_PREFIX = "context_length_exceeded: proactive compaction threshold reached";

export interface ProactiveCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
}

export type { CloseCodexWebSocketSessions };

/** Session id used to key pi-ai's reused Codex WebSocket. */
export function resolveCompactionSessionId(source?: {
	sessionId?: unknown;
	sessionManager?: { getSessionId?: () => unknown };
}): string | undefined {
	const fromManager = source?.sessionManager?.getSessionId?.();
	if (typeof fromManager === "string" && fromManager.trim()) {
		return fromManager;
	}
	if (typeof source?.sessionId === "string" && source.sessionId.trim()) {
		return source.sessionId;
	}
	return undefined;
}

export function shouldScheduleProactiveCompaction(
	message: AssistantMessage,
	contextTokens: number,
	contextWindow: number,
	settings: ProactiveCompactionSettings,
): boolean {
	if (!settings.enabled || message.stopReason !== "toolUse") {
		return false;
	}
	if (!message.content.some((block) => block.type === "toolCall")) {
		return false;
	}
	if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
		return false;
	}
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return false;
	}
	if (!Number.isFinite(settings.reserveTokens) || settings.reserveTokens < 0) {
		return false;
	}

	return contextTokens > contextWindow - settings.reserveTokens;
}

export function createProactiveCompactionStream(model: Model<Api>, contextTokens: number, threshold: number) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `${PROACTIVE_COMPACTION_ERROR_PREFIX} (${contextTokens} > ${threshold})`,
		timestamp: Date.now(),
	};

	queueMicrotask(() => {
		stream.push({ type: "start", partial: output });
		stream.push({ type: "error", reason: "error", error: output });
		stream.end();
	});

	return stream;
}

export class ProactiveCompactionController {
	private settingsManager: SettingsManager | undefined;
	private pending: { modelKey: string; contextTokens: number; threshold: number } | undefined;
	private closeWebSocketSessions: CloseCodexWebSocketSessions | undefined;

	constructor(
		private readonly agentDir: string,
		private readonly providerId: string,
		closeWebSocketSessions?: CloseCodexWebSocketSessions,
	) {
		this.closeWebSocketSessions = closeWebSocketSessions;
	}

	setCloseWebSocketSessions(closeWebSocketSessions: CloseCodexWebSocketSessions): void {
		this.closeWebSocketSessions = closeWebSocketSessions;
	}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => {
			this.settingsManager = SettingsManager.create(ctx.cwd, this.agentDir, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			this.pending = undefined;
		});

		pi.on("session_shutdown", () => {
			this.settingsManager = undefined;
			this.pending = undefined;
		});

		pi.on("session_compact", (_event, ctx) => {
			this.pending = undefined;
			// CLIProxyAPI binds server-side Codex context to the WebSocket. Compaction
			// only rewrites the client message list, so reuse would keep cacheRead high
			// and retrigger proactive compaction on a now-small session.
			this.resetWebSocketSession(resolveCompactionSessionId(ctx));
		});

		pi.on("agent_settled", () => {
			this.pending = undefined;
		});

		pi.on("turn_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== this.providerId) {
				return;
			}
			if (!ctx.model || ctx.model.provider !== this.providerId || ctx.model.id !== message.model) {
				return;
			}

			const settingsManager = this.settingsManager;
			if (!settingsManager) {
				return;
			}
			await settingsManager.reload();
			const settings = settingsManager.getCompactionSettings();
			const contextTokens = ctx.getContextUsage()?.tokens;
			if (contextTokens === null || contextTokens === undefined) {
				return;
			}
			if (!shouldScheduleProactiveCompaction(message, contextTokens, ctx.model.contextWindow, settings)) {
				return;
			}

			this.pending = {
				modelKey: this.modelKey(ctx.model),
				contextTokens,
				threshold: ctx.model.contextWindow - settings.reserveTokens,
			};
		});
	}

	getCompactionSettings(): ProactiveCompactionSettings | undefined {
		return this.settingsManager?.getCompactionSettings();
	}

	wrapStreamSimple(streamSimple: CliproxyCodexStreamSimple): CliproxyCodexStreamSimple {
		return (model, context, options) => {
			const pending = this.pending;
			if (!pending || pending.modelKey !== this.modelKey(model)) {
				return streamSimple(model, context, options);
			}

			this.pending = undefined;
			this.resetWebSocketSession(options?.sessionId);
			return createProactiveCompactionStream(model, pending.contextTokens, pending.threshold);
		};
	}

	private resetWebSocketSession(sessionId?: string): void {
		if (!sessionId || !this.closeWebSocketSessions) {
			return;
		}
		try {
			this.closeWebSocketSessions(sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[pi-cliproxyapi-provider] failed to close Codex WebSocket for session ${sessionId}: ${message}`);
		}
	}

	private modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
		return `${model.provider}/${model.id}`;
	}
}
