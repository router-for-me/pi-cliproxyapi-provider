import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ANTHROPIC_MESSAGES_API,
	buildClaudeFormatCatalog,
	type CodexClientModel,
	claudeFormatFor,
	claudeMessagesMode,
	fetchModelOwners,
	loadBuiltinClaudeFormatCatalog,
	loadMappedModels,
	reportedMaxTokens,
	resolveClaudeMessagesDefault,
	toPiModel,
} from "../extensions/lib.ts";

const CATALOG = buildClaudeFormatCatalog([
	{
		id: "claude-opus-5-5",
		reasoning: true,
		compat: { forceAdaptiveThinking: true, supportsTemperature: false },
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		promptCache: { short: 300, long: 3600 },
	},
]);

const tempDirs: string[] = [];
function agentDir(config?: object): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxy-cm-"));
	tempDirs.push(dir);
	if (config) writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify(config));
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	delete process.env.CLIPROXYAPI_CLAUDE_MESSAGES;
});

describe("resolveClaudeMessagesDefault", () => {
	it("defaults to auto and reads cliproxyapi.json", () => {
		expect(resolveClaudeMessagesDefault(agentDir())).toBe("auto");
		expect(resolveClaudeMessagesDefault(agentDir({ claudeMessages: "auto" }))).toBe("auto");
		expect(resolveClaudeMessagesDefault(agentDir({ claudeMessages: true }))).toBe("on");
		expect(resolveClaudeMessagesDefault(agentDir({ claudeMessages: false }))).toBe("off");
	});

	it("lets the environment win and rejects bad values", () => {
		process.env.CLIPROXYAPI_CLAUDE_MESSAGES = "off";
		expect(resolveClaudeMessagesDefault(agentDir({ claudeMessages: true }))).toBe("off");
		process.env.CLIPROXYAPI_CLAUDE_MESSAGES = "1";
		expect(resolveClaudeMessagesDefault(agentDir({ claudeMessages: false }))).toBe("on");
		process.env.CLIPROXYAPI_CLAUDE_MESSAGES = "Auto";
		expect(resolveClaudeMessagesDefault(agentDir({ claudeMessages: false }))).toBe("auto");
		process.env.CLIPROXYAPI_CLAUDE_MESSAGES = "maybe";
		expect(() => resolveClaudeMessagesDefault(agentDir())).toThrow(/CLIPROXYAPI_CLAUDE_MESSAGES/);
		delete process.env.CLIPROXYAPI_CLAUDE_MESSAGES;
		expect(() => resolveClaudeMessagesDefault(agentDir({ claudeMessages: "yes" }))).toThrow(/claudeMessages/);
	});
});

describe("claudeMessagesMode", () => {
	it("reads modes and the booleans older caches stored", () => {
		expect(claudeMessagesMode(true)).toBe("on");
		expect(claudeMessagesMode("on")).toBe("on");
		expect(claudeMessagesMode("auto")).toBe("auto");
		expect(claudeMessagesMode(false)).toBe("off");
		expect(claudeMessagesMode(undefined)).toBe("off");
	});
});

describe("reportedMaxTokens", () => {
	it("takes the first positive output limit CLIProxyAPI reports", () => {
		expect(reportedMaxTokens({ slug: "m", max_tokens: 64000 })).toBe(64000);
		expect(reportedMaxTokens({ slug: "m", max_output_tokens: 32000 })).toBe(32000);
		expect(reportedMaxTokens({ slug: "m", max_tokens: 0, max_completion_tokens: 8000 })).toBe(8000);
		expect(reportedMaxTokens({ slug: "m" })).toBeUndefined();
	});
});

describe("claudeFormatFor", () => {
	const owners = new Map([
		["claude-opus-5-5", "anthropic"],
		["anthropic/claude-opus-5.5", "anthropic"],
		["gpt-6.1-sol", "openai"],
		["claude-unknown-9", "anthropic"],
	]);

	it("selects models CPA lists as Anthropic and pi's catalog knows", () => {
		expect(claudeFormatFor("claude-opus-5-5", owners, CATALOG)?.compat?.forceAdaptiveThinking).toBe(true);
		expect(claudeFormatFor("anthropic/claude-opus-5.5", owners, CATALOG)).toBeDefined();
	});

	it("selects prefixed ids such as pool names (subs/claude-opus-5-5)", () => {
		const prefixed = new Map([["subs/claude-opus-5-5", "anthropic"]]);
		expect(claudeFormatFor("subs/claude-opus-5-5", prefixed, CATALOG)?.reasoning).toBe(true);
	});

	it("keeps other owners and unknown Claude models on the Codex format", () => {
		expect(claudeFormatFor("gpt-6.1-sol", owners, CATALOG)).toBeUndefined();
		expect(claudeFormatFor("claude-unknown-9", owners, CATALOG)).toBeUndefined();
		expect(claudeFormatFor("claude-opus-5-5", new Map(), CATALOG)).toBeUndefined();
	});
});

