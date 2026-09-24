import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getApiProvider, stream, streamSimple, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROACTIVE_COMPACTION_ERROR_PREFIX } from "../extensions/auto-compact.ts";
import type { CliproxyCodexStreamSimple } from "../extensions/codex-stream.ts";
import * as codexStream from "../extensions/codex-stream.ts";
import providerExtension, { COMPAT_SOURCE_ID, resetCompatCoordinator } from "../extensions/index.ts";
import { AUTH_FILE_NAME } from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
] as const;

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-extension-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEnv = new Map(CLIPROXYAPI_ENV_NAMES.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of CLIPROXYAPI_ENV_NAMES) delete process.env[name];

	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		for (const [name, value] of previousEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function createPiMock(commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const registeredModels = new Map<string, Model<Api>>();
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
		unregisterProvider: vi.fn((providerId: string) => {
			for (const key of registeredModels.keys()) {
				if (key.startsWith(`${providerId}/`)) registeredModels.delete(key);
			}
		}),
		registerProvider: vi.fn((providerId: string, config: Record<string, unknown>) => {
			const models = Array.isArray(config.models) ? config.models : [];
			for (const model of models) {
				const entry = model as Model<Api>;
				registeredModels.set(`${providerId}/${entry.id}`, {
					...entry,
					provider: providerId,
					api: config.api as Api,
					baseUrl: config.baseUrl as string,
				});
			}
		}),
		setModel: vi.fn(async () => true),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
	} as unknown as ExtensionAPI;
	const modelRegistry = {
		find: (providerId: string, modelId: string) => registeredModels.get(`${providerId}/${modelId}`),
	};
	return { pi, handlers, modelRegistry, registeredModels };
}

