import { describe, expect, it } from "vitest";
import {
	captureGatewayTokensPerSecond,
	formatGatewayTokensPerSecond,
	tokensPerSecondFromHeaders,
	wrapFetchCaptureTokensPerSecond,
} from "../extensions/gateway-telemetry.ts";

describe("gateway tok/s from Response headers", () => {
	it("reads X-CLIProxyAPI-Tokens-Per-Second off a real Response", async () => {
		const inner: typeof fetch = async () =>
			new Response("{}", {
				headers: { "X-CLIProxyAPI-Tokens-Per-Second": "80.5", "X-OmniRoute-Latency-Ms": "2000" },
			});
		let captured: number | undefined;
		const wrapped = wrapFetchCaptureTokensPerSecond(inner, (tps) => {
			captured = tps;
		});
		const response = await wrapped("https://gateway.example/v1/chat/completions");
		expect(captureGatewayTokensPerSecond(response)).toBe(80.5);
		expect(captured).toBe(80.5);
		expect(formatGatewayTokensPerSecond(captured)).toBe("80.5");
	});

	it("does not invent tok/s from latency or output headers", async () => {
		const inner: typeof fetch = async () =>
			new Response("{}", {
				headers: {
					"X-OmniRoute-Latency-Ms": "2000",
					"X-OmniRoute-Tokens-Out": "200",
				},
			});
		let captured: number | undefined;
		const wrapped = wrapFetchCaptureTokensPerSecond(inner, (tps) => {
			captured = tps;
		});
		await wrapped("https://gateway.example/v1/chat/completions");
		expect(captured).toBeUndefined();
		expect(
			tokensPerSecondFromHeaders(
				new Headers({ "X-OmniRoute-Latency-Ms": "2000", "X-OmniRoute-Tokens-Out": "200" }),
			),
		).toBeUndefined();
		expect(formatGatewayTokensPerSecond(undefined)).toBe("--");
	});
});
