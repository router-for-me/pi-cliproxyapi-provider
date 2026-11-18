import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastModeController, type FastPreference } from "../extensions/fast.ts";
import { registerFastCommands } from "../extensions/index.ts";
import { loadConfigFile, resolveFastDefault, saveConfigFile } from "../extensions/lib.ts";

function createCommandHarness(
	fastMode: FastModeController,
	currentModel: Model<Api>,
	agentDir: string,
	onModeChange?: (ctx: ExtensionContext) => Promise<void>,
) {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const onStatusChange = vi.fn();
	const notify = vi.fn();
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
	} as unknown as ExtensionAPI;

	registerFastCommands({ pi, agentDir, providerId: "cliproxyapi", fastMode, onStatusChange, onModeChange });

	const ctx = {
		model: currentModel,
		ui: { notify },
	} as unknown as ExtensionCommandContext;

	return {
		command: (name = "fast") => {
			const command = commands.get(name);
			if (!command) throw new Error(`/${name} was not registered`);
			return command;
		},
		ctx,
		notify,
		onStatusChange,
	};
}

const supportedModel = {
	id: "gpt-5.6-sol",
	provider: "cliproxyapi",
} as Model<Api>;

const tempPaths: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fast-command-test-"));
	tempPaths.push(dir);
	return dir;
}