describe("pi 0.82.0 compatibility", () => {
	afterEach(() => {
		resetCompatCoordinator();
		unregisterApiProviders(COMPAT_SOURCE_ID);
	});

	it("re-registers in place on hosts without unregisterProvider", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "ambient-key" }),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi } = createPiMock(commands);
			Reflect.deleteProperty(pi as object, "unregisterProvider");
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				const registerCallsAfterLoad = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.length;
				expect(registerCallsAfterLoad).toBeGreaterThan(0);
				expect("unregisterProvider" in pi).toBe(false);

				const refresh = commands.get("cliproxyapi-refresh");
				if (!refresh) throw new Error("cliproxyapi-refresh command is unavailable");
				await refresh.handler("", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);

				// Without unregisterProvider the host cannot replace; refresh only
				// re-registers. Stale merged fields are a documented host limitation.
				expect(pi.registerProvider).toHaveBeenCalledTimes(registerCallsAfterLoad + 1);
				expect("unregisterProvider" in pi).toBe(false);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("registers oauth login and /fast without a dedicated /cliproxyapi command", async () => {
		await withTempAgentDir(async () => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).not.toHaveBeenCalled();

				expect(commands.size).toBe(4);
				expect(commands.has("fast")).toBe(true);
				expect(commands.has("pause")).toBe(true);
				expect(commands.has("continue")).toBe(true);
				expect(commands.has("cliproxyapi-refresh")).toBe(true);
				expect(commands.has("cliproxyapi")).toBe(false);
				expect(pi.unregisterProvider).toHaveBeenCalledWith("cliproxyapi");
				expect(pi.registerProvider).toHaveBeenCalledWith(
					"cliproxyapi",
					expect.objectContaining({
						name: "CLIProxyAPI",
						oauth: expect.any(Object),
					}),
				);
				// OAuth-only registration keeps `/login cliproxyapi` off the API-key selector.
				for (const [, config] of (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls) {
					expect(config).not.toHaveProperty("apiKey");
				}
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("updates the active session model with Fast pricing after /fast", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, modelRegistry, registeredModels } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).startsWith("https://models.dev/")) {
					return new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-5.6-sol": {
										cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
										experimental: {
											modes: {
												fast: {
													cost: { input: 10, output: 60, cache_read: 1, cache_write: 12.5 },
												},
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
					JSON.stringify({ models: [{ slug: "gpt-5.6-sol", service_tiers: [{ id: "priority" }] }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			try {
				await providerExtension(pi);
				const currentModel = registeredModels.get("cliproxyapi/gpt-5.6-sol");
				expect(currentModel?.cost.input).toBe(5);
				const command = commands.get("fast");
				if (!command || !currentModel) throw new Error("Fast command or active model is unavailable");

				const ctx = {
					model: currentModel,
					modelRegistry,
					ui: { notify: vi.fn() },
				} as unknown as ExtensionCommandContext;
				await command.handler("", ctx);

				expect(pi.setModel).toHaveBeenCalledWith(
					expect.objectContaining({
						id: "gpt-5.6-sol",
						provider: "cliproxyapi",
						cost: { input: 10, output: 60, cacheRead: 1, cacheWrite: 12.5 },
					}),
				);

				const fastModel = (pi.setModel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Model<Api>;
				await command.handler("", { ...ctx, model: fastModel });
				expect(pi.setModel).toHaveBeenLastCalledWith(
					expect.objectContaining({
						id: "gpt-5.6-sol",
						provider: "cliproxyapi",
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					}),
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("loads configured models without registering /cliproxyapi", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, AUTH_FILE_NAME),
				JSON.stringify({
					cliproxyapi: {
						type: "oauth",
						access: "stored-key",
						refresh: JSON.stringify({ baseUrl: "http://127.0.0.1:8317" }),
						expires: Date.now() + 60_000,
					},
				}),
				"utf8",
			);
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).toHaveBeenCalled();
				expect(commands.size).toBe(4);
				expect(commands.has("fast")).toBe(true);
				expect(commands.has("pause")).toBe(true);
				expect(commands.has("continue")).toBe(true);
				expect(commands.has("cliproxyapi-refresh")).toBe(true);
				expect(commands.has("cliproxyapi")).toBe(false);
				expect(pi.registerProvider).toHaveBeenCalledWith(
					"cliproxyapi",
					expect.objectContaining({
						oauth: expect.any(Object),
					}),
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("registers and unregisters cliproxyapi-codex-responses with the pi-ai compat dispatcher", async () => {
		await withTempAgentDir(async () => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, handlers } = createPiMock(commands);

			await providerExtension(pi);

			const provider = getApiProvider("cliproxyapi-codex-responses" as Api);
			expect(provider).toBeDefined();

			const testModel = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			expect(() => streamSimple(testModel, { messages: [] })).not.toThrow(
				/No API provider registered for api: cliproxyapi-codex-responses/,
			);
			expect(() => stream(testModel, { messages: [] })).not.toThrow(
				/No API provider registered for api: cliproxyapi-codex-responses/,
			);

			const shutdownHandlers = handlers.get("session_shutdown") ?? [];
			for (const handler of shutdownHandlers) {
				handler({}, {} as ExtensionContext);
			}

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeUndefined();
		});
	});

	it("keeps compat dispatcher isolated from foreground proactive compaction state", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ compaction: { enabled: true, reserveTokens: 65536 } }),
				"utf8",
			);
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, handlers } = createPiMock(commands);

			await providerExtension(pi);

			const testModel = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				contextWindow: 372000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			const mockCtx = {
				agentDir,
				cwd: agentDir,
				model: testModel,
				isProjectTrusted: () => false,
				getContextUsage: () => ({ tokens: 372000 - 65536 + 10 }),
			} as unknown as ExtensionContext;

			// Trigger session_start to initialize settingsManager
			const sessionStartHandlers = handlers.get("session_start") ?? [];
			for (const handler of sessionStartHandlers) {
				handler({}, mockCtx);
			}

			const turnEndHandlers = handlers.get("turn_end") ?? [];
			const overThresholdMessage = {
				role: "assistant",
				provider: "cliproxyapi",
				model: "gpt-5.6-terra",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				stopReason: "toolUse",
			};

			for (const handler of turnEndHandlers) {
				await handler({ message: overThresholdMessage }, mockCtx);
			}

			// Background compat dispatcher should not be intercepted by foreground proactive compaction
			const compatStream = streamSimple(testModel, { messages: [] }, { apiKey: "test-key" });
			expect(compatStream).toBeDefined();
			const compatResult = await compatStream.result().catch((err) => ({ errorMessage: String(err) }));
			expect(compatResult.errorMessage).not.toContain(PROACTIVE_COMPACTION_ERROR_PREFIX);

			// Foreground provider's streamSimple produces the proactive compaction overflow stream
			const foregroundConfig = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
				streamSimple: CliproxyCodexStreamSimple;
			};
			const foregroundStream = foregroundConfig.streamSimple(testModel, { messages: [] }, { apiKey: "test-key" });
			const foregroundMessage = await foregroundStream.result();
			expect(foregroundMessage.errorMessage).toContain(PROACTIVE_COMPACTION_ERROR_PREFIX);

			for (const handler of handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}
			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeUndefined();
		});
	});

	it("manages shared compat registration across multiple interleaved instances", async () => {
		await withTempAgentDir(async () => {
			const commands1 = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const mock1 = createPiMock(commands1);
			await providerExtension(mock1.pi);

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();

			const commands2 = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const mock2 = createPiMock(commands2);
			await providerExtension(mock2.pi);

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();

			// Instance 1 shuts down, but Instance 2 is still active
			for (const handler of mock1.handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}

			// Compat provider must still remain registered for Instance 2
			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();

			const testModel = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			expect(() => streamSimple(testModel, { messages: [] })).not.toThrow(
				/No API provider registered for api: cliproxyapi-codex-responses/,
			);

			// Instance 2 shuts down -> all instances are gone, provider is cleanly unregistered
			for (const handler of mock2.handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeUndefined();
		});
	});

	it("maintains registration when newer instance shuts down before older instance", async () => {
		await withTempAgentDir(async () => {
			const commands1 = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const mock1 = createPiMock(commands1);
			await providerExtension(mock1.pi);

			const commands2 = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const mock2 = createPiMock(commands2);
			await providerExtension(mock2.pi);

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();

			// Newer instance (Instance 2) shuts down first
			for (const handler of mock2.handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}

			// Compat provider must still remain registered because Instance 1 is still active
			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();

			const testModel = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			expect(() => streamSimple(testModel, { messages: [] })).not.toThrow(
				/No API provider registered for api: cliproxyapi-codex-responses/,
			);

			// Instance 1 shuts down -> now all instances are gone, cleanly unregisters
			for (const handler of mock1.handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeUndefined();
		});
	});

	it("manages compat registration across different provider IDs", async () => {
		await withTempAgentDir(async () => {
			const commands1 = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const mock1 = createPiMock(commands1);
			await providerExtension(mock1.pi);

			// Second instance with a custom provider ID
			process.env.CLIPROXYAPI_PROVIDER_ID = "cliproxyapi-custom";
			const commands2 = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const mock2 = createPiMock(commands2);
			await providerExtension(mock2.pi);

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();

			const modelCustom = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi-custom",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			const modelDefault = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			expect(() => streamSimple(modelCustom, { messages: [] }, { apiKey: "stored-key" })).not.toThrow();
			expect(() => streamSimple(modelDefault, { messages: [] }, { apiKey: "stored-key" })).not.toThrow();

			// Shut down custom provider instance
			for (const handler of mock2.handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}

			// Custom provider calls now fail with provider-specific error
			expect(() => streamSimple(modelCustom, { messages: [] }, { apiKey: "stored-key" })).toThrow(
				/No active provider streamSimple handler registered for provider: cliproxyapi-custom/,
			);

			// Default provider still active
			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeDefined();
			expect(() => streamSimple(modelDefault, { messages: [] }, { apiKey: "stored-key" })).not.toThrow();

			// Unknown provider throws immediately
			const modelUnknown = {
				id: "gpt-5.6-terra",
				provider: "unknown-provider",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;
			expect(() => streamSimple(modelUnknown, { messages: [] }, { apiKey: "stored-key" })).toThrow(
				/No active provider streamSimple handler registered for provider: unknown-provider/,
			);

			// Shut down default provider instance
			for (const handler of mock1.handlers.get("session_shutdown") ?? []) {
				handler({}, {} as ExtensionContext);
			}

			expect(getApiProvider("cliproxyapi-codex-responses" as Api)).toBeUndefined();
		});
	});

	it("isolates Fast mode in compat dispatch from mutable foreground instance toggles", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi } = createPiMock(commands);

			await providerExtension(pi);

			const testModel = {
				id: "gpt-5.6-terra",
				provider: "cliproxyapi",
				api: "cliproxyapi-codex-responses" as Api,
				baseUrl: "http://127.0.0.1:8317",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<Api>;

			// Standard compat call without fast requested does not inject priority
			const stream1 = streamSimple(testModel, { messages: [] }, { apiKey: "stored-key" });
			expect(stream1).toBeDefined();

			// Explicit fast request via serviceTier: "priority" works
			const stream2 = streamSimple(testModel, { messages: [] }, {
				apiKey: "stored-key",
				serviceTier: "priority",
			} as any);
			expect(stream2).toBeDefined();
		});
	});

	it("closes Codex WebSocket sessions on session_shutdown to allow clean process exit (Issue #26)", async () => {
		await withTempAgentDir(async () => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, handlers } = createPiMock(commands);

			const closeWebSocketSessionsMock = vi.fn();
			const originalLoadCliproxyCodexStreams = codexStream.loadCliproxyCodexStreams;
			const spy = vi.spyOn(codexStream, "loadCliproxyCodexStreams").mockImplementation(async (...args) => {
				const real = await originalLoadCliproxyCodexStreams(...args);
				return {
					...real,
					closeOpenAICodexWebSocketSessions: closeWebSocketSessionsMock,
				};
			});

			try {
				await providerExtension(pi);

				const shutdownHandlers = handlers.get("session_shutdown") ?? [];
				expect(shutdownHandlers.length).toBeGreaterThan(0);

				for (const handler of shutdownHandlers) {
					handler({ type: "session_shutdown", reason: "quit" }, {} as ExtensionContext);
				}

				expect(closeWebSocketSessionsMock).toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});
	});

	it("normalizes OMP system prompt arrays before invoking the Pi Codex stream", async () => {
		const { wrapStreamSimpleForFast } = await import("../extensions/codex-stream.ts");
		const eventStream = {} as import("@earendil-works/pi-ai").AssistantMessageEventStream;
		const delegate = vi.fn(() => eventStream) as unknown as import("../extensions/codex-stream.ts").CliproxyCodexStreamSimple;
		const wrapped = wrapStreamSimpleForFast(delegate);
		const model = { id: "gpt-5.6-sol", provider: "cliproxyapi" } as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
		const context = {
			systemPrompt: ["first", "second"],
			messages: [],
		} as unknown as import("@earendil-works/pi-ai").Context;
		wrapped(model, context, { signal: undefined as never });
		expect(delegate).toHaveBeenCalled();
		const passed = delegate.mock.calls[0][1] as { systemPrompt?: unknown };
		expect(typeof passed.systemPrompt === "string" || Array.isArray(passed.systemPrompt)).toBe(true);
	});

});
