/**
 * Pure helpers for CLIProxyAPI baseUrl normalization, model mapping, and config I/O.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

// Local shape matching pi ThinkingLevelMap; avoid hard runtime peer imports here.
export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra", string | null>
>;

// Local subset of pi model compat flags: OpenAIResponsesCompat for Codex-format models,
// AnthropicMessagesCompat (copied from pi's catalog) for Claude-format models.
export interface PiProviderModelCompat {
	supportsMidConvoEffort?: boolean;
	[key: string]: unknown;
}

/** pi API id used for Claude models when the Claude Messages format is enabled. */
export const ANTHROPIC_MESSAGES_API = "anthropic-messages";

export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const MODELS_CACHE_FILE_NAME = "cliproxyapi-models.json";
export const AUTH_FILE_NAME = "auth.json";
export const CLIENT_VERSION = "pi";
export const MODELS_REQUEST_TIMEOUT_MS = 60_000;

/** Keep login credentials effectively permanent; reconfigure via /login. */
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MODELS_DEV_V2_URL = "https://models.dev/experimental/v2.0/api.json";

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export interface CliproxyConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
	fast?: boolean;
	pause?: boolean;
	claudeMessages?: boolean;
}

export interface ResolvedIdentity {
	providerId: string;
	providerName: string;
}

export interface ResolvedConnection {
	baseUrlInput: string;
	apiKey: string;
	inferenceBaseUrl: string;
	modelsUrl: string;
}

export interface CodexReasoningLevel {
	effort?: string;
	description?: string;
}

export interface CodexServiceTier {
	id?: string;
	name?: string;
	description?: string;
}

export interface CodexClientModel {
	slug?: string;
	id?: string;
	display_name?: string;
	name?: string;
	description?: string;
	context_window?: number;
	max_context_window?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	/** Prompt-cache lifetime of this route, reported by CLIProxyAPI plugins such as the pools plugin. */
	prompt_cache_ttl_seconds?: number;
	input_modalities?: string[];
	supported_reasoning_levels?: CodexReasoningLevel[] | string[];
	supports_reasoning_effort_updates?: boolean;
	default_service_tier?: string | null;
	service_tiers?: Array<CodexServiceTier | string>;
	additional_speed_tiers?: string[];
	visibility?: string;
}

export interface CodexClientModelsResponse {
	models?: CodexClientModel[];
	data?: CodexClientModel[];
}

export interface PiProviderCostTier {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Apply this rate when total input-side usage is above this threshold. */
	inputTokensAbove: number;
}

export interface PiProviderCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: PiProviderCostTier[];
}

/** Prompt cache lifetimes in seconds per retention tier (pi `Model.promptCache`). */
export interface PiProviderModelPromptCache {
	short?: number;
	long?: number;
}

export interface PiProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: PiProviderCost;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: PiProviderModelCompat;
	promptCache?: PiProviderModelPromptCache;
	/** Set to "anthropic-messages" for Claude models sent in Claude's own format; unset = the Codex format. */
	api?: string;
	stale?: boolean;
	lastSeenAt?: number;
	staleSince?: number;
}

export interface MappedModels {
	models: PiProviderModel[];
	fastModelIds: string[];
	inferenceBaseUrl: string;
	modelsUrl: string;
	fastMode?: boolean;
	claudeMessages?: boolean;
}

export interface ModelsCacheFile extends MappedModels {
	fetchedAt: number;
}

interface ModelsDevCostPayload {
	input?: unknown;
	output?: unknown;
	cache_read?: unknown;
	cache_write?: unknown;
	tiers?: unknown;
	context_over_200k?: unknown;
}

interface ModelsDevModePayload {
	cost?: ModelsDevCostPayload;
}

interface ModelsDevModelPayload {
	cost?: ModelsDevCostPayload;
	experimental?: {
		modes?: Record<string, ModelsDevModePayload | undefined>;
	};
}

export interface ModelsDevCostEntry {
	providerId: string;
	modelId: string;
	standard: PiProviderCost;
	fast?: PiProviderCost;
}

export interface ModelsDevCostCatalog {
	exact: Map<string, ModelsDevCostEntry[]>;
	normalized: Map<string, ModelsDevCostEntry[]>;
}

export interface OAuthRefreshMeta {
	baseUrl: string;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Normalize user-provided base URL into inference + models endpoints.
 *
 * Preferred input: host:port (e.g. http://127.0.0.1:8317)
 * - /backend-api kept as-is for inference
 * - /v1 rewritten to /backend-api for inference
 * - models always at {root}/v1/models?client_version=pi
 */
export function resolveEndpoints(baseUrlInput: string): {
	inferenceBaseUrl: string;
	modelsUrl: string;
	rootOrigin: string;
	/** Base URL for Claude Messages requests (the client appends /v1/messages). */
	messagesBaseUrl: string;
	/** Plain OpenAI model list, which carries owned_by. */
	plainModelsUrl: string;
} {
	let raw = baseUrlInput.trim();
	if (!raw) {
		throw new Error("baseUrl is empty");
	}
	if (!/^https?:\/\//i.test(raw)) {
		raw = `http://${raw}`;
	}

	const url = new URL(raw);
	let path = url.pathname.replace(/\/+$/, "");

	if (path === "/v1") {
		path = "/backend-api";
	} else if (path.endsWith("/v1")) {
		path = `${path.slice(0, -"/v1".length)}/backend-api`;
	} else if (path === "" || path === "/") {
		path = "/backend-api";
	} else if (!path.endsWith("/backend-api")) {
		path = `${path}/backend-api`;
	}

	const rootPath = path.replace(/\/backend-api$/, "");
	const inferenceBaseUrl = `${url.origin}${path}/`;
	const modelsPath = `${rootPath}/v1/models`.replace(/\/{2,}/g, "/");
	const modelsUrl = `${url.origin}${modelsPath}?client_version=${encodeURIComponent(CLIENT_VERSION)}`;

	return {
		inferenceBaseUrl,
		modelsUrl,
		rootOrigin: url.origin,
		messagesBaseUrl: `${url.origin}${rootPath}`,
		plainModelsUrl: `${url.origin}${modelsPath}`,
	};
}

export function encodeRefreshMeta(baseUrl: string): string {
	const meta: OAuthRefreshMeta = { baseUrl };
	return JSON.stringify(meta);
}

export function decodeRefreshMeta(refresh: string | undefined): OAuthRefreshMeta | null {
	if (!refresh?.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(refresh) as OAuthRefreshMeta;
		if (parsed && typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()) {
			return { baseUrl: parsed.baseUrl.trim() };
		}
	} catch {
		// Older / non-JSON refresh tokens are ignored.
	}
	return null;
}

export function loadConfigFile(agentDir: string): CliproxyConfigFile {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		return parsed as CliproxyConfigFile;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw error;
		}
		return {};
	}
}

