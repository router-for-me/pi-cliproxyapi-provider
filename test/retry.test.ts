import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	normalizeCapacityError,
	normalizeTransientNetworkError,
	registerTransientNetworkErrorRetry,
} from "../extensions/retry.ts";

const TRANSIENT_STREAM_ERRORS = [
	"Codex error: read tcp 172.16.209.2:57303->172.64.155.209:443: use of closed network connection",
	"Error: Codex error: stream error: stream disconnected before completion: stream closed before response.completed",
	"Codex error: invalid SSE data JSON (len=33181)",
];

function assistantError(errorMessage: string, provider = "cliproxyapi"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cliproxyapi-codex-responses",
		provider,
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("transient network error normalization", () => {
	it.each(TRANSIENT_STREAM_ERRORS)("makes CLIProxyAPI transient stream error retryable: %s", (errorMessage) => {
		const original = assistantError(errorMessage);
		expect(isRetryableAssistantError(original)).toBe(false);

		const normalized = normalizeTransientNetworkError(original);
		expect(normalized).not.toBe(original);
		expect(normalized.errorMessage).toBe(`network error: ${errorMessage}`);
		expect(isRetryableAssistantError(normalized)).toBe(true);
	});

	it("leaves existing retryable and unrelated errors unchanged", () => {
		const retryable = assistantError("WebSocket closed 1006");
		const unrelated = assistantError("Codex error: invalid request");

		expect(normalizeTransientNetworkError(retryable)).toBe(retryable);
		expect(normalizeTransientNetworkError(unrelated)).toBe(unrelated);
	});
});

const CAPACITY_ERRORS = [
	"The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load.",
	"no healthy upstream",
];

describe("capacity error normalization", () => {
	it.each(CAPACITY_ERRORS)("keeps Azure capacity failures non-retryable: %s", (errorMessage) => {
		const original = assistantError(errorMessage);
		expect(isRetryableAssistantError(original)).toBe(false);

		const normalized = normalizeCapacityError(original);
		expect(normalized).not.toBe(original);
		expect(normalized.errorMessage).toBe(`capacity error: ${errorMessage}`);
		expect(isRetryableAssistantError(normalized)).toBe(false);
		expect(normalizeTransientNetworkError(normalized)).toBe(normalized);
	});

	it("does not rewrite generic WebSocket errors until CPA forwards the Azure body", () => {
		const websocket = assistantError("WebSocket error");
		expect(isRetryableAssistantError(websocket)).toBe(true);
		expect(normalizeCapacityError(websocket)).toBe(websocket);
		expect(normalizeTransientNetworkError(websocket)).toBe(websocket);
	});

	it("only rewrites assistant errors from the registered provider", () => {
		let handler: ((event: any, ctx: ExtensionContext) => unknown) | undefined;
		const pi = {
			on: (event: string, candidate: (event: any, ctx: ExtensionContext) => unknown) => {
				if (event === "message_end") handler = candidate;
			},
		} as unknown as ExtensionAPI;
		registerTransientNetworkErrorRetry(pi, "cliproxyapi");
		if (!handler) throw new Error("message_end handler was not registered");

		const matching = assistantError(TRANSIENT_STREAM_ERRORS[0]);
		const replacement = handler({ type: "message_end", message: matching }, {} as ExtensionContext) as {
			message: AssistantMessage;
		};
		expect(replacement.message.errorMessage).toBe(`network error: ${TRANSIENT_STREAM_ERRORS[0]}`);

		const capacity = assistantError(CAPACITY_ERRORS[0]);
		const capacityReplacement = handler({ type: "message_end", message: capacity }, {} as ExtensionContext) as {
			message: AssistantMessage;
		};
		expect(capacityReplacement.message.errorMessage).toBe(`capacity error: ${CAPACITY_ERRORS[0]}`);
		expect(isRetryableAssistantError(capacityReplacement.message)).toBe(false);

		const otherProvider = assistantError(TRANSIENT_STREAM_ERRORS[0], "other");
		expect(handler({ type: "message_end", message: otherProvider }, {} as ExtensionContext)).toBeUndefined();
	});
});