describe("toPiModel with the Claude format", () => {
	const model: CodexClientModel = {
		slug: "claude-opus-5-5",
		display_name: "Claude Opus 5.5",
		context_window: 1_000_000,
		supported_reasoning_levels: ["low", "medium", "high"],
		supports_reasoning_effort_updates: true,
	};
	const entry = claudeFormatFor("claude-opus-5-5", new Map([["claude-opus-5-5", "anthropic"]]), CATALOG);

	it("uses anthropic-messages with pi's compat, thinking levels and both cache tiers", () => {
		const mapped = toPiModel(model, undefined, false, undefined, entry);
		expect(mapped).toMatchObject({
			id: "claude-opus-5-5",
			api: ANTHROPIC_MESSAGES_API,
			reasoning: true,
			contextWindow: 1_000_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			promptCache: { short: 300, long: 3600 },
		});
		expect(mapped?.thinkingLevelMap?.max).toBe("max");
	});

	it("uses a cache lifetime CLIProxyAPI reports for the route", () => {
		const mapped = toPiModel({ ...model, prompt_cache_ttl_seconds: 3600 }, undefined, false, undefined, entry);
		expect(mapped?.promptCache).toEqual({ short: 3600, long: 3600 });
	});

	it("stays on the Codex format without an entry", () => {
		const mapped = toPiModel(model);
		expect(mapped?.api).toBeUndefined();
		expect(mapped?.compat).toEqual({ supportsMidConvoEffort: true });
		expect(mapped).not.toHaveProperty("promptCache");
	});
});

describe("fetchModelOwners", () => {
	it("maps id to owned_by and survives failures", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ id: "claude-opus-5-5", owned_by: "Anthropic" }, { id: "x" }] })),
			)
			.mockRejectedValueOnce(new Error("offline"));
		const owners = await fetchModelOwners("http://cpa/v1/models", "key");
		expect(owners.get("claude-opus-5-5")).toBe("anthropic");
		expect(owners.has("x")).toBe(false);
		expect((await fetchModelOwners("http://cpa/v1/models", "key")).size).toBe(0);
	});
});

describe("loadMappedModels with claudeMessages", () => {
	function mockCpa(claudeMaxTokens?: number) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("client_version")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "claude-opus-5-5",
								supported_reasoning_levels: ["high"],
								service_tiers: ["priority"],
								...(claudeMaxTokens ? { max_tokens: claudeMaxTokens } : {}),
							},
							{ slug: "gpt-6.1-sol", supported_reasoning_levels: ["high"], service_tiers: ["priority"] },
						],
					}),
				);
			}
			if (url.endsWith("/v1/models")) {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "claude-opus-5-5", owned_by: "anthropic" },
							{ id: "gpt-6.1-sol", owned_by: "openai" },
						],
					}),
				);
			}
			return new Response("{}");
		});
	}

	it("switches Claude models only, drops them from Fast, and marks the result", async () => {
		mockCpa();
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir(), undefined, "on");
		const claude = loaded.models.find((m) => m.id === "claude-opus-5-5");
		const gpt = loaded.models.find((m) => m.id === "gpt-6.1-sol");
		expect(claude?.api).toBe(ANTHROPIC_MESSAGES_API);
		expect(claude?.promptCache?.long).toBe(3600);
		expect(gpt?.api).toBeUndefined();
		expect(loaded.fastModelIds).toEqual(["gpt-6.1-sol"]);
		expect(loaded.claudeMessages).toBe("on");
	});

	it("still accepts true from older callers", async () => {
		mockCpa();
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir(), undefined, true);
		expect(loaded.models.find((m) => m.id === "claude-opus-5-5")?.api).toBe(ANTHROPIC_MESSAGES_API);
		expect(loaded.claudeMessages).toBe("on");
	});

	it("in auto, switches a Claude model only when CLIProxyAPI reports its output limit", async () => {
		mockCpa(64000);
		const withLimit = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir(), undefined, "auto");
		expect(withLimit.models.find((m) => m.id === "claude-opus-5-5")).toMatchObject({
			api: ANTHROPIC_MESSAGES_API,
			maxTokens: 64000,
		});
		expect(withLimit.claudeMessages).toBe("auto");
		vi.restoreAllMocks();

		mockCpa();
		const withoutLimit = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir(), undefined, "auto");
		expect(withoutLimit.models.find((m) => m.id === "claude-opus-5-5")?.api).toBeUndefined();
		expect(withoutLimit.fastModelIds).toContain("claude-opus-5-5");
	});

	it("doesn't fetch owners or change anything when off", async () => {
		const fetchMock = mockCpa(64000);
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key", false, agentDir());
		expect(loaded.models.every((m) => m.api === undefined)).toBe(true);
		expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/models"))).toBe(false);
		expect(loaded).not.toHaveProperty("claudeMessages");
	});
});

describe("loadBuiltinClaudeFormatCatalog", () => {
	it("reads pi's built-in Anthropic models", async () => {
		const catalog = await loadBuiltinClaudeFormatCatalog();
		const owners = new Map([["claude-haiku-4-5", "anthropic"]]);
		expect(claudeFormatFor("claude-haiku-4-5", owners, catalog)?.promptCache).toEqual({ short: 300, long: 3600 });
	});
});