export const SETTINGS_FILE_NAME = "settings.json";

export interface ConfiguredDefaultModelSettings {
	defaultProvider?: string;
	defaultModel?: string;
}

export function loadConfiguredDefaultSettings(agentDir: string): ConfiguredDefaultModelSettings {
	const settingsPath = join(agentDir, SETTINGS_FILE_NAME);
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		return {
			defaultProvider:
				typeof parsed.defaultProvider === "string" && parsed.defaultProvider.trim()
					? parsed.defaultProvider.trim()
					: undefined,
			defaultModel:
				typeof parsed.defaultModel === "string" && parsed.defaultModel.trim()
					? parsed.defaultModel.trim()
					: undefined,
		};
	} catch {
		return {};
	}
}

export function isModelReferencedAsDefault(
	configured: ConfiguredDefaultModelSettings | string | undefined,
	modelId: string,
	providerId: string,
): boolean {
	if (!configured) return false;
	const settings: ConfiguredDefaultModelSettings =
		typeof configured === "string" ? { defaultModel: configured } : configured;

	if (!settings.defaultModel) return false;
	const trimmed = settings.defaultModel.trim();
	if (trimmed === `${providerId}/${modelId}` || trimmed === `${providerId}:${modelId}`) {
		return true;
	}
	if (trimmed === modelId) {
		return settings.defaultProvider === undefined || settings.defaultProvider === providerId;
	}
	return false;
}

export function saveConfigFile(agentDir: string, config: CliproxyConfigFile): void {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	mkdirSync(dirname(configPath), { recursive: true });

	const existing = loadConfigFile(agentDir);
	const next: CliproxyConfigFile = {
		...existing,
		...config,
	};
	writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function loadModelsCache(agentDir: string, baseUrlInput: string): ModelsCacheFile | null {
	const cachePath = join(agentDir, MODELS_CACHE_FILE_NAME);
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<ModelsCacheFile>;
		const endpoints = resolveEndpoints(baseUrlInput);
		if (
			typeof parsed.fetchedAt !== "number" ||
			parsed.modelsUrl !== endpoints.modelsUrl ||
			parsed.inferenceBaseUrl !== endpoints.inferenceBaseUrl ||
			!Array.isArray(parsed.models) ||
			!Array.isArray(parsed.fastModelIds)
		) {
			return null;
		}
		return parsed as ModelsCacheFile;
	} catch {
		return null;
	}
}

export function saveModelsCache(agentDir: string, loaded: MappedModels, fetchedAt = Date.now()): void {
	const cachePath = join(agentDir, MODELS_CACHE_FILE_NAME);
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, `${JSON.stringify({ ...loaded, fetchedAt }, null, 2)}\n`, "utf8");
}

export function loadAuthConnection(agentDir: string, providerId: string): { baseUrl?: string; apiKey?: string } | null {
	const entry = readStoredCredential(providerId, join(agentDir, AUTH_FILE_NAME));
	if (entry?.type === "oauth" && typeof entry.access === "string" && entry.access.trim()) {
		const meta = decodeRefreshMeta(typeof entry.refresh === "string" ? entry.refresh : undefined);
		return {
			apiKey: entry.access.trim(),
			baseUrl: meta?.baseUrl,
		};
	}

	if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
		return { apiKey: entry.key.trim() };
	}
	return null;
}

export function resolveIdentity(agentDir: string): ResolvedIdentity {
	let file: CliproxyConfigFile = {};
	try {
		file = loadConfigFile(agentDir);
	} catch {
		file = {};
	}

	return {
		providerId: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_ID, file.providerId, DEFAULT_PROVIDER_ID)!,
		providerName: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_NAME, file.providerName, DEFAULT_PROVIDER_NAME)!,
	};
}

export function parseBooleanSetting(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

/** Resolve the Fast preference from env, then cliproxyapi.json, then false. */
export function resolveFastDefault(agentDir: string): boolean {
	const envValue = firstNonEmpty(process.env.CLIPROXYAPI_FAST);
	if (envValue !== undefined) {
		const parsed = parseBooleanSetting(envValue);
		if (parsed === undefined) {
			throw new Error(`CLIPROXYAPI_FAST must be one of: true, false, 1, 0, yes, no, on, off`);
		}
		return parsed;
	}

	const file = loadConfigFile(agentDir);
	if (file.fast === undefined) {
		return false;
	}
	if (typeof file.fast !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "fast" must be a boolean`);
	}
	return file.fast;
}

/** Resolve the Claude Messages preference from env, then cliproxyapi.json, then false. */
export function resolveClaudeMessagesDefault(agentDir: string): boolean {
	const envValue = firstNonEmpty(process.env.CLIPROXYAPI_CLAUDE_MESSAGES);
	if (envValue !== undefined) {
		const parsed = parseBooleanSetting(envValue);
		if (parsed === undefined) {
			throw new Error("CLIPROXYAPI_CLAUDE_MESSAGES must be one of: true, false, 1, 0, yes, no, on, off");
		}
		return parsed;
	}
	const file = loadConfigFile(agentDir);
	if (file.claudeMessages === undefined) {
		return false;
	}
	if (typeof file.claudeMessages !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "claudeMessages" must be a boolean`);
	}
	return file.claudeMessages;
}

