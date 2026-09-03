import { describe, expect, it } from "vitest";
import { formatGatewayTokensPerSecond, tokensPerSecondFromUsage } from "../extensions/gateway-telemetry.ts";

describe("gateway tok/s", () => {
	it("prefers usage.tokens_per_second", () => {
		expect(tokensPerSecondFromUsage({ tokens_per_second: 80.5, output: 200 })).toBe(80.5);
		expect(formatGatewayTokensPerSecond([{ output: 10 }, { tokens_per_second: 40 }])).toBe("40.0");
	});

	it("does not invent tok/s from output / elapsed", () => {
		expect(tokensPerSecondFromUsage({ output: 200, latency_ms: 2000 })).toBeUndefined();
		expect(formatGatewayTokensPerSecond([{ output: 200 }])).toBe("--");
	});
});
