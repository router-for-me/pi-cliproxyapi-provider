import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CliproxyCodexStreamSimple, CloseCodexWebSocketSessions } from "./codex-stream.ts";

export const PROACTIVE_COMPACTION_ERROR_PREFIX = "context_length_exceeded: proactive compaction threshold reached";

export interface ProactiveCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
}

export type { CloseCodexWebSocketSessions };

const DEFAULT_COMPACTION_ENABLED = true;
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;

interface CompatibleSettingsManager {
	reload?: () => Promise<void> | void;
	reloadFromDisk?: () => Promise<void> | void;
	getCompactionSettings?: () => { enabled?: unknown; reserveTokens?: unknown };
	get?: (key: string) => unknown;
}

function isCompatibleSettingsManager(value: unknown): value is CompatibleSettingsManager {
	return typeof value === "object" && value !== null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function normalizeCompactionSettings(enabled: unknown, reserveTokens: unknown): ProactiveCompactionSettings {
	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_COMPACTION_ENABLED,
		reserveTokens:
			typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens >= 0
				? reserveTokens
				: DEFAULT_COMPACTION_RESERVE_TOKENS,
	};
}

function readCompactionSettings(manager: CompatibleSettingsManager): ProactiveCompactionSettings | undefined {
	if (typeof manager.getCompactionSettings === "function") {
		try {
			const settings = manager.getCompactionSettings();
			return normalizeCompactionSettings(settings?.enabled, settings?.reserveTokens);
		} catch {
			// Fall through to OMP's key-based settings API when available.
		}
	}
	if (typeof manager.get === "function") {
		try {
			return normalizeCompactionSettings(manager.get("compaction.enabled"), manager.get("compaction.reserveTokens"));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function reloadSettings(manager: CompatibleSettingsManager): Promise<void> {
	if (typeof manager.reload === "function") {
		try {
			await manager.reload();
		} catch {
			// Keep the last successfully read settings when disk reload fails.
		}
		return;
	}
	if (typeof manager.reloadFromDisk === "function") {
		try {
			await manager.reloadFromDisk();
		} catch {
			// Keep the last successfully read settings when disk reload fails.
		}
	}
}

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
	private settingsManager: CompatibleSettingsManager | undefined;
	private cachedCompactionSettings: ProactiveCompactionSettings | undefined;
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
		pi.on("session_start", async (_event, ctx) => {
			this.cachedCompactionSettings = undefined;
			try {
				const created: unknown = SettingsManager.create(ctx.cwd, this.agentDir, {
					projectTrusted:
						typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true,
				});
				const manager = isPromiseLike(created) ? await created : created;
				this.settingsManager = isCompatibleSettingsManager(manager) ? manager : undefined;
				this.cachedCompactionSettings = this.settingsManager
					? readCompactionSettings(this.settingsManager)
					: undefined;
			} catch {
				this.settingsManager = undefined;
			}
			this.pending = undefined;
		});

		pi.on("session_shutdown", () => {
			this.settingsManager = undefined;
			this.cachedCompactionSettings = undefined;
			this.pending = undefined;
		});

		pi.on("session_before_compact", () => {
			// Compaction summaries use the same provider stream. Clear the synthetic
			// overflow before pi invokes the summarizer so it cannot abort compaction.
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
			await reloadSettings(settingsManager);
			const refreshedSettings = readCompactionSettings(settingsManager);
			if (refreshedSettings) {
				this.cachedCompactionSettings = refreshedSettings;
			}
			const settings = refreshedSettings ?? this.cachedCompactionSettings;
			if (!settings) {
				return;
			}
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
		const current = this.settingsManager ? readCompactionSettings(this.settingsManager) : undefined;
		if (current) {
			this.cachedCompactionSettings = current;
		}
		return current ?? this.cachedCompactionSettings;
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