/** Resolve the request pause preference from cliproxyapi.json, defaulting to false. */
export function resolvePauseDefault(agentDir: string): boolean {
	const file = loadConfigFile(agentDir);
	if (file.pause === undefined) {
		return false;
	}
	if (typeof file.pause !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "pause" must be a boolean`);
	}
	return file.pause;
}

/**
 * Resolve connection settings.
 * Priority: env > cliproxyapi.json > auth.json (/login) > default baseUrl
 */
export function resolveConnection(agentDir: string, providerId: string): ResolvedConnection | null {
	let file: CliproxyConfigFile = {};
	try {
		file = loadConfigFile(agentDir);
	} catch {
		file = {};
	}

	let auth: { baseUrl?: string; apiKey?: string } | null = null;
	try {
		auth = loadAuthConnection(agentDir, providerId);
	} catch {
		auth = null;
	}

	const baseUrlInput = firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, file.baseUrl, auth?.baseUrl, DEFAULT_BASE_URL)!;
	const apiKey = firstNonEmpty(process.env.CLIPROXYAPI_API_KEY, file.apiKey, auth?.apiKey);
	if (!apiKey) {
		return null;
	}

	const endpoints = resolveEndpoints(baseUrlInput);
	return {
		baseUrlInput,
		apiKey,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}

export function extractReasoningEfforts(model: CodexClientModel): string[] {
	const raw = model.supported_reasoning_levels ?? [];
	const efforts: string[] = [];
	for (const entry of raw) {
		const effort = typeof entry === "string" ? entry : typeof entry?.effort === "string" ? entry.effort : "";
		const normalized = effort.trim().toLowerCase();
		if (!normalized) continue;
		if (!efforts.includes(normalized)) {
			efforts.push(normalized);
		}
	}
	return efforts;
}

export function buildThinkingLevelMap(efforts: string[]): ThinkingLevelMap | undefined {
	if (efforts.length === 0) {
		return undefined;
	}

	const supported = new Set(efforts);
	const map: ThinkingLevelMap = {};

	for (const level of PI_THINKING_LEVELS) {
		if (level === "off") {
			map.off = supported.has("none") ? "none" : null;
			continue;
		}
		map[level] = supported.has(level) ? level : null;
	}

	return map;
}

export function buildInputModalities(model: CodexClientModel): Array<"text" | "image"> {
	const raw = model.input_modalities ?? [];
	const input: Array<"text" | "image"> = [];
	for (const modality of raw) {
		const value = String(modality).trim().toLowerCase();
		if ((value === "text" || value === "image") && !input.includes(value)) {
			input.push(value);
		}
	}
	if (!input.includes("text")) {
		input.unshift("text");
	}
	return input;
}

export function codexModelId(model: CodexClientModel): string {
	return (model.slug ?? model.id ?? "").trim();
}

export function supportsFastServiceTier(model: CodexClientModel): boolean {
	return Array.isArray(model.service_tiers) && model.service_tiers.length > 0;
}

export function supportsReasoningEffortUpdates(model: CodexClientModel): boolean {
	return model.supports_reasoning_effort_updates === true;
}

export function toPiModel(
	model: CodexClientModel,
	costCatalog?: ModelsDevCostCatalog,
	fastMode = false,
	promptCacheSources?: PromptCacheSources,
	claudeFormat?: ClaudeFormatEntry,
): PiProviderModel | null {
	const id = codexModelId(model);
	if (!id) {
		return null;
	}
	if (String(model.visibility ?? "").toLowerCase() === "hide") {
		return null;
	}

	const efforts = extractReasoningEfforts(model);
	const hasReasoning = efforts.some((effort) => effort !== "none");
	const contextWindow =
		(typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : undefined) ??
		(typeof model.max_context_window === "number" && model.max_context_window > 0
			? model.max_context_window
			: undefined) ??
		DEFAULT_CONTEXT_WINDOW;

	const cost = costCatalog
		? matchModelCost(id, costCatalog, fastMode && supportsFastServiceTier(model))
		: { ...ZERO_COST };

	const maxTokens =
		(typeof model.max_tokens === "number" && Number.isFinite(model.max_tokens) && model.max_tokens > 0
			? model.max_tokens
			: undefined) ??
		(typeof model.max_output_tokens === "number" &&
		Number.isFinite(model.max_output_tokens) &&
		model.max_output_tokens > 0
			? model.max_output_tokens
			: undefined) ??
		(typeof model.max_completion_tokens === "number" &&
		Number.isFinite(model.max_completion_tokens) &&
		model.max_completion_tokens > 0
			? model.max_completion_tokens
			: undefined) ??
		DEFAULT_MAX_TOKENS;

	const resolvedCache = withReportedCacheLifetime(
		promptCacheSources ? resolvePromptCache(id, promptCacheSources) : undefined,
		model.prompt_cache_ttl_seconds,
	);
	if (claudeFormat) {
		// Claude's own format carries the long tier (cache_control ttl "1h"), so declare it too.
		const promptCache = {
			...((resolvedCache?.short ?? claudeFormat.promptCache?.short)
				? { short: resolvedCache?.short ?? claudeFormat.promptCache?.short }
				: {}),
			...(claudeFormat.promptCache?.long ? { long: claudeFormat.promptCache.long } : {}),
		};
		return {
			id,
			name: (model.display_name ?? model.name ?? id).trim() || id,
			api: ANTHROPIC_MESSAGES_API,
			reasoning: claudeFormat.reasoning,
			input: buildInputModalities(model),
			cost,
			contextWindow,
			maxTokens,
			...(claudeFormat.thinkingLevelMap ? { thinkingLevelMap: { ...claudeFormat.thinkingLevelMap } } : {}),
			...(claudeFormat.compat ? { compat: { ...claudeFormat.compat } } : {}),
			...(Object.keys(promptCache).length > 0 ? { promptCache } : {}),
		};
	}
	// The Codex format sends the same request whatever the cache retention (PI_CACHE_RETENTION=long changes nothing
	// on the wire), so the route keeps one lifetime. Declare it for both tiers: without a long tier, pi would treat
	// "long" as an unknown lifetime and stop warming these models.
	const promptCache = resolvedCache?.short ? { short: resolvedCache.short, long: resolvedCache.short } : resolvedCache;

	return {
		id,
		name: (model.display_name ?? model.name ?? id).trim() || id,
		reasoning: hasReasoning,
		input: buildInputModalities(model),
		cost,
		contextWindow,
		maxTokens,
		thinkingLevelMap: buildThinkingLevelMap(efforts),
		...(hasReasoning && supportsReasoningEffortUpdates(model) ? { compat: { supportsMidConvoEffort: true } } : {}),
		...(promptCache ? { promptCache } : {}),
	};
}

/** HTTP error from /v1/models (used to detect 401). */
export class ModelsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, body: string) {
		super(`models request failed: ${status} ${statusText}${body ? ` body=${body.slice(0, 200)}` : ""}`);
		this.name = "ModelsHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export function isUnauthorizedModelsError(error: unknown): boolean {
	return error instanceof ModelsHttpError && error.status === 401;
}

export async function fetchCodexModels(
	modelsUrl: string,
	apiKey: string,
	timeoutMs = MODELS_REQUEST_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<CodexClientModel[]> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(modelsUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal: requestSignal,
	});

	// Login validation only requires HTTP 200; non-2xx means credentials/baseUrl failed.
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ModelsHttpError(response.status, response.statusText, body);
	}

	// Status 200 is enough for success, even when the catalog is empty or non-JSON.
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return [];
	}

	if (Array.isArray(payload)) {
		return payload as CodexClientModel[];
	}
	if (payload && typeof payload === "object") {
		const obj = payload as CodexClientModelsResponse;
		if (Array.isArray(obj.models)) {
			return obj.models;
		}
		if (Array.isArray(obj.data)) {
			return obj.data;
		}
	}
	return [];
}

export interface ResolvedModelsResult {
	loaded: MappedModels;
	fromCache: boolean;
}

const MODEL_NAMESPACE_PREFIX =
	/^(openai|anthropic|google(?:-vertex)?|xai|deepseek|mistral|cohere|zhipuai|moonshotai|minimax|meta)[/:.]/i;

const MODEL_PROVIDER_PREFERENCES: Array<{ pattern: RegExp; providers: string[] }> = [
	{ pattern: /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/, providers: ["openai", "openai-codex", "opencode"] },
	{ pattern: /^claude-/, providers: ["anthropic"] },
	{ pattern: /^(?:gemini-|gemma-)/, providers: ["google", "google-vertex"] },
	{ pattern: /^grok-/, providers: ["xai"] },
	{ pattern: /^deepseek-/, providers: ["deepseek"] },
	{ pattern: /^mistral-/, providers: ["mistral"] },
	{ pattern: /^command-/, providers: ["cohere"] },
	{ pattern: /^glm-/, providers: ["zhipuai"] },
	{ pattern: /^(?:kimi-|moonshot-)/, providers: ["moonshotai"] },
	{ pattern: /^minimax-/, providers: ["minimax"] },
	{ pattern: /^llama-/, providers: ["meta"] },
];

/** Explicit aliases for proxy-specific model ids whose billable base model is known. */
const MODEL_PRICE_ALIASES: Record<string, string[]> = {
	"gemini-pro-agent": ["gemini-3.1-pro-preview"],
	"gemini-3.1-pro-low": ["gemini-3.1-pro-preview"],
	"gemini-3.6-flash-high": ["gemini-3.6-flash"],
	"gemini-3-flash-agent": ["gemini-3.5-flash"],
	"grok-composer-2.5-fast": ["grok-4.3"],
	"grok-3-mini": ["xai/grok-3-mini"],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCostRate(
	source: Record<string, unknown>,
	key: "input" | "output" | "cacheRead" | "cacheWrite",
	fallback: number,
): number {
	const rawKey = key === "cacheRead" ? "cache_read" : key === "cacheWrite" ? "cache_write" : key;
	return finiteNumber(source[key] ?? source[rawKey]) ?? fallback;
}

function parseModelsDevCost(raw: ModelsDevCostPayload | undefined): PiProviderCost | undefined {
	if (!raw) return undefined;
	const source = raw as Record<string, unknown>;
	const input = finiteNumber(source.input);
	const output = finiteNumber(source.output);
	if (input === undefined && output === undefined) return undefined;

	const cost: PiProviderCost = {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead: readCostRate(source, "cacheRead", 0),
		cacheWrite: readCostRate(source, "cacheWrite", 0),
	};
	const tiers = new Map<number, PiProviderCostTier>();

	const addTier = (rawTier: unknown, fallbackThreshold?: number): void => {
		const tierSource = asRecord(rawTier);
		if (!tierSource) return;
		const descriptor = asRecord(tierSource.tier);
		if (descriptor?.type !== undefined && descriptor.type !== "context") return;
		const threshold =
			finiteNumber(tierSource.inputTokensAbove) ?? finiteNumber(descriptor?.size) ?? fallbackThreshold;
		if (threshold === undefined || threshold <= 0) return;
		tiers.set(threshold, {
			input: readCostRate(tierSource, "input", cost.input),
			output: readCostRate(tierSource, "output", cost.output),
			cacheRead: readCostRate(tierSource, "cacheRead", cost.cacheRead),
			cacheWrite: readCostRate(tierSource, "cacheWrite", cost.cacheWrite),
			inputTokensAbove: threshold,
		});
	};

	if (Array.isArray(source.tiers)) {
		for (const tier of source.tiers) addTier(tier);
	}
	if (tiers.size === 0) {
		// Older models.dev records may expose only this compatibility shortcut.
		addTier(source.context_over_200k, 200000);
	}
	if (tiers.size > 0) {
		cost.tiers = Array.from(tiers.values()).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	}
	return cost;
}

function cloneCost(cost: PiProviderCost): PiProviderCost {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

/**
 * Lower-cased id without its vendor namespace (`anthropic/…`) or any other single leading path segment, so names
 * CLIProxyAPI users give a model (a pool such as `subs/claude-opus-5-5`) still match catalogs as that model. Callers
 * try the full id first, so exact entries win.
 */
function stripModelNamespace(modelId: string): string {
	const id = modelId.trim().toLowerCase().replace(MODEL_NAMESPACE_PREFIX, "");
	return id.replace(/^[^/]+\/(?=[^/])/, "");
}

function normalizeModelKey(modelId: string): string {
	return stripModelNamespace(modelId).replace(/[^a-z0-9]/g, "");
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function preferredProvidersForModel(modelId: string): string[] {
	const normalizedId = stripModelNamespace(modelId);
	const namespace = modelId.trim().toLowerCase().match(MODEL_NAMESPACE_PREFIX)?.[1];
	const familyProviders =
		MODEL_PROVIDER_PREFERENCES.find(({ pattern }) => pattern.test(normalizedId))?.providers ?? [];
	return uniqueStrings([namespace ?? "", ...familyProviders]);
}

function addCatalogEntry<T extends { providerId: string; modelId: string }>(
	catalog: Map<string, T[]>,
	key: string,
	entry: T,
): void {
	if (!key) return;
	const entries = catalog.get(key) ?? [];
	if (!entries.some((candidate) => candidate.providerId === entry.providerId && candidate.modelId === entry.modelId)) {
		entries.push(entry);
		catalog.set(key, entries);
	}
}

function addModelsDevEntry(catalog: ModelsDevCostCatalog, entry: ModelsDevCostEntry): void {
	const rawId = entry.modelId.trim().toLowerCase();
	const strippedId = stripModelNamespace(rawId);
	for (const key of uniqueStrings([rawId, strippedId])) {
		addCatalogEntry(catalog.exact, key, entry);
	}
	addCatalogEntry(catalog.normalized, normalizeModelKey(rawId), entry);
}

function sameCostVariants(entries: ModelsDevCostEntry[]): boolean {
	const fingerprints = new Set(entries.map((entry) => JSON.stringify({ standard: entry.standard, fast: entry.fast })));
	return fingerprints.size === 1;
}

function selectModelsDevEntry(entries: ModelsDevCostEntry[], modelId: string): ModelsDevCostEntry | undefined {
	if (entries.length === 0) return undefined;
	const preferredProviders = preferredProvidersForModel(modelId);
	for (const providerId of preferredProviders) {
		const match = entries.find((entry) => entry.providerId === providerId);
		if (match) return match;
	}
	if (entries.length === 1 || sameCostVariants(entries)) {
		return [...entries].sort((a, b) => a.providerId.localeCompare(b.providerId))[0];
	}
	// Do not silently pick an arbitrary reseller price when the source is ambiguous.
	return undefined;
}

function findDirectModelsDevEntry(modelId: string, catalog: ModelsDevCostCatalog): ModelsDevCostEntry | undefined {
	const rawId = modelId.trim().toLowerCase();
	const exactKeys = uniqueStrings([rawId, stripModelNamespace(rawId)]);
	for (const key of exactKeys) {
		const match = selectModelsDevEntry(catalog.exact.get(key) ?? [], modelId);
		if (match) return match;
	}
	return selectModelsDevEntry(catalog.normalized.get(normalizeModelKey(rawId)) ?? [], modelId);
}

function findModelsDevEntry(modelId: string, catalog: ModelsDevCostCatalog): ModelsDevCostEntry | undefined {
	const rawId = modelId.trim().toLowerCase();
	const lookupIds = uniqueStrings([rawId, ...(MODEL_PRICE_ALIASES[rawId] ?? [])]);
	for (const lookupId of lookupIds) {
		const match = findDirectModelsDevEntry(lookupId, catalog);
		if (match) return match;
	}
	return undefined;
}

interface ModelsDevCacheFile {
	timestamp: number;
	providers: Record<string, unknown>;
}

function getModelsDevCachePath(agentDir?: string): string {
	if (agentDir?.trim()) {
		return join(agentDir, "tmp", "models-dev-cache.json");
	}
	return join(tmpdir(), "pi-cliproxyapi-models-dev-cache.json");
}

function readModelsDevCacheFile(cachePath: string): ModelsDevCacheFile | null {
	try {
		const raw = readFileSync(cachePath, "utf8");
		const parsed = asRecord(JSON.parse(raw));
		if (!parsed || typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) return null;
		const providers = asRecord(parsed.providers);
		if (!providers || !isModelsDevProviders(providers)) return null;
		return { timestamp: parsed.timestamp, providers };
	} catch {
		return null;
	}
}

function writeModelsDevCacheFile(cachePath: string, providers: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		const payload: ModelsDevCacheFile = {
			timestamp: Date.now(),
			providers,
		};
		writeFileSync(cachePath, JSON.stringify(payload), "utf8");
	} catch {
		// Ignore write failure (e.g. read-only filesystem)
	}
}

function isModelsDevProviders(value: Record<string, unknown>): boolean {
	return Object.values(value).some((providerValue) => {
		const provider = asRecord(providerValue);
		return asRecord(provider?.models) !== undefined;
	});
}

function buildCatalogFromProviders(providers: Record<string, unknown>): ModelsDevCostCatalog {
	const catalog: ModelsDevCostCatalog = { exact: new Map(), normalized: new Map() };
	for (const [providerId, providerValue] of Object.entries(providers)) {
		const provider = asRecord(providerValue);
		const models = asRecord(provider?.models);
		if (!models) continue;
		for (const [modelId, modelValue] of Object.entries(models)) {
			const model = asRecord(modelValue) as ModelsDevModelPayload | undefined;
			const standard = parseModelsDevCost(model?.cost);
			if (!standard) continue;
			const fast = parseModelsDevCost(model?.experimental?.modes?.fast?.cost);
			addModelsDevEntry(catalog, { providerId, modelId, standard, fast });
		}
	}
	return catalog;
}

export async function fetchModelsDevCostMap(
	agentDir?: string,
	forceRefresh = false,
	signal?: AbortSignal,
): Promise<ModelsDevCostCatalog> {
	const cachePath = getModelsDevCachePath(agentDir);
	const cached = readModelsDevCacheFile(cachePath);

	if (!forceRefresh && cached && Date.now() - cached.timestamp < MODELS_DEV_CACHE_TTL_MS) {
		return buildCatalogFromProviders(cached.providers);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 3000);
	const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		const response = await fetch("https://models.dev/api.json", { signal: requestSignal });
		if (response.ok) {
			const providers = asRecord(await response.json());
			if (providers && isModelsDevProviders(providers)) {
				writeModelsDevCacheFile(cachePath, providers);
				return buildCatalogFromProviders(providers);
			}
		}
	} catch {
		// Retain stale cache if network/JSON fails
	} finally {
		clearTimeout(timeoutId);
	}

	if (cached) {
		return buildCatalogFromProviders(cached.providers);
	}

	return { exact: new Map(), normalized: new Map() };
}

export function matchModelCost(modelId: string, costCatalog: ModelsDevCostCatalog, isFastMode = false): PiProviderCost {
	const entry = findModelsDevEntry(modelId, costCatalog);
	if (!entry) return { ...ZERO_COST };
	return cloneCost(isFastMode && entry.fast ? entry.fast : entry.standard);
}

// ---------------------------------------------------------------------------
// Prompt cache lifetimes
//
// pi only keeps a prompt cache warm when the model declares `promptCache`.
// Sources: pi's built-in catalog and models.dev v2 (`capabilities.cache.explicit.ttl`).
// `short` is the shortest lifetime any source knows: declaring one that is too
// short only adds cheap warm-ups, one that is too long makes pi warm too late.
// Models without explicit-cache data get no lifetime, so pi does not warm them.
// ---------------------------------------------------------------------------

export interface PromptCacheEntry {
	providerId: string;
	modelId: string;
	/** Shortest explicit lifetime in seconds; undefined when the entry has cache data but no explicit lifetime. */
	short?: number;
}

export interface PromptCacheCatalog {
	exact: Map<string, PromptCacheEntry[]>;
	normalized: Map<string, PromptCacheEntry[]>;
}

export interface PromptCacheSources {
	builtin: PromptCacheCatalog;
	modelsDev: PromptCacheCatalog;
}

const TTL_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parse a lifetime such as "5m", "1h", "300s" or 300 into seconds. */
export function parseCacheTtlSeconds(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
	if (typeof value !== "string") return undefined;
	const match = value
		.trim()
		.toLowerCase()
		.match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/);
	if (!match) return undefined;
	const seconds = Number(match[1]) * TTL_UNIT_SECONDS[match[2] || "s"];
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined;
}

export function emptyPromptCacheCatalog(): PromptCacheCatalog {
	return { exact: new Map(), normalized: new Map() };
}

function addPromptCacheEntry(catalog: PromptCacheCatalog, entry: PromptCacheEntry): void {
	const rawId = entry.modelId.trim().toLowerCase();
	for (const key of uniqueStrings([rawId, stripModelNamespace(rawId)])) {
		addCatalogEntry(catalog.exact, key, entry);
	}
	addCatalogEntry(catalog.normalized, normalizeModelKey(rawId), entry);
}

/** models.dev v2 → one entry per model that has cache data. Unknown shapes yield an empty catalog. */
export function buildPromptCacheCatalogFromModelsDevV2(providers: unknown): PromptCacheCatalog {
	const catalog = emptyPromptCacheCatalog();
	const providerMap = asRecord(providers);
	if (!providerMap) return catalog;
	for (const [providerId, providerValue] of Object.entries(providerMap)) {
		const models = asRecord(asRecord(providerValue)?.models);
		if (!models) continue;
		for (const [modelId, modelValue] of Object.entries(models)) {
			const cache = asRecord(asRecord(asRecord(modelValue)?.capabilities)?.cache);
			if (!cache) continue;
			const explicit = asRecord(cache.explicit);
			const ttls = (Array.isArray(explicit?.ttl) ? explicit.ttl : [])
				.map(parseCacheTtlSeconds)
				.filter((seconds): seconds is number => seconds !== undefined);
			addPromptCacheEntry(catalog, {
				providerId,
				modelId,
				...(ttls.length > 0 ? { short: Math.min(...ttls) } : {}),
			});
		}
	}
	return catalog;
}

/** pi's built-in models (`{provider, id, promptCache}`) → catalog of their declared short lifetimes. */
export function buildPromptCacheCatalogFromModels(
	models: ReadonlyArray<{ provider?: string; id?: string; promptCache?: PiProviderModelPromptCache }>,
): PromptCacheCatalog {
	const catalog = emptyPromptCacheCatalog();
	for (const model of models) {
		const short = parseCacheTtlSeconds(model.promptCache?.short);
		if (!model.id || !model.provider || short === undefined) continue;
		addPromptCacheEntry(catalog, { providerId: model.provider, modelId: model.id, short });
	}
	return catalog;
}

function selectPromptCacheShort(entries: PromptCacheEntry[], modelId: string): number | undefined {
	if (entries.length === 0) return undefined;
	for (const providerId of preferredProvidersForModel(modelId)) {
		const match = entries.find((entry) => entry.providerId === providerId);
		if (match) return match.short;
	}
	// No preferred host: only trust a lifetime every listed host agrees has one.
	const shorts = entries.map((entry) => entry.short);
	if (shorts.some((short) => short === undefined)) return undefined;
	return Math.min(...(shorts as number[]));
}

function findPromptCacheEntries(modelId: string, catalog: PromptCacheCatalog): PromptCacheEntry[] {
	const rawId = modelId.trim().toLowerCase();
	for (const lookupId of uniqueStrings([rawId, ...(MODEL_PRICE_ALIASES[rawId] ?? [])])) {
		for (const key of uniqueStrings([lookupId, stripModelNamespace(lookupId)])) {
			const entries = catalog.exact.get(key);
			if (entries?.length) return entries;
		}
		const entries = catalog.normalized.get(normalizeModelKey(lookupId));
		if (entries?.length) return entries;
	}
	return [];
}

export function findPromptCacheShort(modelId: string, catalog: PromptCacheCatalog): number | undefined {
	return selectPromptCacheShort(findPromptCacheEntries(modelId, catalog), modelId);
}

/** `{short}` = the shortest lifetime known for this model id, or undefined when no source knows one. */
/**
 * A lifetime CLIProxyAPI reports for the route (e.g. a pool whose members all keep a 1-hour cache) describes what
 * this model id really gets, so it replaces the catalog's default tier. The catalog's long tier stays.
 */
export function withReportedCacheLifetime(
	promptCache: PiProviderModelPromptCache | undefined,
	reportedSeconds: unknown,
): PiProviderModelPromptCache | undefined {
	if (typeof reportedSeconds !== "number" || !Number.isFinite(reportedSeconds) || reportedSeconds <= 0) {
		return promptCache;
	}
	return { ...promptCache, short: Math.round(reportedSeconds) };
}

export function resolvePromptCache(
	modelId: string,
	sources: PromptCacheSources,
): PiProviderModelPromptCache | undefined {
	const known = [
		findPromptCacheShort(modelId, sources.builtin),
		findPromptCacheShort(modelId, sources.modelsDev),
	].filter((seconds): seconds is number => seconds !== undefined);
	return known.length > 0 ? { short: Math.min(...known) } : undefined;
}

interface PromptCacheFileEntry {
	p: string;
	m: string;
	s?: number;
}

interface PromptCacheFile {
	timestamp: number;
	entries: PromptCacheFileEntry[];
}

function getPromptCacheFilePath(agentDir?: string): string {
	if (agentDir?.trim()) {
		return join(agentDir, "tmp", "models-dev-prompt-cache.json");
	}
	return join(tmpdir(), "pi-cliproxyapi-models-dev-prompt-cache.json");
}

function catalogEntries(catalog: PromptCacheCatalog): PromptCacheEntry[] {
	const seen = new Set<PromptCacheEntry>();
	for (const entries of catalog.normalized.values()) for (const entry of entries) seen.add(entry);
	return [...seen];
}

function readPromptCacheFile(path: string): PromptCacheFile | null {
	try {
		const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed || typeof parsed.timestamp !== "number" || !Array.isArray(parsed.entries)) return null;
		return { timestamp: parsed.timestamp, entries: parsed.entries as PromptCacheFileEntry[] };
	} catch {
		return null;
	}
}

function catalogFromFile(file: PromptCacheFile): PromptCacheCatalog {
	const catalog = emptyPromptCacheCatalog();
	for (const entry of file.entries) {
		if (typeof entry?.p !== "string" || typeof entry?.m !== "string") continue;
		const short = parseCacheTtlSeconds(entry.s);
		addPromptCacheEntry(catalog, { providerId: entry.p, modelId: entry.m, ...(short ? { short } : {}) });
	}
	return catalog;
}

function writePromptCacheFile(path: string, catalog: PromptCacheCatalog): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const entries: PromptCacheFileEntry[] = catalogEntries(catalog).map((entry) => ({
			p: entry.providerId,
			m: entry.modelId,
			...(entry.short ? { s: entry.short } : {}),
		}));
		writeFileSync(path, JSON.stringify({ timestamp: Date.now(), entries } satisfies PromptCacheFile), "utf8");
	} catch {
		// Ignore write failure (e.g. read-only filesystem)
	}
}

/** models.dev v2 cache lifetimes, cached for 24 h; a stale copy is used when models.dev is unreachable. */
export async function fetchModelsDevPromptCacheCatalog(
	agentDir?: string,
	forceRefresh = false,
	signal?: AbortSignal,
): Promise<PromptCacheCatalog> {
	const path = getPromptCacheFilePath(agentDir);
	const cached = readPromptCacheFile(path);
	if (!forceRefresh && cached && Date.now() - cached.timestamp < MODELS_DEV_CACHE_TTL_MS) {
		return catalogFromFile(cached);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10_000);
	const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		const response = await fetch(MODELS_DEV_V2_URL, { signal: requestSignal });
		if (response.ok) {
			const catalog = buildPromptCacheCatalogFromModelsDevV2(await response.json());
			if (catalog.normalized.size > 0) {
				writePromptCacheFile(path, catalog);
				return catalog;
			}
		}
	} catch {
		// Retain stale cache if network/JSON fails
	} finally {
		clearTimeout(timeoutId);
	}
	return cached ? catalogFromFile(cached) : emptyPromptCacheCatalog();
}

/** pi's built-in catalog via the pi-ai peer; empty on pi versions without it. */
export async function loadBuiltinPromptCacheCatalog(): Promise<PromptCacheCatalog> {
	try {
		const builtins = (await import("@earendil-works/pi-ai/providers/all")) as {
			getBuiltinProviders?: () => string[];
			getBuiltinModels?: (
				provider: string,
			) => Array<{ provider?: string; id?: string; promptCache?: PiProviderModelPromptCache }>;
		};
		if (typeof builtins.getBuiltinProviders !== "function" || typeof builtins.getBuiltinModels !== "function") {
			return emptyPromptCacheCatalog();
		}
		const models = builtins.getBuiltinProviders().flatMap((provider) =>
			(builtins.getBuiltinModels?.(provider) ?? []).map((model) => ({
				...model,
				provider: model.provider ?? provider,
			})),
		);
		return buildPromptCacheCatalogFromModels(models);
	} catch {
		return emptyPromptCacheCatalog();
	}
}

export async function loadPromptCacheSources(
	agentDir?: string,
	forceRefresh = false,
	signal?: AbortSignal,
): Promise<PromptCacheSources> {
	const [builtin, modelsDev] = await Promise.all([
		loadBuiltinPromptCacheCatalog(),
		fetchModelsDevPromptCacheCatalog(agentDir, forceRefresh, signal),
	]);
	return { builtin, modelsDev };
}

// ---------------------------------------------------------------------------
// Claude Messages format (opt-in)
//
// CPA accepts Claude's own format at /v1/messages. Sending Claude models in that
// format lets pi use Anthropic features the Codex format can't express, such as
// the 1-hour cache tier (PI_CACHE_RETENTION=long → cache_control ttl "1h"), which
// CPA passes through untouched. A model uses it when CPA lists it as owned by
// Anthropic and pi's built-in catalog knows the model (its compat flags, thinking
// levels and cache tiers are copied); anything else stays on the Codex format.
// ---------------------------------------------------------------------------

export interface ClaudeFormatEntry {
	reasoning: boolean;
	compat?: PiProviderModelCompat;
	thinkingLevelMap?: ThinkingLevelMap;
	promptCache?: PiProviderModelPromptCache;
}

interface BuiltinAnthropicModel {
	id?: string;
	reasoning?: boolean;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: ThinkingLevelMap;
	promptCache?: PiProviderModelPromptCache;
}

export interface ClaudeFormatCatalog {
	exact: Map<string, ClaudeFormatEntry>;
	normalized: Map<string, ClaudeFormatEntry>;
}

export function buildClaudeFormatCatalog(models: ReadonlyArray<BuiltinAnthropicModel>): ClaudeFormatCatalog {
	const catalog: ClaudeFormatCatalog = { exact: new Map(), normalized: new Map() };
	for (const model of models) {
		const id = model.id?.trim().toLowerCase();
		if (!id) continue;
		const entry: ClaudeFormatEntry = {
			reasoning: model.reasoning === true,
			...(model.compat ? { compat: { ...model.compat } } : {}),
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
			...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
		};
		if (!catalog.exact.has(id)) catalog.exact.set(id, entry);
		const key = normalizeModelKey(id);
		if (key && !catalog.normalized.has(key)) catalog.normalized.set(key, entry);
	}
	return catalog;
}

export function findClaudeFormatEntry(modelId: string, catalog: ClaudeFormatCatalog): ClaudeFormatEntry | undefined {
	const rawId = modelId.trim().toLowerCase();
	return (
		catalog.exact.get(rawId) ??
		catalog.exact.get(stripModelNamespace(rawId)) ??
		catalog.normalized.get(normalizeModelKey(rawId))
	);
}

/** pi's built-in Anthropic models via the pi-ai peer; empty on pi versions without it. */
export async function loadBuiltinClaudeFormatCatalog(): Promise<ClaudeFormatCatalog> {
	try {
		const builtins = (await import("@earendil-works/pi-ai/providers/all")) as {
			getBuiltinModels?: (provider: string) => BuiltinAnthropicModel[];
		};
		if (typeof builtins.getBuiltinModels !== "function") {
			return buildClaudeFormatCatalog([]);
		}
		return buildClaudeFormatCatalog(builtins.getBuiltinModels("anthropic") ?? []);
	} catch {
		return buildClaudeFormatCatalog([]);
	}
}

/** Model id → owned_by from CPA's plain OpenAI model list. Empty on any failure. */
export async function fetchModelOwners(
	plainModelsUrl: string,
	apiKey: string,
	timeoutMs = MODELS_REQUEST_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const owners = new Map<string, string>();
	try {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const response = await fetch(plainModelsUrl, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
		if (!response.ok) return owners;
		const data = asRecord(await response.json())?.data;
		for (const item of Array.isArray(data) ? data : []) {
			const record = asRecord(item);
			const id = typeof record?.id === "string" ? record.id.trim() : "";
			const ownedBy = typeof record?.owned_by === "string" ? record.owned_by.trim().toLowerCase() : "";
			if (id && ownedBy) owners.set(id, ownedBy);
		}
	} catch {
		// Without owners every model stays on the Codex format.
	}
	return owners;
}

/** The Claude-format entry for a model, or undefined when it stays on the Codex format. */
export function claudeFormatFor(
	modelId: string,
	owners: Map<string, string>,
	catalog: ClaudeFormatCatalog,
): ClaudeFormatEntry | undefined {
	if (owners.get(modelId) !== "anthropic") return undefined;
	return findClaudeFormatEntry(modelId, catalog);
}

export async function loadMappedModels(
	baseUrlInput: string,
	apiKey: string,
	timeoutOrFastMode: number | boolean = MODELS_REQUEST_TIMEOUT_MS,
	agentDir?: string,
	signal?: AbortSignal,
	claudeMessages = false,
): Promise<MappedModels> {
	const pricingEnabled = typeof timeoutOrFastMode === "boolean";
	const effectiveFastMode = typeof timeoutOrFastMode === "boolean" ? timeoutOrFastMode : false;
	const timeoutMs = typeof timeoutOrFastMode === "number" ? timeoutOrFastMode : MODELS_REQUEST_TIMEOUT_MS;
	const endpoints = resolveEndpoints(baseUrlInput);
	const [remoteModels, costCatalog, promptCacheSources, owners, claudeCatalog] = await Promise.all([
		fetchCodexModels(endpoints.modelsUrl, apiKey, timeoutMs, signal),
		pricingEnabled ? fetchModelsDevCostMap(agentDir, false, signal) : Promise.resolve(undefined),
		pricingEnabled ? loadPromptCacheSources(agentDir, false, signal) : Promise.resolve(undefined),
		claudeMessages
			? fetchModelOwners(endpoints.plainModelsUrl, apiKey, timeoutMs, signal)
			: Promise.resolve(undefined),
		claudeMessages ? loadBuiltinClaudeFormatCatalog() : Promise.resolve(undefined),
	]);
	const claudeFormatIds = new Set<string>();
	const models = remoteModels
		.map((model) => {
			const claudeFormat =
				owners && claudeCatalog ? claudeFormatFor(codexModelId(model), owners, claudeCatalog) : undefined;
			const mapped = toPiModel(model, costCatalog, effectiveFastMode, promptCacheSources, claudeFormat);
			if (mapped && claudeFormat) claudeFormatIds.add(mapped.id);
			return mapped;
		})
		.filter((model): model is PiProviderModel => model !== null);
	// Fast mode is a Codex-format service tier; Claude-format models don't use it.
	const fastModelIds = Array.from(
		new Set(
			remoteModels
				.filter(supportsFastServiceTier)
				.map(codexModelId)
				.filter((modelId) => modelId.length > 0 && !claudeFormatIds.has(modelId)),
		),
	);

	// Empty catalog is valid: credentials passed (HTTP 200), just no usable models yet.
	return {
		models,
		fastModelIds,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
		...(pricingEnabled ? { fastMode: effectiveFastMode } : {}),
		...(claudeMessages ? { claudeMessages: true } : {}),
	};
}

export const DEFAULT_MODEL_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MergeModelsResult {
	merged: MappedModels;
	retainedStaleModels: PiProviderModel[];
	droppedModelIds: string[];
}

/**
 * Merge newly fetched models with the existing disk cache to prevent transient
 * upstream pruning (such as HTTP 503 / 429 capacity blips) from wiping out valid models.
 */
export function mergeModelsWithExistingCache(
	existingCache: ModelsCacheFile | null,
	fresh: MappedModels,
	now = Date.now(),
	staleTtlMs = DEFAULT_MODEL_STALE_TTL_MS,
): MergeModelsResult {
	if (!existingCache || !Array.isArray(existingCache.models) || existingCache.models.length === 0) {
		const modelsWithTimestamp = fresh.models.map((model) => ({
			...model,
			lastSeenAt: now,
			stale: false,
		}));
		return {
			merged: {
				...fresh,
				models: modelsWithTimestamp,
			},
			retainedStaleModels: [],
			droppedModelIds: [],
		};
	}

	const freshModelMap = new Map<string, PiProviderModel>();
	const freshFastSet = new Set(fresh.fastModelIds);

	for (const model of fresh.models) {
		const updated: PiProviderModel = {
			...model,
			lastSeenAt: now,
			stale: false,
		};
		delete updated.staleSince;
		freshModelMap.set(model.id, updated);
	}

	const retainedStaleModels: PiProviderModel[] = [];
	const droppedModelIds: string[] = [];

	for (const prevModel of existingCache.models) {
		if (freshModelMap.has(prevModel.id)) {
			continue;
		}
		const lastSeen = prevModel.lastSeenAt ?? existingCache.fetchedAt ?? now;
		const isFirstMissing = prevModel.stale !== true;
		const staleSince = isFirstMissing ? now : (prevModel.staleSince ?? lastSeen);

		// Retain models from the moment they first go missing until they have been
		// missing across the full stale retention window.
		if (now - staleSince < staleTtlMs) {
			const retained: PiProviderModel = {
				...prevModel,
				lastSeenAt: lastSeen,
				staleSince,
				stale: true,
			};
			retainedStaleModels.push(retained);
			if (existingCache.fastModelIds?.includes(prevModel.id) && !freshFastSet.has(prevModel.id)) {
				freshFastSet.add(prevModel.id);
			}
		} else {
			droppedModelIds.push(prevModel.id);
		}
	}

	const mergedModels = [...freshModelMap.values(), ...retainedStaleModels];

	return {
		merged: {
			...fresh,
			models: mergedModels,
			fastModelIds: Array.from(freshFastSet),
		},
		retainedStaleModels,
		droppedModelIds,
	};
}

/**
 * Load mapped models from the matching cache, or fetch remotely and update the cache.
 * A forced refresh bypasses the cache read but still retains models missing from the
 * fresh catalog. replaceCache writes that catalog as-is after a successful fetch.
 */
export async function resolveMappedModels(
	agentDir: string,
	baseUrlInput: string,
	apiKey: string,
	options: {
		forceRefresh?: boolean;
		replaceCache?: boolean;
		fastMode?: boolean;
		claudeMessages?: boolean;
		signal?: AbortSignal;
		shouldCommit?: () => boolean;
		staleTtlMs?: number;
	} = {},
): Promise<ResolvedModelsResult> {
	const cacheMatchesFastMode = (cache: ModelsCacheFile): boolean =>
		(options.fastMode === undefined || (cache.fastMode ?? false) === options.fastMode) &&
		(cache.claudeMessages ?? false) === (options.claudeMessages ?? false);

	const existingCache = loadModelsCache(agentDir, baseUrlInput);
	if (!options.forceRefresh && !options.replaceCache) {
		if (existingCache && cacheMatchesFastMode(existingCache)) {
			return { loaded: existingCache, fromCache: true };
		}
	}

	const fresh = await loadMappedModels(
		baseUrlInput,
		apiKey,
		options.fastMode,
		agentDir,
		options.signal,
		options.claudeMessages ?? false,
	);
	const { merged } = mergeModelsWithExistingCache(
		options.replaceCache ? null : existingCache,
		fresh,
		Date.now(),
		options.staleTtlMs,
	);
	if (!options.signal?.aborted && (options.shouldCommit?.() ?? true)) {
		saveModelsCache(agentDir, merged);
	}
	return { loaded: merged, fromCache: false };
}
