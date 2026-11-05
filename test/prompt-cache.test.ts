import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectResponseUsages, isCacheNotWorking, type ResponseUsage } from "../extensions/cache-guard.ts";
import {
	buildPromptCacheCatalogFromModels,
	buildPromptCacheCatalogFromModelsDevV2,
	type CodexClientModel,
	emptyPromptCacheCatalog,
	fetchModelsDevPromptCacheCatalog,
	loadBuiltinPromptCacheCatalog,
	type PromptCacheSources,
	parseCacheTtlSeconds,
	resolvePromptCache,
	toPiModel,
	withReportedCacheLifetime,
} from "../extensions/lib.ts";

// Shapes copied from models.dev experimental v2 (capabilities.cache).
const MODELS_DEV_V2 = {
	anthropic: {
		id: "anthropic",
		models: {
			"claude-opus-5-5": { capabilities: { cache: { explicit: { ttl: ["5m", "1h"], max_breakpoints: 4 } } } },
			"claude-sonnet-5-5": { capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } },
		},
	},
	openai: {
		id: "openai",
		models: {
			"gpt-6.1-sol": { capabilities: { cache: { implicit: { min_tokens: 1024 }, explicit: { ttl: ["30m"] } } } },
		},
	},
	deepseek: {
		id: "deepseek",
		models: { "deepseek-v4-pro": { capabilities: { cache: { implicit: true } } } },
	},
	openrouter: {
		id: "openrouter",
		models: {
			"anthropic/claude-opus-5.5": { capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } },
			"vendor-x/odd-model": { capabilities: { cache: { explicit: { ttl: ["2h"] } } } },
		},
	},
	broken: { id: "broken", models: { "no-caps": {}, "weird-cache": { capabilities: { cache: "yes" } } } },
};

function sources(builtin = emptyPromptCacheCatalog()): PromptCacheSources {
	return { builtin, modelsDev: buildPromptCacheCatalogFromModelsDevV2(MODELS_DEV_V2) };
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("parseCacheTtlSeconds", () => {
	it.each([
		["5m", 300],
		["1h", 3600],
		["30m", 1800],
		["300s", 300],
		["24h", 86400],
		[" 1H ", 3600],
		[300, 300],
		["300", 300],
	])("%s → %s", (value, seconds) => {
		expect(parseCacheTtlSeconds(value)).toBe(seconds);
	});

	it.each([["forever"], [""], ["-5m"], [0], [Number.NaN], [null], [{}]])("rejects %s", (value) => {
		expect(parseCacheTtlSeconds(value)).toBeUndefined();
	});
});

describe("resolvePromptCache", () => {
	it("gives Claude ids in every form the shortest explicit lifetime", () => {
		for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "anthropic/claude-opus-5.5", "Claude-Opus-5.5"]) {
			expect(resolvePromptCache(id, sources())).toEqual({ short: 300 });
		}
	});

	it("uses the lowest explicit lifetime for GPT-6.1", () => {
		expect(resolvePromptCache("gpt-6.1-sol", sources())).toEqual({ short: 1800 });
		expect(resolvePromptCache("openai/gpt-6.1-sol", sources())).toEqual({ short: 1800 });
	});

	it("declares nothing for models with only implicit caching or no data", () => {
		expect(resolvePromptCache("deepseek-v4-pro", sources())).toBeUndefined();
		expect(resolvePromptCache("muse-wonder-1.0", sources())).toBeUndefined();
		expect(resolvePromptCache("no-caps", sources())).toBeUndefined();
		expect(resolvePromptCache("weird-cache", sources())).toBeUndefined();
	});

	it("takes the shorter of pi's catalog and models.dev", () => {
		const builtin = buildPromptCacheCatalogFromModels([
			{ provider: "anthropic", id: "claude-opus-5-5", promptCache: { short: 240, long: 3600 } },
		]);
		expect(resolvePromptCache("claude-opus-5-5", sources(builtin))).toEqual({ short: 240 });
	});

	it("falls back to pi's catalog when models.dev is empty", () => {
		const builtin = buildPromptCacheCatalogFromModels([
			{ provider: "anthropic", id: "claude-haiku-5-5", promptCache: { short: 300, long: 3600 } },
		]);
		expect(resolvePromptCache("claude-haiku-5-5", { builtin, modelsDev: emptyPromptCacheCatalog() })).toEqual({
			short: 300,
		});
	});

	it("never sets the long tier", () => {
		expect(resolvePromptCache("claude-opus-5-5", sources())?.long).toBeUndefined();
	});

	it("survives payloads of the wrong shape", () => {
		for (const payload of [null, "x", [], { a: 1 }, { a: { models: [] } }]) {
			expect(buildPromptCacheCatalogFromModelsDevV2(payload).normalized.size).toBe(0);
		}
	});
});

