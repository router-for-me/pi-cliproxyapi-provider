import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CliproxyCodexStreamSimple } from "./codex-stream.ts";

export const PROACTIVE_COMPACTION_ERROR_PREFIX = "context_length_exceeded: proactive compaction threshold reached";

export interface ProactiveCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
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

	constructor(
		private readonly agentDir: string,
		private readonly providerId: string,
	) {}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => {
			this.settingsManager = SettingsManager.create(ctx.cwd, this.agentDir, {
				projectTrusted:
					typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true,
			});
			this.pending = undefined;
		});

		pi.on("session_shutdown", () => {
			this.settingsManager = undefined;
			this.pending = undefined;
		});

		pi.on("session_before_compact", () => {
			// Compaction summaries use the same provider stream. Clear the synthetic
			// overflow before pi invokes the summarizer so it cannot abort compaction.
			this.pending = undefined;
		});

		pi.on("session_compact", () => {
			this.pending = undefined;
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
			return createProactiveCompactionStream(model, pending.contextTokens, pending.threshold);
		};
	}

	private modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
		return `${model.provider}/${model.id}`;
	}
}
