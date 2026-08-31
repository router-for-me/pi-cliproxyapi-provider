import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	applyFastPayloadHook,
	type CliproxyCodexStreamSimple,
	patchCodexSource,
	resolveCodexModuleFromNodeEntry,
	withPriorityServiceTier,
	wrapCliproxyCodexStream,
} from "../extensions/codex-stream.ts";
import { FastModeController } from "../extensions/fast.ts";
import { FastFooterController, formatFastModelStatus } from "../extensions/fast-footer.ts";
import { loadMappedModels } from "../extensions/lib.ts";
import { PauseController } from "../extensions/pause.ts";

const model = {
	id: "gpt-5.4",
	provider: "cliproxyapi",
} as Model<Api>;

describe("Codex protocol module resolution", () => {
	it("finds pi-ai nested beneath pi's bundled Node package", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cliproxyapi-codex-resolution-test-")));
		const cliEntry = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		const codexModule = join(
			root,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);

		try {
			mkdirSync(dirname(cliEntry), { recursive: true });
			mkdirSync(dirname(codexModule), { recursive: true });
			writeFileSync(cliEntry, "", "utf8");
			writeFileSync(codexModule, "", "utf8");

			expect(resolveCodexModuleFromNodeEntry(cliEntry)).toBe(codexModule);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Codex WebSocket transport patch", () => {
	it("reconnects WebSocket instead of falling back to SSE", () => {
		const source = readFileSync(
			new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", import.meta.url),
			"utf8",
		);
		const patched = patchCodexSource(source, ["cliproxyapi"]);

		expect(patched).toContain("const websocketDisabledForSession = false;");
		expect(patched).toContain("let websocketRetries = 0;");
		expect(patched).toContain("const connectionLimitBeforeStart = !websocketStarted");
		expect(patched).toContain("isCodexNonTransportError(error) && !connectionLimitBeforeStart");
		expect(patched).toContain("const previousResponseNotFound = isPreviousResponseNotFoundError(error);");
		expect(patched).toContain("recordWebSocketFailure(cacheSessionId, error);");
		expect(patched).toContain("const maxWebSocketRetries = Number.isFinite(options?.maxRetries)");
		expect(patched).toContain("? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)");
		expect(patched).toContain(": 3;");
		expect(patched).not.toContain('fallbackTransport: websocketStarted ? undefined : "sse",');
		expect(patched).not.toContain("websocketSseFallbackSessions.add(sessionId);");
		expect(patched).not.toMatch(/recordWebSocketSseFallback\([^)]*\);\s*break;/);
	});
});

describe("FastModeController", () => {
	it("combines the global preference with model capability", () => {
		const mode = new FastModeController(false);
		mode.setSupportedModelIds(["gpt-5.4", " gpt-5.5 ", ""]);

		expect(mode.isEnabled()).toBe(false);
		expect(mode.isModelSupported("gpt-5.4")).toBe(true);
		expect(mode.isModelSupported("gpt-5.5")).toBe(true);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
		expect(mode.isEffectiveFor("custom-model")).toBe(false);

		mode.setEnabled(true);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(true);
		expect(mode.isEffectiveFor("custom-model")).toBe(false);

		mode.setEnabled(false);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
	});

	it("updates the global preference", () => {
		const mode = new FastModeController(false);

		mode.setEnabled(true);
		expect(mode.isEnabled()).toBe(true);
		mode.setEnabled(false);
		expect(mode.isEnabled()).toBe(false);
	});
});

describe("Fast footer model status", () => {
	it("appends Fast and paused labels at the right side of model status", () => {
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", true)).toBe("gpt-5.6-sol • xhigh • fast");
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", true, "fast", true)).toBe(
			"gpt-5.6-sol • xhigh • fast • paused",
		);
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", false)).toBe("gpt-5.6-sol • xhigh");
	});

	it("refreshes pi's built-in footer without replacing it", () => {
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([model.id]);
		const setFooter = vi.fn();
		const setStatus = vi.fn();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			model,
			ui: { setFooter, setStatus },
		} as unknown as ExtensionContext;
		const footer = new FastFooterController(model.provider, fastMode);
		footer.register(pi);

		handlers.get("session_start")?.({}, ctx);
		footer.refresh(ctx);

		expect(setFooter).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenCalledWith("cliproxyapi-fast-refresh", undefined);
		handlers.get("session_shutdown")?.({}, ctx);
	});

	it("patches and restores the built-in footer across session reloads", () => {
		const originalRender = FooterComponent.prototype.render;
		const displayModel = { id: model.id, provider: model.provider, reasoning: true, contextWindow: 372000 };
		const stubRender = function stubRender(this: FooterComponent, width: number): string[] {
			const session = (this as unknown as { session: { state: { model: typeof displayModel } } }).session;
			if (width < 0) throw new Error("render failed");
			return [`${session.state.model.id}|${session.state.model.reasoning}`];
		};
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([model.id]);
		fastMode.setEnabled(true);
		const pauseMode = new PauseController(false);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			ui: {
				theme: {
					fg: (color: string, text: string) => (color === "warning" ? `<yellow>${text}</yellow>` : text),
					getColorMode: () => "256color",
				},
			},
		} as unknown as ExtensionContext;
		const footer = new FastFooterController(model.provider, fastMode, () => undefined, pauseMode);
		const component = Object.create(FooterComponent.prototype) as FooterComponent;
		Object.defineProperty(component, "session", {
			value: { state: { model: displayModel, thinkingLevel: "xhigh" } },
		});

		try {
			FooterComponent.prototype.render = stubRender;
			footer.register(pi);
			handlers.get("session_start")?.({}, ctx);

			expect(component.render(80)).toEqual(["gpt-5.4 • xhigh • <yellow>fast</yellow>|false"]);
			expect(displayModel).toEqual({
				id: "gpt-5.4",
				provider: "cliproxyapi",
				reasoning: true,
				contextWindow: 372000,
			});

			const orangePaused = "\x1b[38;5;214mpaused\x1b[39m";
			pauseMode.setEnabled(true);
			expect(component.render(80)).toEqual([`gpt-5.4 • xhigh • <yellow>fast</yellow> • ${orangePaused}|false`]);
			pauseMode.setEnabled(false);
			fastMode.setEnabled(false);
			expect(component.render(80)).toEqual(["gpt-5.4|true"]);

			pauseMode.setEnabled(true);
			expect(component.render(80)).toEqual([`gpt-5.4 • xhigh • ${orangePaused}|false`]);
			pauseMode.setEnabled(false);
			fastMode.setEnabled(true);
			fastMode.setSupportedModelIds([]);
			expect(component.render(80)).toEqual(["gpt-5.4|true"]);

			pauseMode.setEnabled(true);
			expect(component.render(80)).toEqual([`gpt-5.4 • xhigh • ${orangePaused}|false`]);
			pauseMode.setEnabled(false);
			fastMode.setSupportedModelIds([model.id]);

			expect(() => component.render(-1)).toThrow("render failed");
			expect(displayModel.contextWindow).toBe(372000);

			handlers.get("session_shutdown")?.({}, ctx);
			expect(FooterComponent.prototype.render).toBe(stubRender);

			handlers.get("session_start")?.({}, ctx);
			expect(component.render(80)).toEqual(["gpt-5.4 • xhigh • <yellow>fast</yellow>|false"]);
		} finally {
			handlers.get("session_shutdown")?.({}, ctx);
			FooterComponent.prototype.render = originalRender;
		}
	});

	it("uses the compaction threshold for the footer percentage and denominator", () => {
		const originalRender = FooterComponent.prototype.render;
		const displayModel = { id: model.id, provider: model.provider, reasoning: true, contextWindow: 372000 };
		const stubRender = function stubRender(this: FooterComponent): string[] {
			const session = (this as unknown as { session: { state: { model: typeof displayModel } } }).session;
			const contextWindow = session.state.model.contextWindow;
			return [`${((100000 / contextWindow) * 100).toFixed(1)}%/${Math.round(contextWindow / 1000)}k`];
		};
		const fastMode = new FastModeController(false);
		const footer = new FastFooterController(model.provider, fastMode, () => ({
			enabled: true,
			reserveTokens: 65536,
		}));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const ctx = { mode: "tui" } as ExtensionContext;
		const component = Object.create(FooterComponent.prototype) as FooterComponent;
		Object.defineProperty(component, "session", { value: { state: { model: displayModel } } });
		Object.defineProperty(component, "autoCompactEnabled", { value: true, writable: true });

		try {
			FooterComponent.prototype.render = stubRender;
			footer.register(pi);
			handlers.get("session_start")?.({}, ctx);

			expect(component.render(80)).toEqual(["32.6%/306k"]);
			expect(displayModel.contextWindow).toBe(372000);

			(component as unknown as { autoCompactEnabled: boolean }).autoCompactEnabled = false;
			expect(component.render(80)).toEqual(["26.9%/372k"]);
		} finally {
			handlers.get("session_shutdown")?.({}, ctx);
			FooterComponent.prototype.render = originalRender;
		}
	});
});

