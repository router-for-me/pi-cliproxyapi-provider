import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPauseCommands } from "../extensions/index.ts";
import { loadConfigFile, resolvePauseDefault, saveConfigFile } from "../extensions/lib.ts";
import { PAUSE_POLL_INTERVAL_MS, PauseController, pauseController, waitForPauseToEnd } from "../extensions/pause.ts";
import tpsExtension from "../extensions/tps.ts";

const tempDirs: string[] = [];

afterEach(() => {
	pauseController.setEnabled(false);
	vi.useRealTimers();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-pause-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("PauseController", () => {
	it("excludes paused time from elapsed measurements", () => {
		const controller = new PauseController();
		controller.setEnabled(true, 1000);

		expect(controller.getElapsedMs(0, 0, 1500)).toBe(1000);

		controller.setEnabled(false, 1700);
		expect(controller.getElapsedMs(0, 0, 2000)).toBe(1300);
	});

	it("polls the config file until pause is cleared", async () => {
		vi.useFakeTimers();
		const agentDir = tempAgentDir();
		const controller = new PauseController();
		saveConfigFile(agentDir, { pause: true });

		const waiting = waitForPauseToEnd(agentDir, controller);
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		expect(controller.isEnabled()).toBe(true);

		saveConfigFile(agentDir, { pause: false });
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		await waiting;
		expect(controller.isEnabled()).toBe(false);
		expect(resolvePauseDefault(agentDir)).toBe(false);
	});

	it("keeps the current pause state when the config cannot be read", async () => {
		vi.useFakeTimers();
		const agentDir = tempAgentDir();
		const controller = new PauseController(true);
		writeFileSync(join(agentDir, "cliproxyapi.json"), "{", "utf8");

		const waiting = waitForPauseToEnd(agentDir, controller);
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		expect(controller.isEnabled()).toBe(true);

		writeFileSync(join(agentDir, "cliproxyapi.json"), '{"pause":false}\n', "utf8");
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		await waiting;
		expect(controller.isEnabled()).toBe(false);
	});
});

describe("pause commands", () => {
	it("sets and persists pause with /pause and /continue", async () => {
		const agentDir = tempAgentDir();
		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		const notify = vi.fn();
		const pi = {
			registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				commands.set(name, options);
			}),
		} as unknown as ExtensionAPI;
		const controller = new PauseController();
		registerPauseCommands({ pi, agentDir, pauseMode: controller });
		const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

		await commands.get("pause")?.handler("", ctx);
		expect(controller.isEnabled()).toBe(true);
		expect(loadConfigFile(agentDir)).toEqual({ pause: true });

		await commands.get("continue")?.handler("", ctx);
		expect(controller.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ pause: false });
		expect(notify).toHaveBeenNthCalledWith(1, "Requests are paused.", "info");
		expect(notify).toHaveBeenNthCalledWith(2, "Requests are continued.", "info");
	});
});

describe("Elapsed timer", () => {
	it("keeps the active request elapsed until it settles after pause", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		pauseController.setEnabled(false);

		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const setStatus = vi.fn();
		const notify = vi.fn();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				notify,
				setStatus,
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		tpsExtension(pi);
		await handlers.get("before_agent_start")?.({}, ctx);
		await vi.advanceTimersByTimeAsync(1000);
		pauseController.setEnabled(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(setStatus).toHaveBeenLastCalledWith("tps", "working 6s");

		await handlers.get("agent_settled")?.({}, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("tps", "last turn 6s");
		await vi.advanceTimersByTimeAsync(2000);
		expect(setStatus).toHaveBeenLastCalledWith("tps", "last turn 6s");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(", 6.0s"), "info");
	});

	it("ignores late agent events after session shutdown", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		pauseController.setEnabled(false);

		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const setStatus = vi.fn();
		const notify = vi.fn();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const ui = {
			notify,
			setStatus,
			theme: { fg: (_color: string, text: string) => text },
		};
		const activeCtx = { hasUI: true, mode: "tui", ui } as unknown as ExtensionContext;
		const shutdownCtx = { hasUI: true, mode: "tui", ui } as unknown as ExtensionContext;
		const staleCtx = new Proxy({} as ExtensionContext, {
			get() {
				throw new Error("stale context");
			},
		});

		tpsExtension(pi);
		await handlers.get("before_agent_start")?.({}, activeCtx);
		await handlers.get("session_shutdown")?.({}, shutdownCtx);

		expect(() => handlers.get("agent_end")?.({ messages: [] }, staleCtx)).not.toThrow();
		expect(() => handlers.get("agent_settled")?.({}, staleCtx)).not.toThrow();
		expect(setStatus).toHaveBeenLastCalledWith("tps", undefined);
	});
});
