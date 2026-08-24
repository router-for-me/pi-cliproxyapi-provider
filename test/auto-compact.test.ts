import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROACTIVE_COMPACTION_ERROR_PREFIX,
	ProactiveCompactionController,
	resolveCompactionSessionId,
	shouldScheduleProactiveCompaction,
} from "../extensions/auto-compact.ts";
import type { CliproxyCodexStreamSimple } from "../extensions/codex-stream.ts";

const CONTEXT_WINDOW = 372000;
const RESERVE_TOKENS = 65536;
const THRESHOLD = CONTEXT_WINDOW - RESERVE_TOKENS;

function assistantMessage(
	totalTokens: number,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }]
				: [{ type: "text", text: "done" }],
		api: "openai-codex-responses",
		provider: "cliproxyapi",
		model: "gpt-5.6-sol",
		usage: {
			input: 100,
			output: 20,
			cacheRead: Math.max(0, totalTokens - 120),
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("proactive compaction threshold", () => {
	it("schedules an over-threshold tool turn", () => {
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD + 1), THRESHOLD + 1, CONTEXT_WINDOW, {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(true);
	});

	it("uses the same strict threshold as pi", () => {
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD), THRESHOLD, CONTEXT_WINDOW, {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(false);
	});

	it("does not interrupt completed responses or disabled compaction", () => {
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD + 1, "stop"), THRESHOLD + 1, CONTEXT_WINDOW, {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(false);
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD + 1), THRESHOLD + 1, CONTEXT_WINDOW, {
				enabled: false,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(false);
	});
});

describe("proactive compaction controller", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function setup(enabled = true) {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-auto-compact-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-auto-compact-cwd-"));
		tempDirs.push(agentDir, cwd);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, `${JSON.stringify({ compaction: { enabled, reserveTokens: RESERVE_TOKENS } })}\n`);

		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const closeWebSocketSessions = vi.fn();
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi", closeWebSocketSessions);
		controller.register(pi);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const sessionId = "session-compact-1";
		const ctx = {
			cwd,
			model,
			sessionId,
			sessionManager: { getSessionId: () => sessionId },
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({}, ctx);

		const baseResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = () => baseResult;
		const wrapped = controller.wrapStreamSimple(baseStream);
		return { ctx, handlers, model, wrapped, baseResult, settingsPath, closeWebSocketSessions, sessionId, controller };
	}

	it("injects one overflow before the next provider request", async () => {
		const { ctx, handlers, model, wrapped, baseResult, closeWebSocketSessions, sessionId } = setup();
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		const proactiveStream = wrapped(model, { messages: [] }, { sessionId });
		const error = await proactiveStream.result();
		expect(error.stopReason).toBe("error");
		expect(error.errorMessage).toBe(`${PROACTIVE_COMPACTION_ERROR_PREFIX} (${THRESHOLD + 1} > ${THRESHOLD})`);
		expect(isContextOverflow(error, CONTEXT_WINDOW)).toBe(true);
		expect(closeWebSocketSessions).toHaveBeenCalledWith(sessionId);
		expect(wrapped(model, { messages: [] }, { sessionId })).toBe(baseResult);
		expect(closeWebSocketSessions).toHaveBeenCalledTimes(1);
	});

	it("closes the reused Codex WebSocket after compaction", async () => {
		const { ctx, handlers, model, wrapped, baseResult, closeWebSocketSessions, sessionId } = setup();
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);
		handlers.get("session_compact")?.({ reason: "overflow", willRetry: true }, ctx);
		expect(closeWebSocketSessions).toHaveBeenCalledTimes(1);
		expect(closeWebSocketSessions).toHaveBeenCalledWith(sessionId);
		// Compaction replaces the client context; do not inject another overflow
		// against the still-large server cacheRead from the previous socket.
		expect(wrapped(model, { messages: [] }, { sessionId })).toBe(baseResult);
		expect(closeWebSocketSessions).toHaveBeenCalledTimes(1);
	});

	it("does not close a WebSocket when the session id is missing", () => {
		const { handlers, closeWebSocketSessions } = setup();
		handlers.get("session_compact")?.({ reason: "manual" }, {
			sessionManager: { getSessionId: () => "" },
		} as unknown as ExtensionContext);
		expect(closeWebSocketSessions).not.toHaveBeenCalled();
	});

	it("keeps compaction working if WebSocket close throws", () => {
		const { ctx, handlers, sessionId, controller } = setup();
		const closeWebSocketSessions = vi.fn(() => {
			throw new Error("socket already gone");
		});
		controller.setCloseWebSocketSessions(closeWebSocketSessions);
		expect(() => handlers.get("session_compact")?.({}, ctx)).not.toThrow();
		expect(closeWebSocketSessions).toHaveBeenCalledWith(sessionId);
	});

	it("reloads settings before scheduling", async () => {
		const { ctx, handlers, model, wrapped, baseResult, settingsPath } = setup();
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ compaction: { enabled: false, reserveTokens: RESERVE_TOKENS } })}\n`,
		);

		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});

	it("ignores other providers", async () => {
		const { ctx, handlers, model, wrapped, baseResult } = setup();
		const message = { ...assistantMessage(THRESHOLD + 1), provider: "other" };

		await handlers.get("turn_end")?.({ message, toolResults: [{}] }, ctx);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});
});

describe("resolveCompactionSessionId", () => {
	it("prefers sessionManager.getSessionId over a stale sessionId field", () => {
		expect(
			resolveCompactionSessionId({
				sessionId: "stale",
				sessionManager: { getSessionId: () => "current" },
			}),
		).toBe("current");
	});

	it("falls back to sessionId when sessionManager is unavailable", () => {
		expect(resolveCompactionSessionId({ sessionId: "fallback" })).toBe("fallback");
		expect(resolveCompactionSessionId({})).toBeUndefined();
	});
});
