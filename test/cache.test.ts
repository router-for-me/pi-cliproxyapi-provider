import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import {
	CONFIG_FILE_NAME,
	fetchCodexModels,
	loadMappedModels,
	loadModelsCache,
	type MappedModels,
	MODELS_CACHE_FILE_NAME,
	MODELS_REQUEST_TIMEOUT_MS,
	type PiProviderModel,
	resolveEndpoints,
	resolveMappedModels,
	saveModelsCache,
} from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
] as const;

function createModel(id: string): PiProviderModel {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function createCodexModel(id: string, fast = false) {
	return {
		slug: id,
		display_name: id,
		input_modalities: ["text"],
		...(fast ? { service_tiers: [{ id: "priority", name: "Fast" }] } : {}),
	};
}

function createMappedModels(
	options: { models?: PiProviderModel[]; fastModelIds?: string[]; fastMode?: boolean } = {},
): MappedModels {
	const endpoints = resolveEndpoints("http://127.0.0.1:8317");
	return {
		models: options.models ?? [],
		fastModelIds: options.fastModelIds ?? [],
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
		...(options.fastMode === undefined ? {} : { fastMode: options.fastMode }),
	};
}

const tempPaths: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-cache-test-"));
	tempPaths.push(dir);
	return dir;
}

function writeConfig(agentDir: string, config: { baseUrl?: string; apiKey?: string }): void {
	writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify(config, null, 2), "utf8");
}

async function waitForAsyncRefresh(): Promise<void> {
	for (let index = 0; index < 10; index++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = tempAgentDir();
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
	}
}

function createPiMock(commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>()) {
	let providerConfig: ProviderConfig | undefined;
	let refreshController: AbortController | undefined;
	const sessionStartHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
		unregisterProvider: vi.fn(),
		registerProvider: vi.fn((_providerId: string, config: ProviderConfig) => {
			providerConfig = config;
		}),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (event === "session_start") sessionStartHandlers.push(handler);
		}),
		setModel: vi.fn(async () => true),
	} as unknown as ExtensionAPI;

	const models = (): Model<Api>[] =>
		(providerConfig?.models ?? []).map((model) => ({
			...model,
			provider: "cliproxyapi",
			api: providerConfig?.api ?? "openai-codex-responses",
			baseUrl: providerConfig?.baseUrl ?? "http://127.0.0.1:8317/backend-api/",
		})) as Model<Api>[];
	const modelRegistry = {
		refresh: vi.fn(async (options: { force?: boolean } = {}) => {
			refreshController?.abort();
			const controller = new AbortController();
			refreshController = controller;
			const errors = new Map<string, Error>();
			const callback = providerConfig?.refreshModels;
			if (callback) {
				const run = async (allowNetwork: boolean): Promise<void> => {
					const context: RefreshModelsContext = {
						allowNetwork,
						...(allowNetwork && options.force ? { force: true } : {}),
						signal: controller.signal,
						publish: async ({ update }) => {
							if (controller.signal.aborted) return false;
							update?.();
							return true;
						},
					};
					const refreshed = await callback(context);
					if (!controller.signal.aborted && providerConfig) providerConfig.models = refreshed;
				};
				try {
					await run(false);
					if (!controller.signal.aborted) await run(true);
				} catch (error) {
					if (!controller.signal.aborted) {
						errors.set("cliproxyapi", error instanceof Error ? error : new Error(String(error)));
					}
				}
			}
			return { aborted: controller.signal.aborted, errors };
		}),
		find: (providerId: string, modelId: string) =>
			models().find((model) => model.provider === providerId && model.id === modelId),
		getProvider: (providerId: string) => (providerId === "cliproxyapi" ? { getModels: models } : undefined),
	};
	const emitCatalogSessionStart = async (): Promise<void> => {
		const ctx = { modelRegistry, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
		await sessionStartHandlers.at(-1)?.({ type: "session_start" }, ctx);
	};
	return { pi, commands, modelRegistry, emitCatalogSessionStart, getProviderConfig: () => providerConfig };
}

