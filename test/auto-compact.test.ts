import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROACTIVE_COMPACTION_ERROR_PREFIX,
	ProactiveCompactionController,
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
		vi.restoreAllMocks();
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
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi");
		controller.register(pi);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const ctx = {
			cwd,
			model,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({}, ctx);

		const baseResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = () => baseResult;
		const wrapped = controller.wrapStreamSimple(baseStream);
		return { ctx, handlers, model, wrapped, baseResult, settingsPath };
	}

	it("injects one overflow before the next provider request", async () => {
		const { ctx, handlers, model, wrapped, baseResult } = setup();
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		const proactiveStream = wrapped(model, { messages: [] });
		const error = await proactiveStream.result();
		expect(error.stopReason).toBe("error");
		expect(error.errorMessage).toBe(`${PROACTIVE_COMPACTION_ERROR_PREFIX} (${THRESHOLD + 1} > ${THRESHOLD})`);
		expect(isContextOverflow(error, CONTEXT_WINDOW)).toBe(true);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});

	it("does not inject the pending overflow into compaction summarization", async () => {
		const { ctx, handlers, model, wrapped, baseResult } = setup();
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		await handlers.get("session_before_compact")?.({}, ctx);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
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

	it("supports OMP settings managers returned asynchronously", async () => {
		const manager = {
			get(key: string) {
				return key === "compaction.enabled"
					? true
					: key === "compaction.reserveTokens"
						? RESERVE_TOKENS
						: undefined;
			},
			reloadFromDisk: vi.fn(async () => undefined),
		};
		vi.spyOn(SettingsManager, "create").mockReturnValue(Promise.resolve(manager) as unknown as SettingsManager);

		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-omp-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-omp-cwd-"));
		tempDirs.push(agentDir, cwd);
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi");
		controller.register(pi);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const ctx = {
			cwd,
			model,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;
		const baseResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = () => baseResult;
		const wrapped = controller.wrapStreamSimple(baseStream);

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		expect(manager.reloadFromDisk).toHaveBeenCalledOnce();
		const proactiveStream = wrapped(model, { messages: [] });
		const error = await proactiveStream.result();
		expect(error.stopReason).toBe("error");
	});

	it("uses the last valid OMP settings when reload and read fail", async () => {
		let fail = false;
		const manager = {
			get(key: string) {
				if (fail) throw new Error("settings read failed");
				return key === "compaction.enabled"
					? true
					: key === "compaction.reserveTokens"
						? RESERVE_TOKENS
						: undefined;
			},
			async reloadFromDisk() {
				if (fail) throw new Error("settings reload failed");
			},
		};
		vi.spyOn(SettingsManager, "create").mockReturnValue(Promise.resolve(manager) as unknown as SettingsManager);

		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-omp-failure-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-omp-failure-cwd-"));
		tempDirs.push(agentDir, cwd);
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi");
		controller.register(pi);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const ctx = {
			cwd,
			model,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;
		const baseStream: CliproxyCodexStreamSimple = () => ({}) as ReturnType<CliproxyCodexStreamSimple>;
		const wrapped = controller.wrapStreamSimple(baseStream);

		await handlers.get("session_start")?.({}, ctx);
		expect(controller.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: RESERVE_TOKENS,
		});
		fail = true;

		await expect(
			handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx),
		).resolves.toBeUndefined();
		expect(controller.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: RESERVE_TOKENS,
		});
		expect((await wrapped(model, { messages: [] }).result()).stopReason).toBe("error");
	});

	it("does not schedule compaction when settings manager creation fails", async () => {
		vi.spyOn(SettingsManager, "create").mockImplementation(() => {
			throw new Error("settings unavailable");
		});

		const { ctx, handlers, model, wrapped, baseResult } = setup();
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});
});
