function readPositiveNumber(raw: string | null): number | undefined {
	if (raw == null || raw.trim() === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

/** Gateway tok/s from inference response headers. Never tokens/latency. */
export function tokensPerSecondFromHeaders(headers: Headers): number | undefined {
	return readPositiveNumber(
		headers.get("x-cliproxyapi-tokens-per-second") ??
			headers.get("x-cliproxy-tokens-per-second") ??
			headers.get("x-omniroute-tokens-per-second"),
	);
}

export function captureGatewayTokensPerSecond(response: Response): number | undefined {
	return tokensPerSecondFromHeaders(response.headers);
}

export function wrapFetchCaptureTokensPerSecond(
	fetchImpl: typeof fetch,
	onCapture: (tps: number) => void,
): typeof fetch {
	return async (input, init) => {
		const response = await fetchImpl(input, init);
		const tps = captureGatewayTokensPerSecond(response);
		if (tps !== undefined) onCapture(tps);
		return response;
	};
}

export function formatGatewayTokensPerSecond(tps: number | undefined): string {
	return tps === undefined ? "--" : tps.toFixed(1);
}