afterEach(() => {
	while (tempPaths.length > 0) {
		const path = tempPaths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

describe("models cache helpers", () => {
	it("save and load round-trip cache when endpoints match", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({
			models: [createModel("cached-model")],
			fastModelIds: ["fast-model"],
		});
		const fetchedAt = Date.now() - 60 * 60 * 1000;

		saveModelsCache(agentDir, loaded, fetchedAt);
		const cache = loadModelsCache(agentDir, "http://127.0.0.1:8317");

		expect(cache).toEqual({ ...loaded, fetchedAt });
	});

	it("returns null when the cache file is missing", () => {
		const agentDir = tempAgentDir();
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317")).toBeNull();
	});

	it("returns null when the cached endpoint URLs do not match", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({ models: [createModel("m1")] });
		saveModelsCache(agentDir, loaded, Date.now());

		expect(loadModelsCache(agentDir, "http://127.0.0.1:9999")).toBeNull();
	});

	it("matches cache across equivalent baseUrl forms", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({ models: [createModel("m1")] });
		const fetchedAt = Date.now();
		saveModelsCache(agentDir, loaded, fetchedAt);

		expect(loadModelsCache(agentDir, "127.0.0.1:8317")).toEqual({ ...loaded, fetchedAt });
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317/")).toEqual({ ...loaded, fetchedAt });
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317/v1")).toEqual({ ...loaded, fetchedAt });
	});

	it("writes pretty-printed JSON to disk", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({ models: [createModel("m1")] });
		saveModelsCache(agentDir, loaded, 12345);

		const raw = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toEqual({ ...loaded, fetchedAt: 12345 });
	});
});

describe("models request timeout wiring", () => {
	it("uses the 60-second default timeout for mapped model requests", async () => {
		const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

		try {
			await loadMappedModels("http://127.0.0.1:8317", "key");
			expect(MODELS_REQUEST_TIMEOUT_MS).toBe(60_000);
			expect(timeoutSpy).toHaveBeenCalledWith(MODELS_REQUEST_TIMEOUT_MS);
			expect(timeoutSpy).toHaveBeenCalledTimes(1);
			const requestInit = fetchMock.mock.calls[0]?.[1];
			expect(requestInit).toBeDefined();
			expect(requestInit).toHaveProperty("signal");
		} finally {
			fetchMock.mockRestore();
			timeoutSpy.mockRestore();
		}
	});

	it("uses the 60-second default timeout through fetchCodexModels", async () => {
		const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

		try {
			await fetchCodexModels("http://127.0.0.1:8317/v1/models?client_version=pi", "key");
			expect(timeoutSpy).toHaveBeenCalledWith(60_000);
			const requestInit = fetchMock.mock.calls[0]?.[1];
			expect(requestInit).toBeDefined();
			expect(requestInit).toHaveProperty("signal");
		} finally {
			fetchMock.mockRestore();
			timeoutSpy.mockRestore();
		}
	});
});