describe("toPiModel promptCache", () => {
	const model = (id: string): CodexClientModel => ({ slug: id, display_name: id });

	it("adds promptCache when a lifetime is known", () => {
		expect(toPiModel(model("claude-opus-5-5"), undefined, false, sources())?.promptCache).toEqual({ short: 300 });
	});

	it("omits promptCache when no lifetime is known or no sources are given", () => {
		expect(toPiModel(model("deepseek-v4-pro"), undefined, false, sources())).not.toHaveProperty("promptCache");
		expect(toPiModel(model("claude-opus-5-5"))).not.toHaveProperty("promptCache");
	});
});

describe("reported cache lifetime", () => {
	it("replaces the catalog's default tier and keeps its long tier", () => {
		expect(withReportedCacheLifetime({ short: 300, long: 3600 }, 3600)).toEqual({ short: 3600, long: 3600 });
		expect(withReportedCacheLifetime(undefined, 1800)).toEqual({ short: 1800 });
	});

	it("ignores missing or invalid values", () => {
		expect(withReportedCacheLifetime({ short: 300 }, undefined)).toEqual({ short: 300 });
		expect(withReportedCacheLifetime({ short: 300 }, 0)).toEqual({ short: 300 });
		expect(withReportedCacheLifetime(undefined, "3600")).toBeUndefined();
	});

	it("uses prompt_cache_ttl_seconds from CLIProxyAPI's model list", () => {
		const model: CodexClientModel = { slug: "subs/claude-opus-5-5", prompt_cache_ttl_seconds: 3600 };
		expect(toPiModel(model)?.promptCache).toEqual({ short: 3600 });
		expect(toPiModel(model, undefined, false, sources())?.promptCache).toEqual({ short: 3600 });
		expect(toPiModel({ slug: "claude-opus-5-5" }, undefined, false, sources())?.promptCache).toEqual({ short: 300 });
	});
});

describe("fetchModelsDevPromptCacheCatalog", () => {
	function agentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-cliproxy-pc-"));
		tempDirs.push(dir);
		return dir;
	}

	it("downloads, caches for 24 h, and reuses a stale copy when models.dev is down", async () => {
		const dir = agentDir();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify(MODELS_DEV_V2), { status: 200 }));
		const first = await fetchModelsDevPromptCacheCatalog(dir);
		expect(resolvePromptCache("claude-opus-5-5", { builtin: emptyPromptCacheCatalog(), modelsDev: first })).toEqual({
			short: 300,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Fresh cache: no request.
		const cached = await fetchModelsDevPromptCacheCatalog(dir);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(resolvePromptCache("gpt-6.1-sol", { builtin: emptyPromptCacheCatalog(), modelsDev: cached })).toEqual({
			short: 1800,
		});
		// Implicit-only entries keep "no lifetime" after a round-trip through the file.
		expect(resolvePromptCache("deepseek-v4-pro", { builtin: emptyPromptCacheCatalog(), modelsDev: cached })).toBe(
			undefined,
		);

		// Forced refresh with models.dev down: stale copy.
		fetchMock.mockRejectedValueOnce(new Error("offline"));
		const stale = await fetchModelsDevPromptCacheCatalog(dir, true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(resolvePromptCache("claude-opus-5-5", { builtin: emptyPromptCacheCatalog(), modelsDev: stale })).toEqual({
			short: 300,
		});
	});

	it("returns an empty catalog when models.dev is down and nothing is cached", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		expect((await fetchModelsDevPromptCacheCatalog(agentDir())).normalized.size).toBe(0);
	});
});

