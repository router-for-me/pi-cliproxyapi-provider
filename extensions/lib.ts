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

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

// --- Context-cap support ---
// Reads from ~/.pi/agent/extensions/context-cap.json (shared with pi-context-cap extension).

interface ContextCapConfig {
	cap?: number;
	maxTokens?: number;
	appliesOver?: number;
	matchPatterns?: string[];
	models?: Record<string, number | { contextWindow?: number; maxTokens?: number }>;
}

let _capConfig: ContextCapConfig | null = null;
let _capConfigLoaded = false;

function loadCapConfig(): ContextCapConfig {
	if (_capConfigLoaded) return _capConfig ?? {};
	_capConfigLoaded = true;
	try {
		const agentDir = process.env.PI_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent");
		const capPath = join(agentDir, "extensions", "context-cap.json");
		const raw = readFileSync(capPath, "utf-8");
		_capConfig = JSON.parse(raw) as ContextCapConfig;
	} catch {
		_capConfig = {};
	}
	return _capConfig ?? {};
}

function matchesPatterns(modelId: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const id = modelId.toLowerCase();
	return patterns.some((p) => p === "*" || id.includes(p.toLowerCase()));
}

/** Apply context-cap config to a model's contextWindow and maxTokens. */
function applyCap(id: string, contextWindow: number, maxTokens: number): { contextWindow: number; maxTokens: number } {
	const cfg = loadCapConfig();
	let cw = contextWindow;
	let mt = maxTokens;

	// Per-model override wins
	const perModel = cfg.models?.[id];
	if (perModel != null) {
		if (typeof perModel === "number") {
			if (cw > perModel) cw = perModel;
		} else {
			if (perModel.contextWindow != null && cw > perModel.contextWindow) cw = perModel.contextWindow;
			if (perModel.maxTokens != null && mt > perModel.maxTokens) mt = perModel.maxTokens;
		}
		return { contextWindow: cw, maxTokens: mt };
	}

	// Global cap
	const patterns = cfg.matchPatterns ?? [];
	if (!matchesPatterns(id, patterns)) return { contextWindow: cw, maxTokens: mt };

	const appliesOver = cfg.appliesOver ?? 200_000;
	const cap = cfg.cap ?? 200_000;
	if (cw > appliesOver && cw > cap) cw = cap;

	const capMaxTokens = cfg.maxTokens ?? 0;
	if (capMaxTokens > 0 && mt > capMaxTokens) mt = capMaxTokens;

	return { contextWindow: cw, maxTokens: mt };
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export interface CliproxyConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
	fast?: boolean;
	pause?: boolean;
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
	input_modalities?: string[];
	supported_reasoning_levels?: CodexReasoningLevel[] | string[];
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

export interface PiProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: PiProviderCost;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface MappedModels {
	models: PiProviderModel[];
	fastModelIds: string[];
	inferenceBaseUrl: string;
	modelsUrl: string;
	fastMode?: boolean;
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

export function toPiModel(
	model: CodexClientModel,
	costCatalog?: ModelsDevCostCatalog,
	fastMode = false,
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

	// Apply context-cap config
	const capped = applyCap(id, contextWindow, DEFAULT_MAX_TOKENS);

	return {
		id,
		name: (model.display_name ?? model.name ?? id).trim() || id,
		reasoning: hasReasoning,
		input: buildInputModalities(model),
		cost,
		contextWindow: capped.contextWindow,
		maxTokens: capped.maxTokens,
		thinkingLevelMap: buildThinkingLevelMap(efforts),
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

function stripModelNamespace(modelId: string): string {
	return modelId.trim().toLowerCase().replace(MODEL_NAMESPACE_PREFIX, "");
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

function addCatalogEntry(catalog: Map<string, ModelsDevCostEntry[]>, key: string, entry: ModelsDevCostEntry): void {
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

export async function loadMappedModels(
	baseUrlInput: string,
	apiKey: string,
	timeoutOrFastMode: number | boolean = MODELS_REQUEST_TIMEOUT_MS,
	agentDir?: string,
	signal?: AbortSignal,
): Promise<MappedModels> {
	const pricingEnabled = typeof timeoutOrFastMode === "boolean";
	const effectiveFastMode = typeof timeoutOrFastMode === "boolean" ? timeoutOrFastMode : false;
	const timeoutMs = typeof timeoutOrFastMode === "number" ? timeoutOrFastMode : MODELS_REQUEST_TIMEOUT_MS;
	const endpoints = resolveEndpoints(baseUrlInput);
	const [remoteModels, costCatalog] = await Promise.all([
		fetchCodexModels(endpoints.modelsUrl, apiKey, timeoutMs, signal),
		pricingEnabled ? fetchModelsDevCostMap(agentDir, false, signal) : Promise.resolve(undefined),
	]);
	const models = remoteModels
		.map((model) => toPiModel(model, costCatalog, effectiveFastMode))
		.filter((model): model is PiProviderModel => model !== null);
	const fastModelIds = Array.from(
		new Set(
			remoteModels
				.filter(supportsFastServiceTier)
				.map(codexModelId)
				.filter((modelId) => modelId.length > 0),
		),
	);

	// Empty catalog is valid: credentials passed (HTTP 200), just no usable models yet.
	return {
		models,
		fastModelIds,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
		...(pricingEnabled ? { fastMode: effectiveFastMode } : {}),
	};
}

/**
 * Load mapped models from the matching cache, or fetch remotely and update the cache.
 * A forced refresh always bypasses the cache.
 */
export async function resolveMappedModels(
	agentDir: string,
	baseUrlInput: string,
	apiKey: string,
	options: {
		forceRefresh?: boolean;
		fastMode?: boolean;
		signal?: AbortSignal;
		shouldCommit?: () => boolean;
	} = {},
): Promise<ResolvedModelsResult> {
	const cacheMatchesFastMode = (cache: ModelsCacheFile): boolean =>
		options.fastMode === undefined || (cache.fastMode ?? false) === options.fastMode;

	if (!options.forceRefresh) {
		const cache = loadModelsCache(agentDir, baseUrlInput);
		if (cache && cacheMatchesFastMode(cache)) {
			return { loaded: cache, fromCache: true };
		}
	}

	const loaded = await loadMappedModels(baseUrlInput, apiKey, options.fastMode, agentDir, options.signal);
	if (!options.signal?.aborted && (options.shouldCommit?.() ?? true)) {
		saveModelsCache(agentDir, loaded);
	}
	return { loaded, fromCache: false };
}
