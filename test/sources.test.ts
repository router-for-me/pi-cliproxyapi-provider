import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelAccounts, loadMappedModels, toPiModel } from "../extensions/lib.ts";
import { type Account, parseAccounts, sourceLabel } from "../extensions/sources.ts";

const login = (provider: string, priority = 0): Account => ({ provider, kind: "oauth", priority });
const key = (provider: string, priority = 0, host?: string): Account => ({
	provider,
	kind: "apikey",
	priority,
	...(host ? { host } : {}),
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("where a model comes from, in words", () => {
	it("names the service and whether it is a subscription login or an API key", () => {
		expect(sourceLabel([login("claude")])).toBe("Anthropic sub");
		expect(sourceLabel([key("claude")])).toBe("Anthropic api");
		expect(sourceLabel([login("codex")])).toBe("OpenAI sub");
		expect(sourceLabel([login("devin")])).toBe("Devin sub");
		expect(sourceLabel([login("antigravity")])).toBe("Antigravity sub");
	});

	it("says nothing without credentials", () => {
		expect(sourceLabel([])).toBeUndefined();
	});

	it("puts lower priorities after 'fallback', naming a service again only when it changes", () => {
		expect(sourceLabel([login("claude", 5), login("claude", 3), key("claude", 1), key("claude", 1)])).toBe(
			"Anthropic sub, fallback api",
		);
		expect(sourceLabel([login("claude", 5), login("antigravity", 2)])).toBe(
			"Anthropic sub, fallback Antigravity sub",
		);
		expect(sourceLabel([login("claude", 5), login("antigravity", 2), key("claude", 1)])).toBe(
			"Anthropic sub, fallback Antigravity sub, Anthropic api",
		);
	});

	it("joins the credentials sharing the highest priority with 'or'", () => {
		expect(sourceLabel([login("claude"), key("claude")])).toBe("Anthropic sub or api");
		expect(sourceLabel([login("claude"), login("antigravity")])).toBe("Anthropic sub or Antigravity sub");
	});

	it("takes the highest priority wherever it is listed", () => {
		expect(sourceLabel([key("claude", 1), login("claude", 5)])).toBe("Anthropic sub, fallback api");
	});

	it("goes by the host an API key is sent to, whatever its entry is called", () => {
		expect(sourceLabel([key("openai-compatible-mine", 0, "openrouter.ai")])).toBe("OpenRouter api");
		expect(sourceLabel([key("codex", 0, "api.openai.com")])).toBe("OpenAI api");
		expect(sourceLabel([key("claude", 0, "llm.example.com")])).toBe("llm.example.com api");
		expect(sourceLabel([login("codex", 5), key("codex", 1, "api.openai.com")])).toBe("OpenAI sub, fallback api");
	});

	it("uses CLIProxyAPI's own name for a provider it does not know", () => {
		expect(sourceLabel([key("openai-compatible-mine")])).toBe("mine api");
		expect(sourceLabel([login("somelab")])).toBe("somelab sub");
	});

	it("keeps a kind it does not know as CLIProxyAPI wrote it", () => {
		expect(sourceLabel([{ provider: "claude", kind: "token", priority: 0 }])).toBe("Anthropic token");
	});
});

describe("parseAccounts", () => {
	it("reads the credentials of a model list entry and skips what is not one", () => {
		expect(
			parseAccounts([
				{ provider: "claude", kind: "oauth", priority: 5 },
				{ provider: "codex", kind: "apikey", host: "API.OpenAI.com" },
				{ provider: "claude" },
				"x",
				null,
			]),
		).toEqual([
			{ provider: "claude", kind: "oauth", priority: 5 },
			{ provider: "codex", kind: "apikey", priority: 0, host: "api.openai.com" },
		]);
		expect(parseAccounts(undefined)).toEqual([]);
		expect(parseAccounts({})).toEqual([]);
	});
});

describe("toPiModel with a source", () => {
	it("adds it to the name", () => {
		expect(toPiModel({ slug: "m1", display_name: "Model One" }, undefined, false, "Anthropic sub")?.name).toBe(
			"Model One · Anthropic sub",
		);
		expect(toPiModel({ slug: "m1" }, undefined, false, "Anthropic sub")?.name).toBe("m1 · Anthropic sub");
	});

	it("leaves the name alone without one", () => {
		expect(toPiModel({ slug: "m1", display_name: "Model One" })?.name).toBe("Model One");
	});
});

describe("model names from a CLIProxyAPI that lists its credentials", () => {
	const agentDir = () => mkdtempSync(join(tmpdir(), "pi-cpa-sources-"));

	function mockCpa(plainList: unknown, status = 200) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("client_version")) {
				return new Response(
					JSON.stringify({
						models: [
							{ slug: "model-a", display_name: "Model A" },
							{ slug: "model-b", display_name: "Model B" },
						],
					}),
				);
			}
			if (url.endsWith("/v1/models?include=accounts")) {
				return new Response(JSON.stringify(plainList), { status });
			}
			return new Response("{}");
		});
	}

	it("carry where each model comes from", async () => {
		mockCpa({
			data: [
				{
					id: "model-a",
					owned_by: "anthropic",
					accounts: [
						{ provider: "claude", kind: "oauth", priority: 5 },
						{ provider: "claude", kind: "apikey", priority: 1 },
					],
				},
				{ id: "model-b", owned_by: "openai" },
			],
		});
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir());
		expect(loaded.models.find((m) => m.id === "model-a")?.name).toBe("Model A · Anthropic sub, fallback api");
		expect(loaded.models.find((m) => m.id === "model-b")?.name).toBe("Model B");
	});

	it("stay as they are when CLIProxyAPI lists no credentials", async () => {
		mockCpa({
			data: [
				{ id: "model-a", owned_by: "anthropic" },
				{ id: "model-b", owned_by: "openai" },
			],
		});
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir());
		expect(loaded.models.map((m) => m.name)).toEqual(["Model A", "Model B"]);
	});

	it("stay as they are when the list can't be read", async () => {
		mockCpa({}, 500);
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir());
		expect(loaded.models.map((m) => m.name)).toEqual(["Model A", "Model B"]);
	});
});

describe("fetchModelAccounts", () => {
	it("asks for the credentials and reads them per model", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{
							id: "model-a",
							owned_by: "anthropic",
							accounts: [{ provider: "claude", kind: "oauth", priority: 5 }],
						},
						{ id: "model-b", owned_by: "openai" },
					],
				}),
			),
		);
		const accounts = await fetchModelAccounts("http://cpa/v1/models", "key");
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://cpa/v1/models?include=accounts");
		expect(accounts.get("model-a")).toEqual([{ provider: "claude", kind: "oauth", priority: 5 }]);
		expect(accounts.has("model-b")).toBe(false);
	});

	it("is empty on any failure", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
		expect((await fetchModelAccounts("http://cpa/v1/models", "key")).size).toBe(0);
	});
});
