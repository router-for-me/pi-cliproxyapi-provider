import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Stops pi's cache warming when the route behind CLIProxyAPI is not caching.
 *
 * pi re-sends the conversation with a 1-token answer shortly before the declared
 * cache lifetime ends, and it does not check whether that warm-up read anything
 * from cache. Through a proxy the same model id can be served by a route that
 * never caches (or caches much less than declared), and every warm-up there
 * re-bills the whole prompt. This guard looks at the latest response on the
 * session branch, a normal turn or a warm-up: when it read (almost) nothing of
 * the prompt the previous response had already sent, warming stops until the
 * next real request. A route that does not cache costs at most one warm-up.
 * A miss after a gap longer than the cache lifetime is expiry, not evidence,
 * and is ignored.
 */

/** A response that read less than this share of the previous prompt counts as uncached. */
export const MIN_CACHED_SHARE = 0.1;

export interface ResponseUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Entry time in ms since epoch (NaN when unknown). */
	at: number;
}

type BranchEntry = {
	type: string;
	timestamp?: string;
	kind?: string;
	provider?: string;
	usage?: Partial<ResponseUsage>;
	message?: { role?: string; provider?: string; usage?: Partial<ResponseUsage>; stopReason?: string };
};

function promptTokens(usage: ResponseUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function toUsage(value: Partial<ResponseUsage> | undefined, timestamp: string | undefined): ResponseUsage | undefined {
	if (!value) return undefined;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	return {
		input: num(value.input),
		cacheRead: num(value.cacheRead),
		cacheWrite: num(value.cacheWrite),
		at: timestamp ? Date.parse(timestamp) : Number.NaN,
	};
}

/**
 * Usage of the provider's responses on the branch, newest last: assistant turns
 * and warm-ups. A model change or compaction starts a new prefix, so only the
 * responses after the latest one count.
 */
export function collectResponseUsages(branch: readonly BranchEntry[], providerId: string): ResponseUsage[] {
	const usages: ResponseUsage[] = [];
	for (const entry of branch) {
		if (entry.type === "model_change" || entry.type === "compaction") {
			usages.length = 0;
			continue;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm" && entry.provider === providerId) {
			const usage = toUsage(entry.usage, entry.timestamp);
			if (usage) usages.push(usage);
			continue;
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant" && message.provider === providerId && message.stopReason !== "error") {
			const usage = toUsage(message.usage, entry.timestamp);
			if (usage) usages.push(usage);
		}
	}
	return usages;
}

/**
 * True when the latest response read less than MIN_CACHED_SHARE of the prompt
 * the response before it had sent, within the cache lifetime. With fewer than
 * two responses (the first turn only writes the cache), no usage reported, or a
 * gap longer than the lifetime (the cache may simply have expired), nothing is
 * decided.
 */
export function isCacheNotWorking(usages: readonly ResponseUsage[], lifetimeMs?: number): boolean {
	if (usages.length < 2) return false;
	const previous = usages[usages.length - 2];
	const latest = usages[usages.length - 1];
	if (lifetimeMs !== undefined) {
		const gap = latest.at - previous.at;
		if (!Number.isFinite(gap) || gap > lifetimeMs) return false;
	}
	const previousPrompt = promptTokens(previous);
	if (previousPrompt <= 0 || promptTokens(latest) <= 0) return false;
	return latest.cacheRead < previousPrompt * MIN_CACHED_SHARE;
}

export function registerCacheWarmingGuard(pi: ExtensionAPI, providerId: string): void {
	pi.on("cache_warming_decision", (event, ctx: ExtensionContext) => {
		if (event.action !== "warm" || ctx.model?.provider !== providerId) return;
		const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
		const { short, long } = ctx.model.promptCache ?? {};
		const lifetimeSeconds = Math.max(short ?? 0, long ?? 0);
		const lifetimeMs = lifetimeSeconds > 0 ? lifetimeSeconds * 1000 : undefined;
		if (isCacheNotWorking(collectResponseUsages(branch, providerId), lifetimeMs)) {
			return { action: "stop" };
		}
	});
}
