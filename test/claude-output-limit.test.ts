import { zstdDecompressSync } from "node:zlib";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { loadCliproxyCodexStreams } from "../extensions/codex-stream.ts";

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

async function requestPayload(
	modelId: string,
	options: Pick<SimpleStreamOptions, "maxTokens" | "onPayload"> = {},
): Promise<Record<string, unknown>> {
	const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
	let payload: Record<string, unknown> | undefined;
	const model = {
		id: modelId,
		provider: "cliproxyapi",
		baseUrl: "https://example.invalid/backend-api/",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		input: ["text"],
	} as Model<Api>;
	const events = streams.streamSimple(model, context, {
		apiKey: "test-key",
		transport: "sse",
		maxRetries: 0,
		...options,
		fetch: async (_url, init) => {
			const body = init?.body;
			const json = typeof body === "string" ? body : zstdDecompressSync(body as Uint8Array).toString("utf8");
			payload = JSON.parse(json) as Record<string, unknown>;
			return new Response("test only", { status: 400 });
		},
	});
	for await (const _event of events) {
		// The mock response terminates the stream after capturing the outbound body.
	}
	if (!payload) throw new Error("No request payload was sent");
	return payload;
}

describe("Claude Responses output limit", () => {
	it("sends the model output allowance to CLIProxyAPI", async () => {
		expect((await requestPayload("claude-sonnet-5")).max_output_tokens).toBe(128_000);
	});

	it("preserves a smaller per-request summary limit", async () => {
		expect((await requestPayload("claude-sonnet-5", { maxTokens: 8192 })).max_output_tokens).toBe(8192);
	});

	it("never exceeds the advertised model limit", async () => {
		expect((await requestPayload("claude-sonnet-5", { maxTokens: 200_000 })).max_output_tokens).toBe(128_000);
	});

	it("leaves other Codex models unchanged", async () => {
		expect(await requestPayload("gpt-5.4")).not.toHaveProperty("max_output_tokens");
	});

	it("allows a subsequent payload hook to override the limit", async () => {
		const payload = await requestPayload("claude-sonnet-5", {
			onPayload: (body) => ({ ...(body as Record<string, unknown>), max_output_tokens: 4096 }),
		});
		expect(payload.max_output_tokens).toBe(4096);
	});
});
