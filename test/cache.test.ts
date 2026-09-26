import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import {
	CONFIG_FILE_NAME,
	DEFAULT_MODEL_STALE_TTL_MS,
	fetchCodexModels,
	loadMappedModels,
	loadModelsCache,
	type MappedModels,
	MODELS_CACHE_FILE_NAME,
	MODELS_REQUEST_TIMEOUT_MS,
	mergeModelsWithExistingCache,
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

function createPiMock(commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>()): {
	pi: ExtensionAPI;
	commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
	emit: (event: string, ...args: any[]) => Promise<void>;
} {
	const listeners = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
		unregisterProvider: vi.fn(),
		registerProvider: vi.fn(),
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
		}),
	} as unknown as ExtensionAPI;
	const emit = async (event: string, ...args: any[]) => {
		for (const handler of listeners.get(event) ?? []) {
			await handler(...args);
		}
	};
	return { pi, commands, emit };
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

	it("retains previously cached models with stale marker when remote catalog temporarily shrinks (Issue #34)", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({
			models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			fastModelIds: ["gemini-3.8-flash-high"],
		});
		saveModelsCache(agentDir, cached, Date.now());

		// Remote catalog temporarily drops gemini-3.8-flash-high due to transient 503
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 }));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", {
				forceRefresh: true,
			});
			expect(result.fromCache).toBe(false);
			// gemini-3.8-flash-high must be preserved as stale rather than permanently dropped
			const geminiModel = result.loaded.models.find((m) => m.id === "gemini-3.8-flash-high");
			expect(geminiModel).toBeDefined();
			expect(geminiModel?.stale).toBe(true);
			expect(result.loaded.fastModelIds).toContain("gemini-3.8-flash-high");

			// On-disk cache must also retain the model across sessions
			const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
			expect(diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high")).toBeDefined();
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("retains a model from an 8-day old cache when it first goes missing", () => {
		const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
		const eightDaysAgo = 1_000_000_000;
		const now = eightDaysAgo + eightDaysMs;
		const existingCache = {
			...createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			}),
			fetchedAt: eightDaysAgo,
		};
		// Google temporarily prunes gemini-3.8-flash-high
		const fresh = createMappedModels({
			models: [createModel("gpt-4o")],
		});
		const result = mergeModelsWithExistingCache(existingCache, fresh, now);
		expect(result.merged.models.map((m) => m.id)).toEqual(["gpt-4o", "gemini-3.8-flash-high"]);
		const gemini = result.merged.models.find((m) => m.id === "gemini-3.8-flash-high");
		expect(gemini?.stale).toBe(true);
		expect(gemini?.staleSince).toBe(now);
		expect(result.retainedStaleModels).toHaveLength(1);
	});

	it("drops stale models that exceed the stale retention window", () => {
		const existingCache = {
			...createMappedModels({
				models: [{ ...createModel("expired-model"), stale: true, staleSince: 1000 }],
			}),
			fetchedAt: 1000,
		};
		const fresh = createMappedModels({
			models: [createModel("fresh-model")],
		});
		const result = mergeModelsWithExistingCache(existingCache, fresh, 1000 + DEFAULT_MODEL_STALE_TTL_MS + 1);
		expect(result.merged.models.map((m) => m.id)).toEqual(["fresh-model"]);
		expect(result.droppedModelIds).toEqual(["expired-model"]);
		expect(result.retainedStaleModels).toHaveLength(0);
	});

	it("restores a stale model to fresh when it reappears in the remote catalog", () => {
		const existingCache = {
			...createMappedModels({
				models: [{ ...createModel("recovering-model"), stale: true, lastSeenAt: 5000 }],
			}),
			fetchedAt: 5000,
		};
		const fresh = createMappedModels({
			models: [createModel("recovering-model")],
		});
		const result = mergeModelsWithExistingCache(existingCache, fresh, 6000);
		expect(result.merged.models).toHaveLength(1);
		expect(result.merged.models[0].id).toBe("recovering-model");
		expect(result.merged.models[0].stale).toBe(false);
		expect(result.merged.models[0].lastSeenAt).toBe(6000);
		expect(result.retainedStaleModels).toHaveLength(0);
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
			const { pi, commands } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(commands.has("cliproxyapi-refresh")).toBe(true);

				const initialCallsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(initialCallsWithModels[0]?.[1].models?.map((model: PiProviderModel) => model.id)).toEqual([
					"startup-cached",
				]);

				releaseRemote(
					new Response(JSON.stringify({ models: [createCodexModel("background-fresh", true)] }), { status: 200 }),
				);
				await waitForAsyncRefresh();

				const refreshedCallsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(refreshedCallsWithModels.at(-1)?.[1].models?.[0].id).toBe("background-fresh");
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
			const { pi, commands } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				await refresh.handler("", { ui: { notify } } as unknown as ExtensionCommandContext);

				const diskCacheAfterNewerRefresh = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCacheAfterNewerRefresh?.models[0]?.id).toBe("newer");

				releaseBackground(new Response(JSON.stringify({ models: [createCodexModel("older")] }), { status: 200 }));
				await waitForAsyncRefresh();

				const diskCacheAfterOlderRefresh = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCacheAfterOlderRefresh?.models[0]?.id).toBe("newer");
				const callsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(callsWithModels.at(-1)?.[1].models?.[0]?.id).toBe("newer");
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
			const { pi } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				await waitForAsyncRefresh();
				expect(fetchMock).toHaveBeenCalledTimes(2);

				const callsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(callsWithModels[0]?.[1].models?.[0].id).toBe("startup-fallback");
				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("startup-fallback");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("retains missing models during background refresh on session startup and warns on configured model (Issue #34)", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultModel: "cliproxyapi/gemini-3.8-flash-high" }),
				"utf8",
			);
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

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
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			const ctx = { ui: { notify }, model: { id: "gemini-3.8-flash-high", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, ctx);

				// Remote returns only gpt-4o (temporarily drops gemini-3.8-flash-high)
				releaseRemote(new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 }));
				await waitForAsyncRefresh();

				// Check that registered models still include gemini-3.8-flash-high
				const callsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				const lastRegisteredModels = callsWithModels.at(-1)?.[1].models;
				const gemini = lastRegisteredModels?.find((m) => m.id === "gemini-3.8-flash-high");
				expect(gemini).toBeDefined();
				expect(gemini?.stale).toBe(true);

				// Check on-disk cache retains gemini-3.8-flash-high
				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high")).toBeDefined();

				// Check warning was emitted to UI
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("gemini-3.8-flash-high"), "warning");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("replays missing model warning on session_start if background refresh finishes before session_start", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultModel: "cliproxyapi/gemini-3.8-flash-high" }),
				"utf8",
			);
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			// Remote returns immediately with only gpt-4o
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
			});
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			const ctx = { ui: { notify }, model: { id: "gemini-3.8-flash-high", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				// Wait for background refresh to finish BEFORE session_start is emitted
				await waitForAsyncRefresh();

				// Notice notify was NOT called yet because activeContext was not set
				expect(notify).not.toHaveBeenCalled();

				// Now session_start fires
				await emit("session_start", { reason: "startup" }, ctx);

				// Warning must be delivered upon session_start
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("gemini-3.8-flash-high"), "warning");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("replays missing model warning on session_start for non-default active model if refresh finishes first", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			// settings.json does not configure custom-model
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultModel: "cliproxyapi/other-model" }),
				"utf8",
			);
			const cached = createMappedModels({
				models: [createModel("custom-model"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
			});
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			const ctx = { ui: { notify }, model: { id: "custom-model", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				await waitForAsyncRefresh();
				expect(notify).not.toHaveBeenCalled();

				await emit("session_start", { reason: "startup" }, ctx);
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("custom-model"), "warning");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("warns on session_start when configured default model is stale even if active model is different", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultModel: "cliproxyapi/stale-default-model" }),
				"utf8",
			);
			const cached = createMappedModels({
				models: [createModel("stale-default-model"), createModel("active-model")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				// Remote drops stale-default-model, keeps active-model
				return new Response(JSON.stringify({ models: [createCodexModel("active-model")] }), { status: 200 });
			});
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			// Active model is active-model (not the stale one)
			const ctx = { ui: { notify }, model: { id: "active-model", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				await waitForAsyncRefresh();

				await emit("session_start", { reason: "startup" }, ctx);

				// Warning must be emitted for the configured default model
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("stale-default-model"), "warning");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("does not log to console.warn when upstream catalog omits cached models", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [createModel("omitted-model"), createModel("active-model")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				return new Response(JSON.stringify({ models: [createCodexModel("active-model")] }), { status: 200 });
			});
			const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			const ctx = { ui: { notify }, model: { id: "active-model", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				await waitForAsyncRefresh();

				await emit("session_start", { reason: "startup" }, ctx);

				expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining("upstream catalog omitted"));
			} finally {
				fetchMock.mockRestore();
				warnMock.mockRestore();
			}
		});
	});

	it("aborts in-flight background refresh and ignores results on session_shutdown", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [createModel("initial-model")],
			});
			saveModelsCache(agentDir, cached, Date.now());

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
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				// Session shuts down while background refresh is in flight
				await emit("session_shutdown");

				// Background refresh eventually resolves
				releaseRemote(new Response(JSON.stringify({ models: [createCodexModel("late-model")] }), { status: 200 }));
				await waitForAsyncRefresh();

				// Disk cache must not have been overwritten by the aborted late refresh
				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models.find((m) => m.id === "late-model")).toBeUndefined();
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("schedules auto-recovery when stale models exist and retries on transient recovery failure", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Background refresh drops gemini
					return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
				}
				if (fetchCount === 2) {
					// First auto-recovery attempt fails with 503
					throw new Error("503 Service Unavailable");
				}
				// Second auto-recovery attempt succeeds with restored model
				return new Response(
					JSON.stringify({ models: [createCodexModel("gemini-3.8-flash-high"), createCodexModel("gpt-4o")] }),
					{ status: 200 },
				);
			});
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });
				await vi.advanceTimersByTimeAsync(100);

				expect(fetchCount).toBe(1);

				// Advance past first recovery delay (60s) -> triggers fetchCount 2 (failure)
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(2);

				// Advance past backoff retry delay -> triggers fetchCount 3 (success)
				await vi.advanceTimersByTimeAsync(100_000);
				expect(fetchCount).toBe(3);

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const restored = diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(restored).toBeDefined();
				expect(restored?.stale).toBe(false);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});

	it("stops auto-recovery without re-scheduling when context is stale after session replacement or reload", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				// Dropping gemini produces stale models
				return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
			});
			const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { pi, emit } = createPiMock();

			// Stale context proxy throws when accessing any property
			let isStale = false;
			const staleErrorMsg =
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
			const mockCtx = {
				ui: { notify: vi.fn() },
				get model() {
					if (isStale) throw new Error(staleErrorMsg);
					return { id: "gpt-4o", provider: "cliproxyapi" };
				},
			};

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, mockCtx);
				await vi.advanceTimersByTimeAsync(100);

				expect(fetchCount).toBe(1);

				// Mark context as stale (simulating reload or switchSession)
				isStale = true;

				// Advance past first recovery delay -> recovery executes
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(2);

				// Verify it did not log auto-recovery retry warning
				expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining("auto-recovery refresh failed"));
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
				warnMock.mockRestore();
			}
		});
	});

	it("stops auto-recovery without re-scheduling when ExtensionAPI is stale after session replacement or reload", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
			});
			const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { pi, emit } = createPiMock();

			let piIsStale = false;
			const staleErrorMsg =
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
			const origRegisterProvider = pi.registerProvider.bind(pi);
			pi.registerProvider = ((...args: Parameters<typeof origRegisterProvider>) => {
				if (piIsStale) throw new Error(staleErrorMsg);
				return origRegisterProvider(...args);
			}) as typeof origRegisterProvider;

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });
				await vi.advanceTimersByTimeAsync(100);

				expect(fetchCount).toBe(1);

				// Mark ExtensionAPI as stale
				piIsStale = true;

				// Advance past recovery delay -> recovery triggers, hits stale pi, and halts
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(2);

				expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining("will retry"));

				// Advance timers further: no subsequent retry should be scheduled
				await vi.advanceTimersByTimeAsync(200_000);
				expect(fetchCount).toBe(2);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
				warnMock.mockRestore();
			}
		});
	});

	it("triggers stale model warning and auto-recovery when startup fetches remotely due to Fast mode mismatch", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultModel: "cliproxyapi/gemini-3.8-flash-high" }),
				"utf8",
			);
			process.env.CLIPROXYAPI_FAST = "true";

			// Existing disk cache was generated with fastMode: false
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
				fastMode: false,
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Startup fetch drops gemini
					return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
				}
				// Auto-recovery refresh recovers gemini
				return new Response(
					JSON.stringify({
						models: [createCodexModel("gemini-3.8-flash-high"), createCodexModel("gpt-4o")],
					}),
					{ status: 200 },
				);
			});
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			const ctx = { ui: { notify }, model: { id: "gemini-3.8-flash-high", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, ctx);

				// Warning must be delivered
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("gemini-3.8-flash-high"), "warning");
				expect(fetchCount).toBe(1);

				// Advance past recovery delay (60s)
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(2);

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const restored = diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(restored).toBeDefined();
				expect(restored?.stale).toBe(false);
			} finally {
				delete process.env.CLIPROXYAPI_FAST;
				vi.useRealTimers();
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
			const stale = createMappedModels({
				models: [{ ...createModel("stale-refresh"), stale: true, staleSince: 1 }],
			});
			saveModelsCache(agentDir, stale, 1);

			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(() =>
					Promise.resolve(
						new Response(JSON.stringify({ models: [createCodexModel("refreshed", true)] }), { status: 200 }),
					),
				);
			const { pi, commands } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				const model = { id: "refreshed", provider: "cliproxyapi" } as Model<Api>;
				const ctx = { model, ui: { notify } } as unknown as ExtensionCommandContext;

				await refresh.handler("", ctx);

				expect(fetchMock).toHaveBeenCalledTimes(4);
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1 CLIProxyAPI models"), "info");

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
			const { pi, commands } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				const model = { id: "any", provider: "cliproxyapi" } as Model<Api>;
				const ctx = { model, ui: { notify } } as unknown as ExtensionCommandContext;

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

	it("schedules auto-recovery when login encounters stale models", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Login validates and fetches models, missing gemini
					return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
				}
				// Auto-recovery refresh recovers gemini
				return new Response(
					JSON.stringify({
						models: [createCodexModel("gemini-3.8-flash-high"), createCodexModel("gpt-4o")],
					}),
					{ status: 200 },
				);
			});
			const { pi } = createPiMock();

			try {
				await providerExtension(pi);
				const registerCalls = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls;
				const registerCall = registerCalls.find(([name, config]) => name === "cliproxyapi" && config.oauth?.login);
				expect(registerCall).toBeDefined();
				const oauth = registerCall![1].oauth;

				await oauth.login({
					onPrompt: async ({ message }: { message: string }) =>
						message.includes("URL") ? "http://127.0.0.1:8317" : "sk-test",
				});

				expect(fetchCount).toBe(1);
				const diskCacheAfterLogin = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const staleGemini = diskCacheAfterLogin?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(staleGemini?.stale).toBe(true);

				// Fast-forward past recovery delay (60s)
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(2);

				const diskCacheAfterRecovery = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const recoveredGemini = diskCacheAfterRecovery?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(recoveredGemini?.stale).toBe(false);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});

	it("restores auto-recovery task when login fails and is cancelled", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "valid-key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Startup background refresh drops gemini
					return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
				}
				if (fetchCount === 2) {
					// Login attempt returns 401 unauthorized
					return new Response(JSON.stringify({ error: "invalid key" }), { status: 401 });
				}
				// Auto-recovery refresh recovers gemini
				return new Response(
					JSON.stringify({
						models: [createCodexModel("gemini-3.8-flash-high"), createCodexModel("gpt-4o")],
					}),
					{ status: 200 },
				);
			});
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });
				await vi.advanceTimersByTimeAsync(100);

				// Background refresh ran (fetchCount: 1), gemini is stale, recovery scheduled
				expect(fetchCount).toBe(1);

				const registerCalls = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls;
				const registerCall = registerCalls.find(([name, config]) => name === "cliproxyapi" && config.oauth?.login);
				expect(registerCall).toBeDefined();
				const oauth = registerCall![1].oauth;

				let promptCount = 0;
				// Login fails on first attempt, then user cancels prompt on second attempt
				await expect(
					oauth.login({
						onPrompt: async ({ message }: { message: string }) => {
							promptCount += 1;
							if (promptCount <= 2) {
								return message.includes("URL") ? "http://127.0.0.1:8317" : "bad-key";
							}
							throw new Error("User cancelled login");
						},
						onProgress: vi.fn(),
					}),
				).rejects.toThrow("User cancelled login");

				expect(fetchCount).toBe(2);

				// Advance past recovery delay (60s)
				await vi.advanceTimersByTimeAsync(65_000);
				// The previous recovery was restored and fires successfully!
				expect(fetchCount).toBe(3);

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const restoredGemini = diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(restoredGemini?.stale).toBe(false);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});

	it("emits stale model warning on session_start when loading existing stale cache and background refresh fails", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [
					{ ...createModel("gemini-3.8-flash-high"), stale: true, staleSince: Date.now() - 1000 },
					createModel("gpt-4o"),
				],
			});
			saveModelsCache(agentDir, cached, Date.now() - 1000);

			// Background refresh fails with network error
			const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
			const { pi, emit } = createPiMock();
			const notify = vi.fn();
			const ctx = { ui: { notify }, model: { id: "gemini-3.8-flash-high", provider: "cliproxyapi" } };

			try {
				await providerExtension(pi);
				await waitForAsyncRefresh();

				// Session starts after background refresh has already failed
				await emit("session_start", { reason: "startup" }, ctx);

				// Warning must still be emitted from the cached stale state
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("gemini-3.8-flash-high"), "warning");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("restores recovery task when login is cancelled while a recovery request is in flight", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "valid-key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			let releaseRecovery!: (response: Response) => void;
			const recoveryPromise = new Promise<Response>((resolve) => {
				releaseRecovery = resolve;
			});

			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Startup background refresh drops gemini
					return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
				}
				if (fetchCount === 2) {
					// Auto-recovery request hangs in flight
					return recoveryPromise;
				}
				// Subsequent recovery after cancellation recovers gemini
				return new Response(
					JSON.stringify({
						models: [createCodexModel("gemini-3.8-flash-high"), createCodexModel("gpt-4o")],
					}),
					{ status: 200 },
				);
			});
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });
				await vi.advanceTimersByTimeAsync(100);

				// Fast-forward past first recovery delay (60s) -> fetchCount 2 (recovery request in-flight)
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(2);

				const registerCalls = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls;
				const registerCall = registerCalls.find(([name, config]) => name === "cliproxyapi" && config.oauth?.login);
				expect(registerCall).toBeDefined();
				const oauth = registerCall![1].oauth;

				// User initiates login while recovery is in-flight, but cancels prompt immediately
				await expect(
					oauth.login({
						onPrompt: async () => {
							throw new Error("Cancelled by user");
						},
						onProgress: vi.fn(),
					}),
				).rejects.toThrow("Cancelled by user");

				// Release the in-flight request (which aborts or completes with 503)
				releaseRecovery(new Response("{}", { status: 503 }));
				await vi.advanceTimersByTimeAsync(100);

				// Advance past restored recovery delay with backoff
				await vi.advanceTimersByTimeAsync(100_000);
				expect(fetchCount).toBeGreaterThanOrEqual(3);

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const restoredGemini = diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(restoredGemini?.stale).toBe(false);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});

	it("stops recovery and does not reuse deleted credentials when credentials are removed before timer fires", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "secret-to-be-deleted" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
			});
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });
				await vi.advanceTimersByTimeAsync(100);

				// Background refresh ran (fetchCount: 1), gemini is stale, recovery scheduled
				expect(fetchCount).toBe(1);

				// User logs out / credentials deleted
				rmSync(join(agentDir, CONFIG_FILE_NAME), { force: true });

				// Advance past recovery delay (60s)
				await vi.advanceTimersByTimeAsync(65_000);

				// Recovery should have stopped without sending requests with deleted credentials
				expect(fetchCount).toBe(1);

				// Ensure registerProvider was not called again after credentials were deleted
				const callsWithDeletedKey = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { apiKey?: string }]>
				).filter(([, config]) => config.apiKey === "secret-to-be-deleted");
				// Exactly 2 calls occurred during startup (initial cache load + startup background refresh)
				expect(callsWithDeletedKey.length).toBe(2);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});

	it("preserves auto-recovery scheduled during prompt wait when login subsequently fails and is cancelled", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "valid-key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			let releaseBackground!: (response: Response) => void;
			const backgroundPromise = new Promise<Response>((resolve) => {
				releaseBackground = resolve;
			});

			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Startup background refresh is in-flight
					return backgroundPromise;
				}
				if (fetchCount === 2) {
					// Login attempt fails with 401
					return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
				}
				// Auto-recovery refresh recovers gemini
				return new Response(
					JSON.stringify({
						models: [createCodexModel("gemini-3.8-flash-high"), createCodexModel("gpt-4o")],
					}),
					{ status: 200 },
				);
			});
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });

				const registerCalls = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls;
				const registerCall = registerCalls.find(([name, config]) => name === "cliproxyapi" && config.oauth?.login);
				expect(registerCall).toBeDefined();
				const oauth = registerCall![1].oauth;

				let promptCount = 0;
				// Start login while background refresh is in flight (no recovery scheduled yet)
				const loginPromise = oauth.login({
					onPrompt: async ({ message }: { message: string }) => {
						promptCount += 1;
						if (promptCount === 1) {
							// While waiting at the prompt, background refresh finishes and discovers gemini is missing!
							releaseBackground(
								new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 }),
							);
							await vi.advanceTimersByTimeAsync(100);
							return message.includes("URL") ? "http://127.0.0.1:8317" : "bad-key";
						}
						if (promptCount === 2) {
							return "bad-key";
						}
						throw new Error("Login cancelled after failure");
					},
					onProgress: vi.fn(),
				});

				await expect(loginPromise).rejects.toThrow("Login cancelled after failure");

				// Advance past recovery delay (60s)
				await vi.advanceTimersByTimeAsync(65_000);
				expect(fetchCount).toBe(3);

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				const restoredGemini = diskCache?.models.find((m) => m.id === "gemini-3.8-flash-high");
				expect(restoredGemini?.stale).toBe(false);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});

	it("does not restore recovery if session_shutdown occurred while login was in-flight", async () => {
		vi.useFakeTimers();
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "valid-key" });
			const cached = createMappedModels({
				models: [createModel("gemini-3.8-flash-high"), createModel("gpt-4o")],
			});
			saveModelsCache(agentDir, cached, Date.now());

			let fetchCount = 0;
			let releaseLogin!: (response: Response) => void;
			const loginPromise = new Promise<Response>((resolve) => {
				releaseLogin = resolve;
			});

			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).includes("models.dev")) {
					return new Response("{}", { status: 200 });
				}
				fetchCount += 1;
				if (fetchCount === 1) {
					// Startup background refresh drops gemini
					return new Response(JSON.stringify({ models: [createCodexModel("gpt-4o")] }), { status: 200 });
				}
				if (fetchCount === 2) {
					// Login fetch hangs in-flight
					return loginPromise;
				}
				return new Response("{}", { status: 200 });
			});
			const { pi, emit } = createPiMock();

			try {
				await providerExtension(pi);
				await emit("session_start", { reason: "startup" }, { ui: { notify: vi.fn() } });
				await vi.advanceTimersByTimeAsync(100);

				// Background refresh ran, recovery scheduled
				expect(fetchCount).toBe(1);

				const registerCalls = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls;
				const registerCall = registerCalls.find(([name, config]) => name === "cliproxyapi" && config.oauth?.login);
				expect(registerCall).toBeDefined();
				const oauth = registerCall![1].oauth;

				let promptCount = 0;
				const loginCall = oauth.login({
					onPrompt: async () => {
						promptCount += 1;
						if (promptCount === 1) return "http://127.0.0.1:8317";
						if (promptCount === 2) return "sk-test";
						throw new Error("Cancelled");
					},
					onProgress: vi.fn(),
				});

				// Let login initiate fetch (fetchCount 2)
				await vi.advanceTimersByTimeAsync(10);
				expect(fetchCount).toBe(2);

				// Session shuts down while login is in-flight
				await emit("session_shutdown");

				// Release login request (fails with 401)
				releaseLogin(new Response("{}", { status: 401 }));
				await expect(loginCall).rejects.toThrow();

				// Advance past recovery timer
				await vi.advanceTimersByTimeAsync(100_000);

				// No new recovery request should be made because session was shut down
				expect(fetchCount).toBe(2);
			} finally {
				vi.useRealTimers();
				fetchMock.mockRestore();
			}
		});
	});
});