afterEach(() => {
	while (tempPaths.length > 0) {
		const path = tempPaths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

describe("speed commands", () => {
	it("toggles Fast and persists the preference in the global config", async () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { baseUrl: "http://localhost:8317" });
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command().handler("", harness.ctx);
		expect(fastMode.isEnabled()).toBe(true);
		expect(loadConfigFile(agentDir)).toEqual({ baseUrl: "http://localhost:8317", fast: true });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(1);
		expect(harness.notify).not.toHaveBeenCalled();

		await harness.command().handler("", harness.ctx);
		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ baseUrl: "http://localhost:8317", fast: false });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(2);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("switches directly between Fast and Ultra Fast and turns the active mode off", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		for (const [name, preference] of [
			["fast", true],
			["ultrafast", "ultrafast"],
			["fast", true],
			["ultrafast", "ultrafast"],
			["ultrafast", false],
		] as const) {
			await harness.command(name).handler("", harness.ctx);
			expect(loadConfigFile(agentDir)).toEqual({ fast: preference });
			expect(fastMode.getPreference()).toBe(preference);
		}
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it.each([
		["fast", true],
		["ultrafast", "ultrafast"],
	] as const)("restores /%s only for supported models after restart", async (name, preference) => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command(name).handler("", harness.ctx);

		const previousFastEnv = process.env.CLIPROXYAPI_FAST;
		try {
			delete process.env.CLIPROXYAPI_FAST;
			const restoredPreference = resolveFastDefault(agentDir);
			expect(restoredPreference).toBe(preference);
			const restartedMode = new FastModeController(restoredPreference);
			restartedMode.setSupportedModelIds([supportedModel.id]);
			expect(restartedMode.getServiceTierFor(supportedModel.id)).toBe(preference === true ? "priority" : preference);
			expect(restartedMode.getServiceTierFor("unsupported-model")).toBeUndefined();
		} finally {
			if (previousFastEnv === undefined) {
				delete process.env.CLIPROXYAPI_FAST;
			} else {
				process.env.CLIPROXYAPI_FAST = previousFastEnv;
			}
		}
	});

	it.each(["fast", "ultrafast"])("rejects arguments to /%s", async (name) => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command(name).handler("on", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({});
		expect(harness.notify).toHaveBeenCalledWith(`Usage: /${name}`, "error");
	});

	it.each([
		["fast", "Fast", true],
		["ultrafast", "Ultra Fast", "ultrafast"],
	] as const)("updates /%s globally while keeping it ineffective for an unsupported model", async (name, label, preference) => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command(name).handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(true);
		expect(fastMode.getServiceTierFor(supportedModel.id)).toBeUndefined();
		expect(loadConfigFile(agentDir)).toEqual({ fast: preference });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenLastCalledWith(
			`${label} mode is enabled globally, but the current model does not support it.`,
			"warning",
		);

		await harness.command(name).handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ fast: false });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(2);
		expect(harness.notify).toHaveBeenLastCalledWith(`${label} mode is disabled globally.`, "info");
	});

	it("shares the pricing refresh lock between /fast and /ultrafast", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		let finishRefresh: (() => void) | undefined;
		const pendingRefresh = new Promise<void>((resolve) => {
			finishRefresh = resolve;
		});
		const onModeChange = vi.fn(async () => {}).mockReturnValueOnce(pendingRefresh);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir, onModeChange);

		const firstToggle = harness.command("ultrafast").handler("", harness.ctx);
		try {
			await vi.waitFor(() => expect(onModeChange).toHaveBeenCalledTimes(1));
			await harness.command("fast").handler("", harness.ctx);

			expect(loadConfigFile(agentDir)).toEqual({ fast: "ultrafast" });
			expect(onModeChange).toHaveBeenCalledTimes(1);
			expect(harness.notify).toHaveBeenCalledWith(
				"Fast mode is already being refreshed. Try again when it finishes.",
				"warning",
			);
		} finally {
			finishRefresh?.();
			await firstToggle;
		}
	});

	it("restores state, config, and pricing metadata when refresh fails", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const refreshPreferences: FastPreference[] = [];
		const onModeChange = async () => {
			const preference = fastMode.getPreference();
			refreshPreferences.push(preference);
			if (preference === true) throw new Error("refresh failed");
		};
		const harness = createCommandHarness(fastMode, supportedModel, agentDir, onModeChange);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toStrictEqual({});
		expect(refreshPreferences).toEqual([true, false]);
		expect(harness.notify).toHaveBeenCalledWith("Failed to refresh model pricing: refresh failed", "warning");
	});

	it("rolls back to Ultra Fast when switching to Fast fails to refresh pricing", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const refreshPreferences: FastPreference[] = [];
		const onModeChange = async () => {
			const preference = fastMode.getPreference();
			refreshPreferences.push(preference);
			if (preference === true) throw new Error("refresh failed");
		};
		const harness = createCommandHarness(fastMode, supportedModel, agentDir, onModeChange);
		await harness.command("ultrafast").handler("", harness.ctx);

		await harness.command("fast").handler("", harness.ctx);

		expect(loadConfigFile(agentDir)).toEqual({ fast: "ultrafast" });
		expect(fastMode.getServiceTierFor(supportedModel.id)).toBe("ultrafast");
		expect(refreshPreferences).toEqual(["ultrafast", true, "ultrafast"]);
		expect(harness.notify).toHaveBeenCalledWith("Failed to refresh model pricing: refresh failed", "warning");
		await harness.command("ultrafast").handler("", harness.ctx);
		expect(loadConfigFile(agentDir)).toEqual({ fast: false });
	});

	it("preserves the saved Ultra Fast preference on rollback when startup forced Fast", async () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { fast: "ultrafast" });
		const fastMode = new FastModeController(true);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir, async () => {
			if (fastMode.getPreference() === "ultrafast") throw new Error("refresh failed");
		});

		await harness.command("ultrafast").handler("", harness.ctx);

		expect(fastMode.getServiceTierFor(supportedModel.id)).toBe("priority");
		expect(loadConfigFile(agentDir)).toEqual({ fast: "ultrafast" });
		expect(harness.notify).toHaveBeenCalledWith("Failed to refresh model pricing: refresh failed", "warning");
	});

	it("does not persist a startup override when a switch to Ultra Fast fails", async () => {
		const agentDir = tempAgentDir();
		const config = { baseUrl: "http://localhost:8317", pause: true };
		saveConfigFile(agentDir, config);

		vi.stubEnv("CLIPROXYAPI_FAST", "on");
		try {
			const fastMode = new FastModeController(resolveFastDefault(agentDir));
			fastMode.setSupportedModelIds([supportedModel.id]);
			expect(fastMode.getServiceTierFor(supportedModel.id)).toBe("priority");
			const harness = createCommandHarness(fastMode, supportedModel, agentDir, async () => {
				if (fastMode.getPreference() === "ultrafast") throw new Error("refresh failed");
			});

			await harness.command("ultrafast").handler("", harness.ctx);

			expect(harness.notify).toHaveBeenCalledWith("Failed to refresh model pricing: refresh failed", "warning");
			expect(fastMode.getServiceTierFor(supportedModel.id)).toBe("priority");
			expect(loadConfigFile(agentDir)).toStrictEqual(config);
			vi.stubEnv("CLIPROXYAPI_FAST", undefined);
			expect(resolveFastDefault(agentDir)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not change in-memory state when the global config cannot be written", async () => {
		const agentDir = tempAgentDir();
		const invalidAgentDir = join(agentDir, "not-a-directory");
		writeFileSync(invalidAgentDir, "file", "utf8");
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, invalidAgentDir);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(harness.onStatusChange).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Fast mode:"), "error");
	});
});
