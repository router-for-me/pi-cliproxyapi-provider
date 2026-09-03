import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pauseController } from "./pause.ts";
import { formatGatewayTokensPerSecond, wrapFetchCaptureTokensPerSecond } from "./gateway-telemetry.ts";

const STATUS_KEY = "tps";
const REFRESH_INTERVAL_MS = 1000;

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

/**
 * Only the interactive parent TUI session owns the footer timer / TPS summary.
 * Subagent sessions load global extensions too, but run in print mode with a
 * no-op UI. Guard on both hasUI and mode so a shared UI binding can never let
 * a child clear the parent footer or emit a TPS toast.
 */
function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

export default function (pi: ExtensionAPI) {
	let requestStartMs: number | null = null;
	let pausedDurationAtStartMs = 0;
	let pauseWasEnabledAtStart = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let statusCtx: ExtensionContext | null = null;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let capturedTokensPerSecond: number | undefined;
	let restoreFetch: (() => void) | undefined;

	function clearRefreshTimer(): void {
		if (refreshTimer === undefined) return;
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function getElapsedMs(now = Date.now()): number {
		if (requestStartMs === null) return 0;

		// A pause issued during an active run only gates the next provider request.
		// Keep the current run's elapsed time moving until it settles; a pause that
		// was already active when the run started still excludes its waiting time.
		if (!pauseWasEnabledAtStart) {
			return Math.max(0, now - requestStartMs);
		}
		return pauseController.getElapsedMs(requestStartMs, pausedDurationAtStartMs, now);
	}

	function getElapsedSeconds(): number {
		return Math.floor(getElapsedMs() / 1000);
	}

	function formatElapsed(totalSeconds: number): string {
		const safeSeconds = Math.max(0, Math.floor(totalSeconds));
		const days = Math.floor(safeSeconds / 86400);
		const hours = Math.floor((safeSeconds % 86400) / 3600);
		const minutes = Math.floor((safeSeconds % 3600) / 60);
		const seconds = safeSeconds % 60;

		const units: Array<{ value: number; suffix: string }> = [
			{ value: days, suffix: "d" },
			{ value: hours, suffix: "h" },
			{ value: minutes, suffix: "m" },
			{ value: seconds, suffix: "s" },
		];

		// Skip leading zero units; always keep at least seconds.
		const parts: string[] = [];
		let started = false;
		for (let i = 0; i < units.length; i++) {
			const unit = units[i]!;
			if (!started) {
				if (unit.value === 0 && i < units.length - 1) continue;
				started = true;
			}
			parts.push(`${unit.value}${unit.suffix}`);
		}
		return parts.join(" ");
	}

	function setElapsedStatus(ctx: ExtensionContext, totalSeconds: number): void {
		if (!isPrimaryUiSession(ctx)) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Elapsed ${formatElapsed(totalSeconds)}`));
	}

	function refreshStatus(): void {
		if (requestStartMs === null || !statusCtx) return;
		setElapsedStatus(statusCtx, getElapsedSeconds());
	}

	function clearStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? statusCtx;
		if (!target || !isPrimaryUiSession(target)) return;
		target.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("before_agent_start", (_event, ctx) => {
		// Subagents / print sessions must not own the footer timer.
		if (!isPrimaryUiSession(ctx)) return;

		// Keep the same timer across retries / tool continuations within one run.
		if (requestStartMs !== null) {
			statusCtx = ctx;
			return;
		}

		const startMs = Date.now();
		requestStartMs = startMs;
		pauseWasEnabledAtStart = pauseController.isEnabled();
		pausedDurationAtStartMs = pauseController.getPausedDurationMs(startMs);
		statusCtx = ctx;
		input = 0;
		output = 0;
		cacheRead = 0;
		cacheWrite = 0;
		totalTokens = 0;
		capturedTokensPerSecond = undefined;
		if (!restoreFetch) {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = wrapFetchCaptureTokensPerSecond((input, init) => {
				return originalFetch.call(globalThis, input, init);
			}, (tpsValue) => {
				capturedTokensPerSecond = tpsValue;
			});
			restoreFetch = () => {
				globalThis.fetch = originalFetch;
			};
		}
		refreshStatus();

		clearRefreshTimer();
		refreshTimer = setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
	});

	pi.on("agent_end", (event, ctx) => {
		if (requestStartMs === null) return;
		// Ignore usage from subagent / non-TUI sessions.
		if (!isPrimaryUiSession(ctx)) return;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (requestStartMs === null) return;
		// Subagents must never clear the parent elapsed status or notify TPS.
		if (!isPrimaryUiSession(ctx)) return;

		const elapsedMs = getElapsedMs();
		const elapsedSecondsExact = elapsedMs / 1000;
		const elapsedSecondsFloor = Math.floor(elapsedSecondsExact);

		requestStartMs = null;
		clearRefreshTimer();

		// Keep the final total time in the footer after the run settles.
		setElapsedStatus(ctx, elapsedSecondsFloor);
		statusCtx = ctx;

		const tps = formatGatewayTokensPerSecond(capturedTokensPerSecond);
		restoreFetch?.();
		restoreFetch = undefined;
		if (elapsedMs <= 0) return;
		const message = `TPS ${tps} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSecondsExact.toFixed(1)}s`;
		ctx.ui.notify(message, "info");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearRefreshTimer();
		clearStatus(ctx);
		requestStartMs = null;
		pausedDurationAtStartMs = 0;
		pauseWasEnabledAtStart = false;
		statusCtx = null;
		restoreFetch?.();
		restoreFetch = undefined;
		capturedTokensPerSecond = undefined;
	});
}
