import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	fetchModelsDevCostMap,
	loadMappedModels,
	loadModelsCache,
	resolveMappedModels,
	toPiModel,
} from "../extensions/lib.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-capabilities-"));
	tempDirs.push(dir);
	return dir;
}

function response(providers: Record<string, unknown>): Response {
	return new Response(JSON.stringify(providers), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function catalog(providers: Record<string, unknown>) {
	const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(providers));
	try {
		return await fetchModelsDevCostMap(tempAgentDir(), true);
	} finally {
		fetchMock.mockRestore();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("canonical model capability resolution", () => {
	it("replaces CLIProxy's synthetic 272K template for Kimi K3", async () => {
		const canonical = await catalog({
			moonshotai: {
				models: {
					"kimi-k3": {
						limit: { context: 1_048_576, output: 131_072 },
						cost: { input: 3, output: 15 },
					},
				},
			},
			neon: {
				models: {
					"kimi-k3": {
						limit: { context: 1_048_576, output: 65_536 },
						cost: { input: 3, output: 15 },
					},
				},
			},
		});

		const model = toPiModel(
			{
				slug: "kimi-k3",
				context_window: 272_000,
				max_context_window: 272_000,
			},
			canonical,
		);

		expect(model).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536 });
	});

	it("prefers explicit non-template server capabilities", async () => {
		const canonical = await catalog({
			moonshotai: {
				models: {
					"kimi-k3": { limit: { context: 1_048_576, output: 65_536 } },
				},
			},
		});

		const model = toPiModel(
			{
				slug: "kimi-k3",
				context_window: 524_288,
				max_completion_tokens: 32_768,
			},
			canonical,
		);

		expect(model).toMatchObject({ contextWindow: 524_288, maxTokens: 32_768 });
	});

	it("preserves a 272K server limit backed by a canonical context price tier", async () => {
		const canonical = await catalog({
			openai: {
				models: {
					"gpt-5.6-sol": {
						limit: { context: 1_050_000, output: 128_000 },
						cost: {
							input: 5,
							output: 30,
							tiers: [{ input: 10, output: 45, tier: { type: "context", size: 272_000 } }],
						},
					},
				},
			},
		});

		const model = toPiModel(
			{
				slug: "gpt-5.6-sol",
				context_window: 272_000,
				max_context_window: 272_000,
			},
			canonical,
		);

		expect(model).toMatchObject({ contextWindow: 272_000, maxTokens: 128_000 });
	});

	it("consumes the server max_tokens field", () => {
		const model = toPiModel({ slug: "server-model", context_window: 200_000, max_tokens: 40_000 });
		expect(model).toMatchObject({ contextWindow: 200_000, maxTokens: 40_000 });
	});

	it("fills both limits from the canonical catalog when the server omits them", async () => {
		const canonical = await catalog({
			anthropic: {
				models: {
					"claude-example": { limit: { context: 300_000, output: 24_000 } },
				},
			},
		});

		expect(toPiModel({ slug: "claude-example" }, canonical)).toMatchObject({
			contextWindow: 300_000,
			maxTokens: 24_000,
		});
	});

	it("uses the existing explicit alias layer for canonical capabilities", async () => {
		const canonical = await catalog({
			google: {
				models: {
					"gemini-3.1-pro-preview": { limit: { context: 1_048_576, output: 65_536 } },
				},
			},
		});

		expect(toPiModel({ slug: "gemini-pro-agent" }, canonical)).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});
	});

	it("fails closed for unknown models and does not trust the 272K template", async () => {
		const canonical = await catalog({
			moonshotai: {
				models: {
					"kimi-k3": { limit: { context: 1_048_576, output: 65_536 } },
				},
			},
		});

		const model = toPiModel(
			{
				slug: "kimi-k3-lookalike",
				context_window: 272_000,
				max_context_window: 272_000,
			},
			canonical,
		);

		expect(model).toMatchObject({
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	});

	it("uses safe defaults when no canonical catalog is available", () => {
		const model = toPiModel({
			slug: "unknown-model",
			context_window: 272_000,
			max_context_window: 272_000,
		});
		expect(model).toMatchObject({ contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS });
	});

	it("retains stale canonical capabilities when catalog refresh is unavailable", async () => {
		const agentDir = tempAgentDir();
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(
			response({
				moonshotai: {
					models: {
						"kimi-k3": { limit: { context: 1_048_576, output: 65_536 } },
					},
				},
			}),
		);
		await fetchModelsDevCostMap(agentDir);
		fetchMock.mockRejectedValueOnce(new Error("catalog offline"));

		const stale = await fetchModelsDevCostMap(agentDir, true);
		expect(toPiModel({ slug: "kimi-k3", context_window: 272_000, max_context_window: 272_000 }, stale)).toMatchObject(
			{ contextWindow: 1_048_576, maxTokens: 65_536 },
		);
	});

	it("writes resolved capabilities through the mapped-model cache round trip", async () => {
		const agentDir = tempAgentDir();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).includes("models.dev")) {
				return response({
					moonshotai: {
						models: {
							"kimi-k3": {
								limit: { context: 1_048_576, output: 65_536 },
								cost: { input: 3, output: 15 },
							},
						},
					},
				});
			}
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "kimi-k3",
							display_name: "Kimi K3",
							context_window: 272_000,
							max_context_window: 272_000,
						},
					],
				}),
				{ status: 200 },
			);
		});

		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir);
		expect(loaded.models[0]).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536 });

		await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", {
			forceRefresh: true,
			fastMode: false,
		});
		const cached = loadModelsCache(agentDir, "http://127.0.0.1:8317");
		expect(cached?.models[0]).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536 });
	});
});
