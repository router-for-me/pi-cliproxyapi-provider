import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	applyServiceTierPayloadHook,
	type CliproxyCodexStreamSimple,
	loadCliproxyCodexStreams,
	patchCodexSource,
	resolveCodexModuleFromNodeEntry,
	withServiceTier,
	wrapStreamForServiceTier,
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
	it("falls back to SSE after exhausting WebSocket retries before stream start (Issue #33)", () => {
		const source = readFileSync(
			new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", import.meta.url),
			"utf8",
		);
		const patched = patchCodexSource(source, ["cliproxyapi"]);

		// WebSocket retries are still attempted before message stream start
		expect(patched).toContain("let websocketRetries = 0;");
		expect(patched).toContain("const maxWebSocketRetries = Number.isFinite(options?.maxRetries)");
		expect(patched).toContain("? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)");
		expect(patched).toContain(": 3;");

		// When retries are exhausted before start, it must fall back to SSE instead of throwing
		expect(patched).toContain('fallbackTransport: websocketStarted ? undefined : "sse"');
		expect(patched).toContain("websocketSseFallbackSessions.add(sessionId);");
		expect(patched).toMatch(/recordWebSocketSseFallback\([^)]*\);\s*break;/);
		expect(patched).not.toContain("const websocketDisabledForSession = false;");
		expect(patched).toContain("isWebSocketSseFallbackActive(");
		expect(patched).toContain('(process.env.CLIPROXYAPI_TRANSPORT || options?.transport || "auto")');
		expect(patched).toContain("export function closeOpenAICodexWebSocketSessions(sessionId)");
	});

	it("extends WebSocket idle TTL to 30 minutes to preserve implicit cache (Issue #33)", () => {
		const source = readFileSync(
			new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", import.meta.url),
			"utf8",
		);
		const patched = patchCodexSource(source, ["cliproxyapi"]);

		expect(patched).not.toContain("const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;");
		expect(patched).toMatch(/SESSION_WEBSOCKET_CACHE_TTL_MS\s*=.*30\s*\*\s*60\s*\*\s*1000/);
	});

	it("falls back to SSE fetch when WebSocket connect fails before start (Issue #33)", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		let fetchCalls = 0;
		const customFetch = async () => {
			fetchCalls++;
			return new Response("", { status: 500, statusText: "Server Error" });
		};

		const testModel = {
			id: "gpt-5.4",
			provider: "cliproxyapi",
			baseUrl: "http://127.0.0.1:19999",
			input: ["text"],
		} as unknown as Model<Api>;

		const stream1 = streams.streamSimple(
			testModel,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: "test-api-key",
				sessionId: "test-ws-fallback-sess",
				websocketConnectTimeoutMs: 50,
				fetch: customFetch as unknown as typeof fetch,
				maxRetries: 0,
			},
		);

		await stream1.result();
		expect(fetchCalls).toBe(1);

		// Subsequent request in same session uses sticky SSE and calls fetch directly
		const stream2 = streams.streamSimple(
			testModel,
			{ messages: [{ role: "user", content: "turn 2", timestamp: Date.now() }] },
			{
				apiKey: "test-api-key",
				sessionId: "test-ws-fallback-sess",
				fetch: customFetch as unknown as typeof fetch,
				maxRetries: 0,
			},
		);

		await stream2.result();
		expect(fetchCalls).toBe(2);
	});

	it("exports closeOpenAICodexWebSocketSessions from the patched module instance", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		expect(typeof (streams as any).closeOpenAICodexWebSocketSessions).toBe("function");
		expect(() => (streams as any).closeOpenAICodexWebSocketSessions("missing-session")).not.toThrow();
	});
});