describe("Fast catalog mapping", () => {
	it("returns the model ids that advertise Fast", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{ slug: "gpt-5.4", service_tiers: [{ id: "priority", name: "Fast" }] },
						{ slug: "gpt-5.5", service_tiers: [{ id: "flex" }] },
						{ slug: "speed-tier-only", additional_speed_tiers: ["fast"] },
						{ slug: "custom-model", service_tiers: [] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fast-test-"));
		try {
			const loaded = await loadMappedModels("http://127.0.0.1:8317", "test-key", false, agentDir);
			expect(loaded.fastModelIds).toEqual(["gpt-5.4", "gpt-5.5"]);
			expect(loaded.models.map((entry) => entry.id)).toEqual([
				"gpt-5.4",
				"gpt-5.5",
				"speed-tier-only",
				"custom-model",
			]);
			expect(fetchMock).toHaveBeenCalledWith(
				"http://127.0.0.1:8317/v1/models?client_version=pi",
				expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }),
			);
		} finally {
			fetchMock.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("Fast pricing mapping", () => {
	it("uses models.dev standard and experimental Fast prices when loading CPA models", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).startsWith("https://models.dev/")) {
				return new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-5.6-sol": {
									cost: {
										input: 5,
										output: 30,
										cache_read: 0.5,
										cache_write: 6.25,
									},
									experimental: {
										modes: {
											fast: { cost: { input: 10, output: 60, cache_read: 1, cache_write: 12.5 } },
										},
									},
								},
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					models: [{ slug: "gpt-5.6-sol", service_tiers: [{ id: "priority" }] }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fast-test-"));
		try {
			const standard = await loadMappedModels("http://127.0.0.1:8317", "test-key", false, agentDir);
			const fast = await loadMappedModels("http://127.0.0.1:8317", "test-key", true, agentDir);
			expect(standard.models[0]?.cost).toEqual({
				input: 5,
				output: 30,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			});
			expect(fast.models[0]?.cost).toEqual({
				input: 10,
				output: 60,
				cacheRead: 1,
				cacheWrite: 12.5,
			});
		} finally {
			fetchMock.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("Fast stream wrapper", () => {
	it("preserves options and payloads when Fast is not effective", async () => {
		let captured: SimpleStreamOptions | undefined;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = (_model, _context, options) => {
			captured = options;
			return streamResult;
		};
		const wrapped = wrapCliproxyCodexStream(baseStream, () => false);
		const options: SimpleStreamOptions = { timeoutMs: 1234 };

		expect(wrapped(model, { messages: [] }, options)).toBe(streamResult);
		expect(captured?.timeoutMs).toBe(1234);
		const payload = { model: "gpt-5.4", input: [] };
		expect(await captured?.onPayload?.(payload, model)).toBe(payload);
	});

	it("preserves stream options and composes the Fast payload hook when enabled", async () => {
		let captured: SimpleStreamOptions | undefined;
		let observed: unknown;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = (_model, _context, options) => {
			captured = options;
			return streamResult;
		};
		const wrapped = wrapCliproxyCodexStream(baseStream, () => true);
		const options: SimpleStreamOptions = {
			timeoutMs: 1234,
			onPayload: (payload) => {
				observed = payload;
				return undefined;
			},
		};

		expect(wrapped(model, { messages: [] }, options)).toBe(streamResult);
		expect(captured?.timeoutMs).toBe(1234);
		expect(captured).not.toBe(options);
		const shaped = await captured?.onPayload?.({ model: "gpt-5.4" }, model);
		expect(observed).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(shaped).toEqual({ model: "gpt-5.4", service_tier: "priority" });
	});
});

describe("Fast payload shaping", () => {
	it("adds priority without mutating the original payload", () => {
		const original = { model: "gpt-5.4", service_tier: "default" };
		const shaped = withPriorityServiceTier(original);

		expect(shaped).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(original).toEqual({ model: "gpt-5.4", service_tier: "default" });
	});

	it("leaves non-object payloads unchanged", () => {
		const arrayPayload: unknown[] = [];
		expect(withPriorityServiceTier(null)).toBeNull();
		expect(withPriorityServiceTier("payload")).toBe("payload");
		expect(withPriorityServiceTier(arrayPayload)).toBe(arrayPayload);
	});

	it("lets pi payload hooks inspect and override the injected tier", async () => {
		let observed: unknown;
		const result = await applyFastPayloadHook({ model: "gpt-5.4" }, model, (payload) => {
			observed = payload;
			return { ...(payload as Record<string, unknown>), service_tier: "default" };
		});

		expect(observed).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(result).toEqual({ model: "gpt-5.4", service_tier: "default" });
	});

	it("keeps priority when later payload hooks return undefined", async () => {
		const result = await applyFastPayloadHook({ model: "gpt-5.4" }, model, () => undefined);
		expect(result).toEqual({ model: "gpt-5.4", service_tier: "priority" });
	});
});