describe("resolveMappedModels cache behavior", () => {
	it("returns an existing cache without fetching regardless of age", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({ models: [createModel("cached")], fastModelIds: ["fast-cached"] });
		saveModelsCache(agentDir, cached, 1);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch"));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(result.fromCache).toBe(true);
			expect(result.loaded.models).toEqual(cached.models);
			expect(result.loaded.fastModelIds).toEqual(["fast-cached"]);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("does not use a cache generated for a different Fast mode", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({ models: [createModel("cached")], fastMode: false });
		saveModelsCache(agentDir, cached, Date.now());

		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).includes("models.dev")) {
				return new Response("{}", { status: 200 });
			}
			return new Response(JSON.stringify({ models: [createCodexModel("remote-fast")] }), { status: 200 });
		});

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", { fastMode: true });
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(result.fromCache).toBe(false);
			expect(result.loaded.models[0]?.id).toBe("remote-fast");
			expect(loadModelsCache(agentDir, "http://127.0.0.1:8317")?.fastMode).toBe(true);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("fetches remotely when no cache exists", async () => {
		const agentDir = tempAgentDir();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [createCodexModel("remote")] }), { status: 200 }));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.fromCache).toBe(false);
			expect(result.loaded.models.map((model) => model.id)).toEqual(["remote"]);
			const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
			expect(diskCache?.models[0].id).toBe("remote");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("forceRefresh bypasses even a fresh cache", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({ models: [createModel("cached")] });
		saveModelsCache(agentDir, cached, Date.now());

		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [createCodexModel("forced")] }), { status: 200 }));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", {
				forceRefresh: true,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.fromCache).toBe(false);
			expect(result.loaded.models[0].id).toBe("forced");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("leaves the existing cache untouched until a forced refresh", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({ models: [createModel("cached-fallback")] });
		saveModelsCache(agentDir, cached, 1);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(result.fromCache).toBe(true);
			expect(result.loaded.models[0].id).toBe("cached-fallback");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("does not fall back when forceRefresh is requested and the remote call fails", async () => {
		const agentDir = tempAgentDir();
		const stale = createMappedModels({ models: [createModel("stale")] });
		saveModelsCache(agentDir, stale, 1);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

		try {
			await expect(
				resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", { forceRefresh: true }),
			).rejects.toThrow("network down");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe("provider startup cache behavior", () => {
	it("waits for the remote catalog when no cache exists", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			let releaseRemote!: (response: Response) => void;
			const remoteResponse = new Promise<Response>((resolve) => {
				releaseRemote = resolve;
			});
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return remoteResponse;
			});
			const { pi } = createPiMock();

			try {
				const startup = providerExtension(pi);
				await waitForAsyncRefresh();
				expect(fetchMock).toHaveBeenCalledTimes(2);
				releaseRemote(
					new Response(JSON.stringify({ models: [createCodexModel("startup-remote")] }), { status: 200 }),
				);
				await expect(startup).resolves.toBeUndefined();

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("startup-remote");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("uses the cache immediately and refreshes the model list in the background", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({ models: [createModel("startup-cached")], fastModelIds: ["cached-fast"] });
			saveModelsCache(agentDir, cached, 1);

			let releaseRemote!: (response: Response) => void;
			const remoteResponse = new Promise<Response>((resolve) => {
				releaseRemote = resolve;
			});
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return remoteResponse;
			});
			const { pi, commands, emitCatalogSessionStart, getProviderConfig } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).not.toHaveBeenCalled();
				expect(commands.has("cliproxyapi-refresh")).toBe(true);
				expect(getProviderConfig()?.models?.map((model) => model.id)).toEqual(["startup-cached"]);
				expect(pi.registerProvider).toHaveBeenCalledTimes(1);
				expect(pi.unregisterProvider).not.toHaveBeenCalled();

				await emitCatalogSessionStart();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				expect(fetchMock).toHaveBeenCalledTimes(2);
				releaseRemote(
					new Response(JSON.stringify({ models: [createCodexModel("background-fresh", true)] }), { status: 200 }),
				);
				await waitForAsyncRefresh();

				expect(getProviderConfig()?.models?.[0]?.id).toBe("background-fresh");
				expect(pi.registerProvider).toHaveBeenCalledTimes(1);
				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("background-fresh");
				expect(diskCache?.fastModelIds).toEqual(["background-fresh"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("does not let a superseded background refresh overwrite a newer refresh", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({ models: [createModel("startup-cached")] });
			saveModelsCache(agentDir, cached, 1);

			let releaseBackground!: (response: Response) => void;
			const backgroundResponse = new Promise<Response>((resolve) => {
				releaseBackground = resolve;
			});
			let modelRequestCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				modelRequestCount += 1;
				if (modelRequestCount === 1) return backgroundResponse;
				return new Response(JSON.stringify({ models: [createCodexModel("newer")] }), { status: 200 });
			});
			const { pi, commands, modelRegistry, emitCatalogSessionStart, getProviderConfig } = createPiMock();

			try {
				await providerExtension(pi);
				await emitCatalogSessionStart();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				await refresh.handler("", { modelRegistry, ui: { notify } } as unknown as ExtensionCommandContext);

				const diskCacheAfterNewerRefresh = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCacheAfterNewerRefresh?.models[0]?.id).toBe("newer");

				releaseBackground(new Response(JSON.stringify({ models: [createCodexModel("older")] }), { status: 200 }));
				await waitForAsyncRefresh();

				const diskCacheAfterOlderRefresh = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCacheAfterOlderRefresh?.models[0]?.id).toBe("newer");
				expect(getProviderConfig()?.models?.[0]?.id).toBe("newer");
				expect(pi.registerProvider).toHaveBeenCalledTimes(1);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("keeps the cache when the background refresh fails", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({ models: [createModel("startup-fallback")] });
			saveModelsCache(agentDir, cached, 1);

			const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
			const { pi, emitCatalogSessionStart, getProviderConfig } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				await emitCatalogSessionStart();
				await waitForAsyncRefresh();
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(getProviderConfig()?.models?.[0]?.id).toBe("startup-fallback");
				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("startup-fallback");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});

describe("/cliproxyapi-refresh command", () => {
	it("is registered by the provider extension", async () => {
		await withTempAgentDir(async () => {
			const { pi, commands } = createPiMock();
			await expect(providerExtension(pi)).resolves.toBeUndefined();
			const refresh = commands.get("cliproxyapi-refresh");
			expect(refresh).toBeDefined();
			expect(refresh?.description).toContain("refresh");
		});
	});

	it("refuses arguments and notifies usage", async () => {
		await withTempAgentDir(async () => {
			const { pi, commands } = createPiMock();
			await providerExtension(pi);
			const refresh = commands.get("cliproxyapi-refresh")!;
			const notify = vi.fn();
			const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

			await refresh.handler("now", ctx);
			expect(notify).toHaveBeenCalledWith("Usage: /cliproxyapi-refresh", "error");
		});
	});

	it("notifies an error when the provider is not configured", async () => {
		await withTempAgentDir(async () => {
			const { pi, commands } = createPiMock();
			await providerExtension(pi);
			const refresh = commands.get("cliproxyapi-refresh")!;
			const notify = vi.fn();
			const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

			await refresh.handler("", ctx);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("not configured"), "error");
		});
	});

	it("force-refreshes models, updates the cache, and updates fast model ids", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const stale = createMappedModels({ models: [createModel("stale-refresh")] });
			saveModelsCache(agentDir, stale, 1);

			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(() =>
					Promise.resolve(
						new Response(JSON.stringify({ models: [createCodexModel("refreshed", true)] }), { status: 200 }),
					),
				);
			const { pi, commands, modelRegistry } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				const model = { id: "refreshed", provider: "cliproxyapi" } as Model<Api>;
				const ctx = { model, modelRegistry, ui: { notify } } as unknown as ExtensionCommandContext;

				await refresh.handler("", ctx);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1 CLIProxyAPI models"), "info");
				expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "refreshed" }));
				expect(pi.registerProvider).toHaveBeenCalledTimes(1);
				expect(pi.unregisterProvider).not.toHaveBeenCalled();

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("refreshed");
				expect(diskCache?.fastModelIds).toEqual(["refreshed"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("notifies an error when the remote refresh fails", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });

			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
			const { pi, commands, modelRegistry } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				const model = { id: "any", provider: "cliproxyapi" } as Model<Api>;
				const ctx = { model, modelRegistry, ui: { notify } } as unknown as ExtensionCommandContext;

				await refresh.handler("", ctx);

				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("Failed to refresh CLIProxyAPI models"),
					"error",
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});