describe("FastModeController", () => {
	it("combines the global preference with model capability", () => {
		const mode = new FastModeController(false);
		mode.setSupportedModelIds(["gpt-5.4", " gpt-5.5 ", ""]);

		expect(mode.isEnabled()).toBe(false);
		expect(mode.isModelSupported("gpt-5.4")).toBe(true);
		expect(mode.isModelSupported("gpt-5.5")).toBe(true);
		expect(mode.getServiceTierFor("gpt-5.4")).toBeUndefined();
		expect(mode.getServiceTierFor("custom-model")).toBeUndefined();

		mode.setPreference(true);
		expect(mode.getServiceTierFor("gpt-5.4")).toBe("priority");
		expect(mode.getServiceTierFor("custom-model")).toBeUndefined();

		mode.setPreference(false);
		expect(mode.getServiceTierFor("gpt-5.4")).toBeUndefined();
	});

	it("updates the global preference", () => {
		const mode = new FastModeController(false);

		mode.setPreference(true);
		expect(mode.isEnabled()).toBe(true);
		mode.setPreference(false);
		expect(mode.isEnabled()).toBe(false);
	});
});

describe("Fast footer model status", () => {
	it("appends Fast and paused labels at the right side of model status", () => {
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", "fast")).toBe("gpt-5.6-sol • xhigh • fast");
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", "fast", "paused")).toBe(
			"gpt-5.6-sol • xhigh • fast • paused",
		);
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh")).toBe("gpt-5.6-sol • xhigh");
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
		fastMode.setPreference(true);
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
			fastMode.setPreference("ultrafast");
			expect(component.render(80)).toEqual(["gpt-5.4 • xhigh • <yellow>Ultra Fast</yellow>|false"]);
			fastMode.setSupportedModelIds([]);
			expect(component.render(80)).toEqual(["gpt-5.4|true"]);
			fastMode.setSupportedModelIds([model.id]);
			fastMode.setPreference(false);
			expect(component.render(80)).toEqual(["gpt-5.4|true"]);

			pauseMode.setEnabled(true);
			expect(component.render(80)).toEqual([`gpt-5.4 • xhigh • ${orangePaused}|false`]);
			pauseMode.setEnabled(false);
			fastMode.setPreference(true);
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
	it("passes options through unchanged when Fast is not effective", () => {
		let captured: SimpleStreamOptions | undefined;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = (_model, _context, options) => {
			captured = options;
			return streamResult;
		};
		const wrapped = wrapStreamForServiceTier(baseStream, () => undefined);
		const options: SimpleStreamOptions = { timeoutMs: 1234 };

		expect(wrapped(model, { messages: [] }, options)).toBe(streamResult);
		expect(captured).toBe(options);
	});

	it("preserves stream options and composes the Fast payload hook when enabled", async () => {
		let captured: SimpleStreamOptions | undefined;
		let observed: unknown;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = (_model, _context, options) => {
			captured = options;
			return streamResult;
		};
		const wrapped = wrapStreamForServiceTier(baseStream, () => "priority");
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
		const shaped = withServiceTier(original, "priority");

		expect(shaped).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(original).toEqual({ model: "gpt-5.4", service_tier: "default" });
	});

	it("leaves non-object payloads unchanged", () => {
		const arrayPayload: unknown[] = [];
		expect(withServiceTier(null, "priority")).toBeNull();
		expect(withServiceTier("payload", "priority")).toBe("payload");
		expect(withServiceTier(arrayPayload, "priority")).toBe(arrayPayload);
	});

	it("lets pi payload hooks inspect and override the injected tier", async () => {
		let observed: unknown;
		const result = await applyServiceTierPayloadHook({ model: "gpt-5.4" }, model, "priority", (payload) => {
			observed = payload;
			return { ...(payload as Record<string, unknown>), service_tier: "default" };
		});

		expect(observed).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(result).toEqual({ model: "gpt-5.4", service_tier: "default" });
	});

	it("keeps priority when later payload hooks return undefined", async () => {
		const result = await applyServiceTierPayloadHook({ model: "gpt-5.4" }, model, "priority", () => undefined);
		expect(result).toEqual({ model: "gpt-5.4", service_tier: "priority" });
	});
});