describe("loadBuiltinPromptCacheCatalog", () => {
	it("reads Claude lifetimes from pi's built-in catalog", async () => {
		const builtin = await loadBuiltinPromptCacheCatalog();
		expect(resolvePromptCache("claude-haiku-4-5", { builtin, modelsDev: emptyPromptCacheCatalog() })).toEqual({
			short: 300,
		});
	});
});

describe("cache warming guard", () => {
	const t0 = Date.parse("2026-11-05T10:00:00Z");
	const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
	const turn = (seconds: number, input: number, cacheRead: number, cacheWrite = 0, provider = "cliproxyapi") => ({
		type: "message",
		timestamp: at(seconds),
		message: { role: "assistant", provider, usage: { input, cacheRead, cacheWrite }, stopReason: "stop" },
	});
	const warm = (seconds: number, input: number, cacheRead: number, provider = "cliproxyapi") => ({
		type: "usage",
		kind: "cache_warm",
		provider,
		timestamp: at(seconds),
		usage: { input, cacheRead, cacheWrite: 0 },
	});
	const user = (seconds: number) => ({ type: "message", timestamp: at(seconds), message: { role: "user" } });
	const decide = (branch: unknown[], lifetimeMs = 300_000) =>
		isCacheNotWorking(collectResponseUsages(branch as never, "cliproxyapi"), lifetimeMs);

	it("keeps warming a route that caches", () => {
		const branch = [user(0), turn(5, 50_000, 0, 0), user(60), turn(65, 800, 50_000), warm(335, 2, 50_800)];
		expect(decide(branch)).toBe(false);
	});

	it("allows the first warm-up after the first turn (cache just written)", () => {
		expect(decide([user(0), turn(5, 50_000, 0)])).toBe(false);
	});

	it("stops after one warm-up that read nothing", () => {
		expect(decide([user(0), turn(5, 50_000, 0), warm(275, 50_002, 0)])).toBe(true);
	});

	it("stops when a turn within the lifetime read nothing", () => {
		expect(decide([user(0), turn(5, 50_000, 0), user(30), turn(35, 50_900, 0)])).toBe(true);
	});

	it("ignores a miss after a gap longer than the lifetime (plain expiry)", () => {
		expect(decide([user(0), turn(5, 50_000, 0), user(900), turn(905, 50_900, 0)])).toBe(false);
	});

	it("keeps warming when the provider caches only part of the prompt", () => {
		expect(decide([turn(5, 50_000, 0), warm(275, 25_000, 25_000)])).toBe(false);
	});

	it("starts over after a model change or compaction", () => {
		const branch = [turn(5, 50_000, 0), { type: "model_change", timestamp: at(10) }, turn(20, 30_000, 0)];
		expect(decide(branch)).toBe(false);
		const compacted = [turn(5, 50_000, 0), { type: "compaction", timestamp: at(10) }, turn(20, 8_000, 0)];
		expect(decide(compacted)).toBe(false);
	});

	it("ignores other providers, errors and missing usage", () => {
		const branch = [
			turn(5, 50_000, 0),
			turn(10, 40_000, 0, 0, "anthropic"),
			{
				type: "message",
				timestamp: at(20),
				message: { role: "assistant", provider: "cliproxyapi", stopReason: "error" },
			},
		];
		expect(decide(branch)).toBe(false);
		const zero: ResponseUsage[] = [
			{ input: 0, cacheRead: 0, cacheWrite: 0, at: t0 },
			{ input: 0, cacheRead: 0, cacheWrite: 0, at: t0 + 1000 },
		];
		expect(isCacheNotWorking(zero, 300_000)).toBe(false);
	});
});
