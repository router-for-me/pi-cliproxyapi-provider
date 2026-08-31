import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AUTH_FILE_NAME,
	buildInputModalities,
	buildThinkingLevelMap,
	CONFIG_FILE_NAME,
	type CodexClientModel,
	DEFAULT_BASE_URL,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	decodeRefreshMeta,
	encodeRefreshMeta,
	extractReasoningEfforts,
	fetchModelsDevCostMap,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	ModelsHttpError,
	matchModelCost,
	parseBooleanSetting,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	saveConfigFile,
	supportsFastServiceTier,
	toPiModel,
	ZERO_COST,
} from "../extensions/lib.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("firstNonEmpty", () => {
	it("returns the first non-empty trimmed string", () => {
		expect(firstNonEmpty("  ", undefined, null, " alpha ", "beta")).toBe("alpha");
	});

	it("returns undefined when all values are empty", () => {
		expect(firstNonEmpty("", "   ", undefined, null)).toBeUndefined();
	});
});

describe("resolveEndpoints", () => {
	it("normalizes host:port input", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317");
		expect(result).toEqual({
			inferenceBaseUrl: "http://127.0.0.1:8317/backend-api/",
			modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=pi",
			rootOrigin: "http://127.0.0.1:8317",
		});
	});

	it("keeps /backend-api for inference", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317/backend-api");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("rewrites /v1 to /backend-api for inference", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317/v1");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("adds http scheme when missing", () => {
		const result = resolveEndpoints("127.0.0.1:8317");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("throws on empty baseUrl", () => {
		expect(() => resolveEndpoints("   ")).toThrow(/baseUrl is empty/);
	});
});

describe("refresh meta codec", () => {
	it("round-trips baseUrl metadata", () => {
		const encoded = encodeRefreshMeta("http://127.0.0.1:8317");
		expect(decodeRefreshMeta(encoded)).toEqual({ baseUrl: "http://127.0.0.1:8317" });
	});

	it("returns null for invalid or empty refresh tokens", () => {
		expect(decodeRefreshMeta(undefined)).toBeNull();
		expect(decodeRefreshMeta("")).toBeNull();
		expect(decodeRefreshMeta("not-json")).toBeNull();
		expect(decodeRefreshMeta(JSON.stringify({ foo: 1 }))).toBeNull();
	});
});

describe("model mapping helpers", () => {
	it("extracts unique reasoning efforts from objects and strings", () => {
		expect(
			extractReasoningEfforts({
				supported_reasoning_levels: [{ effort: "High" }, { effort: "high" }, { effort: "" }],
			}),
		).toEqual(["high"]);
		expect(
			extractReasoningEfforts({
				supported_reasoning_levels: ["Low", "low", ""],
			}),
		).toEqual(["low"]);
	});

	it("builds thinking level map with unsupported levels as null", () => {
		expect(buildThinkingLevelMap([])).toBeUndefined();
		expect(buildThinkingLevelMap(["none", "medium", "high"])).toMatchObject({
			off: "none",
			minimal: null,
			low: null,
			medium: "medium",
			high: "high",
			xhigh: null,
		});
	});

	it("builds input modalities and always includes text", () => {
		expect(buildInputModalities({ input_modalities: ["image", "IMAGE", "audio"] })).toEqual(["text", "image"]);
		expect(buildInputModalities({})).toEqual(["text"]);
	});

	it("detects Fast support from any non-empty service_tiers array", () => {
		expect(supportsFastServiceTier({ service_tiers: [{ id: "priority", name: "Fast" }] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: ["PRIORITY"] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [{ id: "flex" }] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [null] } as unknown as CodexClientModel)).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [] })).toBe(false);
	});

	it("ignores additional_speed_tiers and malformed service_tiers values", () => {
		expect(supportsFastServiceTier({ additional_speed_tiers: ["FAST"] })).toBe(false);
		expect(supportsFastServiceTier({ service_tiers: [], additional_speed_tiers: ["FAST"] })).toBe(false);
		expect(supportsFastServiceTier({ service_tiers: {} } as unknown as CodexClientModel)).toBe(false);
	});

	it("maps codex catalog entries to pi models", () => {
		const model = toPiModel({
			slug: "gpt-5",
			display_name: "GPT-5",
			context_window: 200000,
			input_modalities: ["text", "image"],
			supported_reasoning_levels: [{ effort: "high" }, { effort: "none" }],
		});

		expect(model).toEqual({
			id: "gpt-5",
			name: "GPT-5",
			reasoning: true,
			input: ["text", "image"],
			cost: { ...ZERO_COST },
			contextWindow: 200000,
			maxTokens: DEFAULT_MAX_TOKENS,
			thinkingLevelMap: buildThinkingLevelMap(["high", "none"]),
		});
	});

	it("maps max_tokens from codex catalog entries", () => {
		const model = toPiModel({ id: "gpt-5.6-sol", max_tokens: 128000 });

		expect(model?.maxTokens).toBe(128000);
	});

	it("maps alternative output-token fields in priority order", () => {
		const fromOutputTokens = toPiModel({
			id: "claude-sonnet-5",
			max_output_tokens: 128000,
		});
		const fromCompletionTokens = toPiModel({
			id: "gpt-5-mini",
			max_completion_tokens: 32768,
		});
		const preferred = toPiModel({
			id: "custom-model",
			max_tokens: 128000,
			max_output_tokens: 64000,
			max_completion_tokens: 32000,
		});

		expect(fromOutputTokens?.maxTokens).toBe(128000);
		expect(fromCompletionTokens?.maxTokens).toBe(32768);
		expect(preferred?.maxTokens).toBe(128000);
	});

	it("falls back when output-token metadata is not positive and finite", () => {
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(toPiModel({ id: "invalid-limit", max_tokens: value })?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
		}
	});

	it("skips hide visibility and missing ids", () => {
		expect(toPiModel({ slug: "x", visibility: "hide" })).toBeNull();
		expect(toPiModel({ display_name: "no-id" })).toBeNull();
	});

	it("falls back to default context window", () => {
		const model = toPiModel({ id: "m1" });
		expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(model?.reasoning).toBe(false);
	});
});

