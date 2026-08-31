import type { Api, AssistantMessage, Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { loadCliproxyCodexStreams } from "../extensions/codex-stream.ts";

const model: Model<Api> = {
	id: "kimi-k3",
	name: "Kimi K3",
	api: "cliproxyapi-codex-responses",
	provider: "cliproxyapi",
	baseUrl: "http://127.0.0.1:8317/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256_000,
	maxTokens: 32_000,
};

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(id: string, name: string, arguments_: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: arguments_ }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(id: string, name: string, output: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp: 2,
	};
}

async function capturePayload(context: Context): Promise<Record<string, unknown>> {
	const streams = await loadCliproxyCodexStreams();
	let captured: Record<string, unknown> | undefined;
	const result = await streams
		.streamSimple(model, context, {
			apiKey: "test-key",
			transport: "sse",
			onPayload: (payload) => {
				if (payload && typeof payload === "object" && !Array.isArray(payload)) {
					captured = structuredClone(payload) as Record<string, unknown>;
				}
				throw new Error("payload captured");
			},
		})
		.result();

	expect(result.stopReason).toBe("error");
	expect(captured).toBeDefined();
	return captured as Record<string, unknown>;
}

function responsesInput(payload: Record<string, unknown>): Record<string, unknown>[] {
	const input = payload.input;
	expect(Array.isArray(input)).toBe(true);
	return input as Record<string, unknown>[];
}

function toolItems(payload: Record<string, unknown>): Record<string, unknown>[] {
	return responsesInput(payload).filter(
		(item) => item.type === "function_call" || item.type === "function_call_output",
	);
}

function expectUniquePairedToolIdentities(payload: Record<string, unknown>): void {
	const calls = toolItems(payload).filter((item) => item.type === "function_call");
	const outputs = toolItems(payload).filter((item) => item.type === "function_call_output");
	const callIds = calls.map((item) => item.call_id);
	const itemIds = calls.map((item) => item.id);

	expect(new Set(callIds).size).toBe(callIds.length);
	expect(new Set(itemIds).size).toBe(itemIds.length);
	expect(outputs.map((item) => item.call_id)).toEqual(callIds);
	for (const id of [...callIds, ...itemIds]) {
		expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
	}
}

describe("Codex Responses history replay", () => {
	it("deterministically disambiguates two non-adjacent repeated tool identities", async () => {
		const context: Context = {
			messages: [
				assistantToolCall("read_0|fc_read_0", "read", { path: "first.ts" }),
				toolResult("read_0|fc_read_0", "read", "first output"),
				{ role: "user", content: "continue", timestamp: 3 },
				assistantToolCall("bash_0|fc_bash_0", "bash", { command: "pwd" }),
				toolResult("bash_0|fc_bash_0", "bash", "first bash output"),
				assistantToolCall("read_0|fc_read_0", "read", { path: "second.ts" }),
				toolResult("read_0|fc_read_0", "read", "second output"),
				assistantToolCall("bash_0|fc_bash_0", "bash", { command: "git status" }),
				toolResult("bash_0|fc_bash_0", "bash", "second bash output"),
			],
		};

		const firstAttempt = await capturePayload(context);
		const retry = await capturePayload(context);

		expectUniquePairedToolIdentities(firstAttempt);
		expect(retry).toEqual(firstAttempt);
		expect(
			toolItems(firstAttempt)
				.filter((item) => item.type === "function_call")
				.map((item) => [item.call_id, item.id]),
		).toEqual([
			["read_0", "fc_read_0"],
			["bash_0", "fc_bash_0"],
			["read_0_pi_2", "fc_read_0_pi_2"],
			["bash_0_pi_2", "fc_bash_0_pi_2"],
		]);
		expect(toolItems(firstAttempt)).toEqual([
			expect.objectContaining({ type: "function_call", name: "read", arguments: '{"path":"first.ts"}' }),
			expect.objectContaining({ type: "function_call_output", output: "first output" }),
			expect.objectContaining({ type: "function_call", name: "bash", arguments: '{"command":"pwd"}' }),
			expect.objectContaining({ type: "function_call_output", output: "first bash output" }),
			expect.objectContaining({ type: "function_call", name: "read", arguments: '{"path":"second.ts"}' }),
			expect.objectContaining({ type: "function_call_output", output: "second output" }),
			expect.objectContaining({ type: "function_call", name: "bash", arguments: '{"command":"git status"}' }),
			expect.objectContaining({ type: "function_call_output", output: "second bash output" }),
		]);
	});

	it("keeps adjacent repeated calls paired with their synthetic and real outputs", async () => {
		const context: Context = {
			messages: [
				assistantToolCall("edit_86|fc_edit_86", "edit", { path: "first.ts" }),
				assistantToolCall("edit_86|fc_edit_86", "edit", { path: "second.ts" }),
				toolResult("edit_86|fc_edit_86", "edit", "edited second.ts"),
			],
		};

		const payload = await capturePayload(context);

		expectUniquePairedToolIdentities(payload);
		expect(toolItems(payload)).toEqual([
			expect.objectContaining({ type: "function_call", name: "edit", arguments: '{"path":"first.ts"}' }),
			expect.objectContaining({ type: "function_call_output", output: "No result provided" }),
			expect.objectContaining({ type: "function_call", name: "edit", arguments: '{"path":"second.ts"}' }),
			expect.objectContaining({ type: "function_call_output", output: "edited second.ts" }),
		]);
	});

	it("pairs repeated identities within one assistant turn by call order", async () => {
		const sameTurn = assistantToolCall("write_4|fc_write_4", "write", { path: "first.ts" });
		sameTurn.content.push({
			type: "toolCall",
			id: "write_4|fc_write_4",
			name: "write",
			arguments: { path: "second.ts" },
		});
		const payload = await capturePayload({
			messages: [
				sameTurn,
				toolResult("write_4|fc_write_4", "write", "wrote first.ts"),
				toolResult("write_4|fc_write_4", "write", "wrote second.ts"),
			],
		});

		expectUniquePairedToolIdentities(payload);
		expect(toolItems(payload).map((item) => [item.type, item.call_id, item.output])).toEqual([
			["function_call", "write_4", undefined],
			["function_call", "write_4_pi_2", undefined],
			["function_call_output", "write_4", "wrote first.ts"],
			["function_call_output", "write_4_pi_2", "wrote second.ts"],
		]);
	});

	it("does not change identities when the replay has no duplicates", async () => {
		const payload = await capturePayload({
			messages: [
				assistantToolCall("read_7|fc_read_7", "read", { path: "only.ts" }),
				toolResult("read_7|fc_read_7", "read", "only output"),
			],
		});

		expect(toolItems(payload).map((item) => ({ type: item.type, id: item.id, call_id: item.call_id }))).toEqual([
			{ type: "function_call", id: "fc_read_7", call_id: "read_7" },
			{ type: "function_call_output", id: undefined, call_id: "read_7" },
		]);
	});
});
