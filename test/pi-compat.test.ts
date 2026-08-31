import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import { AUTH_FILE_NAME } from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROTOCOL",
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
	it("warns once when /v1 automatically selects openai-responses", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://relay.api/v1", apiKey: "stored-key" }),
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
			const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

			try {
				await providerExtension(pi);
				const migrationWarnings = warnMock.mock.calls.filter(([message]) =>
					String(message).includes("Earlier versions treated /v1 as openai-codex"),
				);
				expect(migrationWarnings).toHaveLength(1);
				expect(String(migrationWarnings[0]?.[0])).toMatch(/protocol.*openai-codex/);
			} finally {
				warnMock.mockRestore();
				fetchMock.mockRestore();
			}
		});
	});

	it("does not warn about /v1 migration when the environment selects a protocol", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://relay.api/v1", apiKey: "stored-key" }),
				"utf8",
			);
			process.env.CLIPROXYAPI_PROTOCOL = "openai-codex";

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

			try {
				await providerExtension(pi);
				expect(
					warnMock.mock.calls.some(([message]) =>
						String(message).includes("Earlier versions treated /v1 as openai-codex"),
					),
				).toBe(false);
			} finally {
				warnMock.mockRestore();
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
				JSON.stringify({
					baseUrl: "http://127.0.0.1:8317/v1",
					apiKey: "stored-key",
					protocol: "openai-responses",
				}),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi } = createPiMock(commands);
			const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(
					warnMock.mock.calls.some(([message]) =>
						String(message).includes("Earlier versions treated /v1 as openai-codex"),
					),
				).toBe(false);
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
						headers: {
							"X-Codex-Beta-Features": "remote_compaction_v2",
						},
					}),
				);
			} finally {
				warnMock.mockRestore();
				fetchMock.mockRestore();
			}
		});
	});
});