describe("models.dev cost mapping", () => {
	it("uses canonical provider prices, preserves context tiers, and reads Fast mode costs", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					openai: {
						models: {
							"gpt-5.6-sol": {
								cost: {
									input: 5,
									output: 30,
									cache_read: 0.5,
									cache_write: 6.25,
									tiers: [
										{
											input: 10,
											output: 45,
											cache_read: 1,
											cache_write: 12.5,
											tier: { type: "context", size: 272000 },
										},
									],
									// This compatibility field must not create a duplicate 200k tier.
									context_over_200k: { input: 10, output: 45, cache_read: 1, cache_write: 12.5 },
								},
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
					xpersona: {
						models: {
							"gpt-5.6-sol": { cost: { input: 1.5, output: 12, cache_read: 0.15 } },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		try {
			const catalog = await fetchModelsDevCostMap(tempAgentDir(), true);
			expect(matchModelCost("gpt-5.6-sol", catalog)).toEqual({
				input: 5,
				output: 30,
				cacheRead: 0.5,
				cacheWrite: 6.25,
				tiers: [
					{
						input: 10,
						output: 45,
						cacheRead: 1,
						cacheWrite: 12.5,
						inputTokensAbove: 272000,
					},
				],
			});
			expect(matchModelCost("gpt-5.6-sol", catalog, true)).toEqual({
				input: 10,
				output: 60,
				cacheRead: 1,
				cacheWrite: 12.5,
			});
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("resolves confirmed proxy aliases to canonical model prices", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					google: {
						models: {
							"gemini-3.1-pro-preview": {
								cost: {
									input: 2,
									output: 12,
									cache_read: 0.2,
									tiers: [{ input: 4, output: 18, tier: { type: "context", size: 200000 } }],
								},
								experimental: { modes: { fast: { cost: { input: 4, output: 24, cache_read: 0.4 } } } },
							},
							"gemini-3.5-flash": { cost: { input: 1.5, output: 9, cache_read: 0.15 } },
							"gemini-3.6-flash": { cost: { input: 1.5, output: 7.5, cache_read: 0.15 } },
						},
					},
					xai: {
						models: {
							"grok-4.3": {
								cost: {
									input: 1.25,
									output: 2.5,
									tiers: [{ input: 2.5, output: 5, tier: { type: "context", size: 200000 } }],
								},
							},
							"xai/grok-3-mini": { cost: { input: 0.3, output: 0.5 } },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		try {
			const catalog = await fetchModelsDevCostMap(tempAgentDir(), true);
			expect(matchModelCost("gemini-pro-agent", catalog)).toMatchObject({ input: 2, output: 12 });
			expect(matchModelCost("gemini-pro-agent", catalog, true)).toMatchObject({ input: 4, output: 24 });
			expect(matchModelCost("gemini-3.1-pro-low", catalog).input).toBe(2);
			expect(matchModelCost("gemini-3.6-flash-high", catalog).output).toBe(7.5);
			expect(matchModelCost("gemini-3-flash-agent", catalog).output).toBe(9);
			expect(matchModelCost("grok-composer-2.5-fast", catalog).tiers?.[0]?.inputTokensAbove).toBe(200000);
			expect(matchModelCost("grok-3-mini", catalog)).toEqual({
				input: 0.3,
				output: 0.5,
				cacheRead: 0,
				cacheWrite: 0,
			});
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("caches models.dev payload to disk and serves subsequent calls from cache", async () => {
		const tempDir = tempAgentDir();
		let fetchCount = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({
					openai: {
						models: {
							"gpt-5.6-sol": { cost: { input: 5, output: 30 } },
						},
					},
				}),
				{ status: 200 },
			);
		});

		try {
			const catalog1 = await fetchModelsDevCostMap(tempDir);
			expect(fetchCount).toBe(1);
			expect(matchModelCost("gpt-5.6-sol", catalog1).input).toBe(5);

			// Second call within TTL should read from cache without hitting network
			const catalog2 = await fetchModelsDevCostMap(tempDir);
			expect(fetchCount).toBe(1);
			expect(matchModelCost("gpt-5.6-sol", catalog2).input).toBe(5);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("falls back to stale disk cache when network request fails", async () => {
		const tempDir = tempAgentDir();
		let shouldFail = false;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			if (shouldFail) {
				throw new Error("Network offline");
			}
			return new Response(
				JSON.stringify({
					openai: {
						models: {
							"gpt-5.6-sol": { cost: { input: 5, output: 30 } },
						},
					},
				}),
				{ status: 200 },
			);
		});

		try {
			await fetchModelsDevCostMap(tempDir);
			shouldFail = true;

			// Force refresh while offline should return stale cache instead of empty catalog
			const catalog = await fetchModelsDevCostMap(tempDir, true);
			expect(matchModelCost("gpt-5.6-sol", catalog).input).toBe(5);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe("ModelsHttpError", () => {
	it("detects unauthorized status", () => {
		const unauthorized = new ModelsHttpError(401, "Unauthorized", "nope");
		const forbidden = new ModelsHttpError(403, "Forbidden", "");
		expect(isUnauthorizedModelsError(unauthorized)).toBe(true);
		expect(isUnauthorizedModelsError(forbidden)).toBe(false);
		expect(isUnauthorizedModelsError(new Error("401"))).toBe(false);
		expect(unauthorized.message).toContain("401");
	});
});

describe("config and auth file helpers", () => {
	it("loads empty config when file is missing", () => {
		const agentDir = tempAgentDir();
		expect(loadConfigFile(agentDir)).toEqual({});
	});

	it("saves and merges config file", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { baseUrl: "http://a", apiKey: "k1", fast: true });
		saveConfigFile(agentDir, { apiKey: "k2", providerName: "CPA" });

		const loaded = loadConfigFile(agentDir);
		expect(loaded).toEqual({
			baseUrl: "http://a",
			apiKey: "k2",
			providerName: "CPA",
			fast: true,
		});

		const raw = readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("does not overwrite malformed or structurally invalid config files", () => {
		const agentDir = tempAgentDir();
		const configPath = join(agentDir, CONFIG_FILE_NAME);

		for (const invalid of ["{not-json\n", "null\n", "[]\n", '"invalid"\n']) {
			writeFileSync(configPath, invalid, "utf8");
			expect(() => saveConfigFile(agentDir, { fast: true })).toThrow();
			expect(readFileSync(configPath, "utf8")).toBe(invalid);
		}
	});

	it("loads oauth auth connection metadata", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, AUTH_FILE_NAME),
			JSON.stringify({
				cliproxyapi: {
					type: "oauth",
					access: "sk-test",
					refresh: encodeRefreshMeta("http://127.0.0.1:8317"),
				},
			}),
			"utf8",
		);

		expect(loadAuthConnection(agentDir, "cliproxyapi")).toEqual({
			apiKey: "sk-test",
			baseUrl: "http://127.0.0.1:8317",
		});
	});

	it("loads api_key auth connection", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, AUTH_FILE_NAME),
			JSON.stringify({
				cliproxyapi: {
					type: "api_key",
					key: "plain-key",
				},
			}),
			"utf8",
		);

		expect(loadAuthConnection(agentDir, "cliproxyapi")).toEqual({
			apiKey: "plain-key",
		});
	});

	it("parses Fast boolean settings", () => {
		for (const value of ["true", "1", "yes", "ON"]) {
			expect(parseBooleanSetting(value)).toBe(true);
		}
		for (const value of ["false", "0", "no", "OFF"]) {
			expect(parseBooleanSetting(value)).toBe(false);
		}
		expect(parseBooleanSetting("sometimes")).toBeUndefined();
	});

	it("resolves Fast default from config with env precedence", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { fast: true });
		const previous = process.env.CLIPROXYAPI_FAST;
		try {
			delete process.env.CLIPROXYAPI_FAST;
			expect(resolveFastDefault(agentDir)).toBe(true);
			process.env.CLIPROXYAPI_FAST = "off";
			expect(resolveFastDefault(agentDir)).toBe(false);
			process.env.CLIPROXYAPI_FAST = "invalid";
			expect(() => resolveFastDefault(agentDir)).toThrow(/CLIPROXYAPI_FAST/);
		} finally {
			if (previous === undefined) {
				delete process.env.CLIPROXYAPI_FAST;
			} else {
				process.env.CLIPROXYAPI_FAST = previous;
			}
		}
	});

	it("resolves identity defaults", () => {
		const agentDir = tempAgentDir();
		const identity = resolveIdentity(agentDir);
		expect(identity).toEqual({
			providerId: DEFAULT_PROVIDER_ID,
			providerName: DEFAULT_PROVIDER_NAME,
		});
		expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:8317");
	});
});
