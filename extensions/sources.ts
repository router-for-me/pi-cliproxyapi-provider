/**
 * The credentials that serve a CLIProxyAPI model, and how to say them in a few words.
 *
 * Through CLIProxyAPI pi sees one provider, so a model list says nothing about where a model comes from. A CLIProxyAPI
 * that lists its credentials (`/v1/models?include=accounts`) names, per model, each credential's provider, its kind
 * (a subscription login or an API key), its priority and, for an API key, the host it is sent to. Everything here is
 * read from that list: nothing is guessed from a model's id or owner.
 */

/** A credential that serves a model, as `/v1/models?include=accounts` lists it. */
export interface Account {
	/** CLIProxyAPI's provider: claude, codex, meta, devin, antigravity, gemini, openai-compatible-<name> … */
	provider: string;
	/** "oauth" for a subscription login, "apikey" for an API key. */
	kind: string;
	priority: number;
	/** The host of an API key's base URL. */
	host?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The `accounts` of a model list entry; what is not a credential is left out. */
export function parseAccounts(value: unknown): Account[] {
	const accounts: Account[] = [];
	for (const account of Array.isArray(value) ? value : []) {
		if (!isRecord(account) || typeof account.provider !== "string" || typeof account.kind !== "string") continue;
		accounts.push({
			provider: account.provider,
			kind: account.kind,
			priority: typeof account.priority === "number" ? account.priority : 0,
			...(typeof account.host === "string" && account.host ? { host: account.host.toLowerCase() } : {}),
		});
	}
	return accounts;
}

/**
 * The credentials CLIProxyAPI may answer with: those at the highest priority. It uses the highest priority that is
 * free in every routing mode, and picks among the credentials sharing it (round-robin by default; with no priority
 * set, all share 0).
 */
function likelyAccounts(accounts: Account[]): Account[] {
	if (accounts.length === 0) return [];
	const top = Math.max(...accounts.map((account) => account.priority));
	return accounts.filter((account) => account.priority === top);
}

/** The service behind a CLIProxyAPI provider, as people call it. */
const SERVICES: Record<string, string> = {
	claude: "Anthropic",
	codex: "OpenAI",
	gemini: "Google",
	vertex: "Vertex",
	aistudio: "AI Studio",
	antigravity: "Antigravity",
	meta: "Meta",
	devin: "Devin",
	xai: "xAI",
	kimi: "Kimi",
};

/** The service an API key is sent to, by host: whatever its entry is called, and wherever a Claude key goes. */
const HOST_SERVICES: Record<string, string> = {
	"openrouter.ai": "OpenRouter",
	"api.openai.com": "OpenAI",
	"api.anthropic.com": "Anthropic",
	"generativelanguage.googleapis.com": "Google",
};

const KINDS: Record<string, string> = { oauth: "sub", apikey: "api" };

const COMPATIBLE_PREFIX = "openai-compatible-";

/** Who a credential belongs to. Not known: the host it is sent to, else the name CLIProxyAPI gives it. */
function serviceOf(account: Account): string {
	if (account.kind === "apikey" && account.host) return HOST_SERVICES[account.host] ?? account.host;
	const provider = account.provider.trim();
	const known = SERVICES[provider.toLowerCase()];
	if (known) return known;
	return provider.toLowerCase().startsWith(COMPATIBLE_PREFIX) ? provider.slice(COMPATIBLE_PREFIX.length) : provider;
}

interface Source {
	service: string;
	kind: string;
}

function sourcesOf(accounts: Account[]): Source[] {
	const seen = new Set<string>();
	const sources: Source[] = [];
	for (const account of accounts) {
		const source = { service: serviceOf(account), kind: KINDS[account.kind] ?? account.kind };
		const key = JSON.stringify([source.service, source.kind]);
		if (seen.has(key)) continue;
		seen.add(key);
		sources.push(source);
	}
	return sources;
}

/**
 * Where a model comes from, for its name: "Anthropic sub, fallback api". First what CLIProxyAPI may answer with (the
 * credentials at the highest priority, joined by "or" when they differ), then what it falls back to, highest priority
 * first. "sub" is a subscription login, "api" an API key; a service is named again only when it changes. Undefined
 * without credentials.
 */
export function sourceLabel(accounts: Account[]): string | undefined {
	if (accounts.length === 0) return undefined;
	const likely = likelyAccounts(accounts);
	const first = sourcesOf(likely);
	const taken = new Set(first.map((source) => JSON.stringify([source.service, source.kind])));
	const fallbacks = sourcesOf(
		accounts.filter((account) => !likely.includes(account)).sort((a, b) => b.priority - a.priority),
	).filter((source) => !taken.has(JSON.stringify([source.service, source.kind])));

	let named: string | undefined;
	const say = (source: Source): string => {
		const text = source.service === named ? source.kind : `${source.service} ${source.kind}`;
		named = source.service;
		return text;
	};
	const label = first.map(say).join(" or ");
	return fallbacks.length > 0 ? `${label}, fallback ${fallbacks.map(say).join(", ")}` : label;
}
