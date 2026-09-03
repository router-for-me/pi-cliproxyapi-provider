export function tokensPerSecondFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const raw = record.tokens_per_second ?? record.tokensPerSecond;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

/** Gateway tok/s only. Never invent tokens / elapsed (includes TTFT/tool pauses). */
export function formatGatewayTokensPerSecond(usages: unknown[]): string {
	for (const usage of usages) {
		const tps = tokensPerSecondFromUsage(usage);
		if (tps !== undefined) return tps.toFixed(1);
	}
	return "--";
}
