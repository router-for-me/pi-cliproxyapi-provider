/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login`:
 * 1. Provider is registered as OAuth-only so `/login CLIProxyAPI` / `/login cliproxyapi`
 *    skip the API-key vs account selector and go straight to multi-field prompts
 *    (pi only supports multi-field prompts on the account/OAuth path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI` or `/login cliproxyapi`.
 * 3. Setup prompts for baseUrl + apiKey.
 * 4. Final login step validates credentials via /v1/models?client_version=pi
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 5. On success, models/credentials are saved and registered immediately.
 * 6. `/fast` globally controls catalog-driven priority service tier injection.
 *
 * Uses a patched openai-codex-responses implementation that does not require
 * extracting chatgpt_account_id from the API key (plain CPA keys work).
 *
 * Non-interactive setup still works via env vars or ~/.pi/agent/cliproxyapi.json.
 */

import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProactiveCompactionController } from "./auto-compact.ts";
import { CLIPROXYAPI_CODEX_API, type CliproxyCodexStreamSimple, loadCliproxyCodexStreams } from "./codex-stream.ts";
import { FastModeController } from "./fast.ts";
import { FastFooterController } from "./fast-footer.ts";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	type PiProviderModel,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolveMappedModels,
	resolvePauseDefault,
	saveConfigFile,
} from "./lib.ts";
import type { PauseController } from "./pause.ts";
import { pauseController, waitForPauseToEnd } from "./pause.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";

class ConfigPersistenceError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to save ${CONFIG_FILE_NAME}: ${message}`, { cause });
		this.name = "ConfigPersistenceError";
	}
}

interface RefreshResult {
	modelCount: number;
	modelsUrl: string;
}

class ModelRefreshCoordinator {
	private generation = 0;
	private activeController: AbortController | undefined;

	begin(): { generation: number; signal: AbortSignal } {
		this.activeController?.abort();
		const controller = new AbortController();
		this.activeController = controller;
		this.generation += 1;
		return { generation: this.generation, signal: controller.signal };
	}

	isCurrent(generation: number): boolean {
		return this.generation === generation;
	}
}

function logWarn(message: string): void {
	console.warn(`[pi-cliproxyapi-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-cliproxyapi-provider] ${message}`);
}

function hasLoginCredential(agentDir: string, providerId: string): boolean {
	try {
		return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
	} catch {
		return false;
	}
}

function buildOAuthCredentials(baseUrlInput: string, apiKey: string): OAuthCredentials {
	return {
		refresh: encodeRefreshMeta(baseUrlInput),
		access: apiKey,
		expires: Date.now() + CREDENTIAL_TTL_MS,
	};
}

function resolveDefaultBaseUrl(agentDir: string, providerId: string): string {
	let fileBaseUrl: string | undefined;
	try {
		fileBaseUrl = loadConfigFile(agentDir).baseUrl;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			logWarn(`failed to read ${CONFIG_FILE_NAME}: ${err.message}`);
		}
	}

	let authBaseUrl: string | undefined;
	try {
		authBaseUrl = loadAuthConnection(agentDir, providerId)?.baseUrl;
	} catch (error) {
		const err = error as Error;
		logWarn(`failed to read auth.json: ${err.message}`);
	}

	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, fileBaseUrl, authBaseUrl, DEFAULT_BASE_URL)!;
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.("Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).");

	const baseUrlRaw = await callbacks.onPrompt({
		message: `CLIProxyAPI base URL [${defaults.baseUrl}]:`,
		placeholder: defaults.baseUrl,
		allowEmpty: true,
	});
	const baseUrlInput = firstNonEmpty(baseUrlRaw, defaults.baseUrl)!;

	// Validate early so users get a clear error before typing the API key.
	resolveEndpoints(baseUrlInput);

	const apiKey = (
		await callbacks.onPrompt({
			message: "CLIProxyAPI API key:",
			placeholder: "sk-...",
			allowEmpty: false,
		})
	).trim();

	if (!apiKey) {
		throw new Error("API key cannot be empty.");
	}

	return { baseUrlInput, apiKey };
}

async function configureAndRegister(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	baseUrlInput: string;
	apiKey: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
	refreshCoordinator: ModelRefreshCoordinator;
	onFastModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
}): Promise<RefreshResult> {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
	} = options;

	const refresh = refreshCoordinator.begin();
	const { loaded } = await resolveMappedModels(agentDir, baseUrlInput, apiKey, {
		forceRefresh: true,
		fastMode: fastMode.isEnabled(),
		signal: refresh.signal,
		shouldCommit: () => refreshCoordinator.isCurrent(refresh.generation),
	});
	if (!refreshCoordinator.isCurrent(refresh.generation)) {
		throw new Error("Model refresh was superseded by a newer request.");
	}

	try {
		saveConfigFile(agentDir, {
			baseUrl: baseUrlInput,
			apiKey,
			providerId,
			providerName,
		});
	} catch (error) {
		throw new ConfigPersistenceError(error);
	}

	// /login stores oauth credentials itself; keep the provider OAuth-only so
	// `/login <provider>` skips the API-key vs account selector.
	registerProvider(pi, {
		providerId,
		providerName,
		baseUrlInput,
		models: loaded.models,
		defaultBaseUrl: baseUrlInput || defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
	});
	fastMode.setSupportedModelIds(loaded.fastModelIds);

	return { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
}

function createOAuthHandlers(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
	refreshCoordinator: ModelRefreshCoordinator;
	onFastModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
}) {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
	} = options;

	return {
		name: providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			let promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;

			// Final login step: validate by calling /v1/models.
			// HTTP 200 (even with an empty catalog) means success; otherwise re-prompt.
			while (true) {
				const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
					baseUrl: promptDefaultBaseUrl,
				});

				callbacks.onProgress?.("Validating credentials via models endpoint...");
				try {
					const result = await configureAndRegister({
						pi,
						agentDir,
						providerId,
						providerName,
						baseUrlInput,
						apiKey,
						defaultBaseUrl,
						streamSimple,
						fastMode,
						refreshCoordinator,
						onFastModeChange,
					});

					logInfo(`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
					return buildOAuthCredentials(baseUrlInput, apiKey);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`login validation failed: ${message}`);
					if (error instanceof ConfigPersistenceError) {
						callbacks.onProgress?.(message);
						throw error;
					}
					callbacks.onProgress?.(`Login validation failed: ${message}\nPlease re-enter base URL and API key.`);
					// Keep last baseUrl as the next default so retyping is easier.
					promptDefaultBaseUrl = baseUrlInput || promptDefaultBaseUrl;
				}
			}
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			// API keys do not expire; keep the stored payload as-is.
			return {
				...credentials,
				expires: Date.now() + CREDENTIAL_TTL_MS,
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
			const meta = decodeRefreshMeta(credentials.refresh);
			if (!meta?.baseUrl) {
				return models;
			}
			try {
				const { inferenceBaseUrl } = resolveEndpoints(meta.baseUrl);
				return models.map((model) =>
					model.provider === providerId ? { ...model, baseUrl: inferenceBaseUrl } : model,
				);
			} catch {
				return models;
			}
		},
	};
}

function registerProvider(
	pi: ExtensionAPI,
	options: {
		providerId: string;
		providerName: string;
		baseUrlInput: string;
		apiKey?: string;
		models?: PiProviderModel[];
		defaultBaseUrl: string;
		agentDir: string;
		streamSimple: CliproxyCodexStreamSimple;
		fastMode: FastModeController;
		refreshCoordinator?: ModelRefreshCoordinator;
		onFastModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
	},
): void {
	const {
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		models,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
		onFastModeChange,
	} = options;
	const refreshCoordinator = options.refreshCoordinator ?? new ModelRefreshCoordinator();

	const endpoints = resolveEndpoints(baseUrlInput);
	const oauth = createOAuthHandlers({
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onFastModeChange,
	});

	// Replace any previous registration so an earlier ambient apiKey does not linger
	// via registerProvider merge semantics and reintroduce the auth-type selector.
	pi.unregisterProvider(providerId);

	pi.registerProvider(providerId, {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		// OAuth-only keeps `/login <provider>` on the multi-field account path.
		// Pass apiKey only for ambient request auth when no /login credential exists
		// (config file / env). Never pass both for /login flows.
		oauth,
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

export function registerPauseCommands(options: {
	pi: ExtensionAPI;
	agentDir: string;
	pauseMode: PauseController;
}): void {
	const { pi, agentDir, pauseMode } = options;

	const setPause = async (
		enabled: boolean,
		commandName: string,
		args: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		if (args.trim()) {
			ctx.ui.notify(`Usage: /${commandName}`, "error");
			return;
		}

		try {
			saveConfigFile(agentDir, { pause: enabled });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to save pause mode: ${message}`, "error");
			return;
		}

		pauseMode.setEnabled(enabled);
		ctx.ui.notify(enabled ? "Requests are paused." : "Requests are continued.", "info");
	};

	pi.registerCommand("pause", {
		description: "Pause provider requests until /continue is used.",
		handler: async (args, ctx) => setPause(true, "pause", args, ctx),
	});

	pi.registerCommand("continue", {
		description: "Continue provider requests paused by /pause.",
		handler: async (args, ctx) => setPause(false, "continue", args, ctx),
	});
}

export function registerPauseGuard(options: { pi: ExtensionAPI; agentDir: string; pauseMode: PauseController }): void {
	const { pi, agentDir, pauseMode } = options;
	pi.on("before_provider_request", async () => {
		await waitForPauseToEnd(agentDir, pauseMode);
	});
}

export function registerFastCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	fastMode: FastModeController;
	onStatusChange?: (ctx: ExtensionContext) => void;
	onModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
}): void {
	const { pi, agentDir, providerId, fastMode, onStatusChange, onModeChange } = options;
	let modeChangeInProgress = false;

	pi.registerCommand("fast", {
		description: "Toggle CLIProxyAPI Fast mode globally.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "error");
				return;
			}
			if (modeChangeInProgress) {
				ctx.ui.notify("Fast mode is already being refreshed. Try again when it finishes.", "warning");
				return;
			}

			modeChangeInProgress = true;
			try {
				const previousEnabled = fastMode.isEnabled();
				const enabled = !previousEnabled;
				try {
					saveConfigFile(agentDir, { fast: enabled });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save Fast mode: ${message}`, "error");
					return;
				}
				fastMode.setEnabled(enabled);
				try {
					await onModeChange?.(enabled, ctx);
				} catch (error) {
					// Restore all three views of the mode after a partial refresh:
					// in-memory request behavior, persisted preference, and model metadata.
					fastMode.setEnabled(previousEnabled);
					const rollbackErrors: string[] = [];
					try {
						saveConfigFile(agentDir, { fast: previousEnabled });
					} catch (rollbackError) {
						rollbackErrors.push(
							`config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					try {
						await onModeChange?.(previousEnabled, ctx);
					} catch (rollbackError) {
						rollbackErrors.push(
							`pricing rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					const message = error instanceof Error ? error.message : String(error);
					const rollbackSuffix = rollbackErrors.length > 0 ? ` (${rollbackErrors.join("; ")})` : "";
					ctx.ui.notify(`Failed to refresh model pricing: ${message}${rollbackSuffix}`, "warning");
					onStatusChange?.(ctx);
					return;
				}
				onStatusChange?.(ctx);

				const currentModel = ctx.model;
				if (!currentModel || currentModel.provider !== providerId || !fastMode.isModelSupported(currentModel.id)) {
					if (enabled) {
						ctx.ui.notify("Fast mode is enabled globally, but the current model does not support it.", "warning");
					} else {
						ctx.ui.notify("Fast mode is disabled globally.", "info");
					}
				}
			} finally {
				modeChangeInProgress = false;
			}
		},
	});
}

export function registerRefreshCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
	refreshCoordinator?: ModelRefreshCoordinator;
	onRefresh?: (connection: NonNullable<ReturnType<typeof resolveConnection>>) => Promise<RefreshResult | undefined>;
}): void {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator,
		onRefresh,
	} = options;

	pi.registerCommand("cliproxyapi-refresh", {
		description: "Force refresh CLIProxyAPI models from the remote catalog.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
				return;
			}

			const connection = resolveConnection(agentDir, providerId);
			if (!connection) {
				ctx.ui.notify(
					`CLIProxyAPI is not configured. Use /login ${providerName} or /login ${providerId}.`,
					"error",
				);
				return;
			}

			try {
				let result: RefreshResult | undefined;
				if (onRefresh) {
					result = await onRefresh(connection);
					if (!result) return;
				} else {
					const refresh = refreshCoordinator?.begin();
					const { loaded } = await resolveMappedModels(agentDir, connection.baseUrlInput, connection.apiKey, {
						forceRefresh: true,
						fastMode: fastMode.isEnabled(),
						signal: refresh?.signal,
						shouldCommit: refresh ? () => refreshCoordinator?.isCurrent(refresh.generation) ?? true : undefined,
					});
					if (refresh && !refreshCoordinator?.isCurrent(refresh.generation)) return;
					fastMode.setSupportedModelIds(loaded.fastModelIds);

					const hasStoredLogin = hasLoginCredential(agentDir, providerId);
					registerProvider(pi, {
						providerId,
						providerName,
						baseUrlInput: connection.baseUrlInput,
						apiKey: hasStoredLogin ? undefined : connection.apiKey,
						models: loaded.models,
						defaultBaseUrl,
						agentDir,
						streamSimple,
						fastMode,
						refreshCoordinator,
					});

					result = { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
				}

				ctx.ui.notify(`Refreshed ${result.modelCount} CLIProxyAPI models from ${result.modelsUrl}.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh CLIProxyAPI models: ${message}`, "error");
			}
		},
	});
}

export { CLIPROXYAPI_CODEX_API } from "./codex-stream.ts";
export { resolveEndpoints, toPiModel } from "./lib.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);
	const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);

	let pauseEnabled = false;
	try {
		pauseEnabled = resolvePauseDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid pause configuration (${message}); using pause=false`);
	}
	pauseController.setEnabled(pauseEnabled);
	registerPauseCommands({ pi, agentDir, pauseMode: pauseController });
	registerPauseGuard({ pi, agentDir, pauseMode: pauseController });

	const proactiveCompaction = new ProactiveCompactionController(agentDir, identity.providerId);
	proactiveCompaction.register(pi);

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid Fast configuration (${message}); using fast=false`);
	}
	const fastMode = new FastModeController(fastEnabled);
	const modelRefreshCoordinator = new ModelRefreshCoordinator();

	let streamSimple: CliproxyCodexStreamSimple;
	try {
		const streams = await loadCliproxyCodexStreams([identity.providerId, "cliproxyapi"], {
			shouldUseFast: (model) => model.provider === identity.providerId && fastMode.isEffectiveFor(model.id),
		});
		proactiveCompaction.setCloseWebSocketSessions(streams.closeOpenAICodexWebSocketSessions);
		streamSimple = proactiveCompaction.wrapStreamSimple(streams.streamSimple);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load patched codex protocol: ${message}`);
		return;
	}

	const fastFooter = new FastFooterController(identity.providerId, fastMode, () =>
		proactiveCompaction.getCompactionSettings(),
	);
	let refreshModelsForFast: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	const onFastModeChange = async (_enabled: boolean, ctx: ExtensionContext): Promise<void> => {
		await refreshModelsForFast?.(ctx);
	};
	registerFastCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		fastMode,
		onStatusChange: (ctx) => fastFooter.refresh(ctx),
		onModeChange: onFastModeChange,
	});
	fastFooter.register(pi);

	// Always register oauth so the provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
		refreshCoordinator: modelRefreshCoordinator,
		onFastModeChange: onFastModeChange,
	});
	registerTransientNetworkErrorRetry(pi, identity.providerId);

	const connection = resolveConnection(agentDir, identity.providerId);
	const registerConfiguredProvider = async (
		currentConnection: NonNullable<ReturnType<typeof resolveConnection>>,
		options: { forceRefresh?: boolean } = {},
	): Promise<RefreshResult | undefined> => {
		const refresh = modelRefreshCoordinator.begin();
		try {
			const { loaded, fromCache } = await resolveMappedModels(
				agentDir,
				currentConnection.baseUrlInput,
				currentConnection.apiKey,
				{
					forceRefresh: options.forceRefresh,
					fastMode: fastMode.isEnabled(),
					signal: refresh.signal,
					shouldCommit: () => modelRefreshCoordinator.isCurrent(refresh.generation),
				},
			);
			if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;

			fastMode.setSupportedModelIds(loaded.fastModelIds);

			// Prefer OAuth-only registration when /login already stored credentials so
			// `/login <provider>` jumps straight into the multi-field flow. Fall back to
			// ambient apiKey only for config-file / env setups without auth.json.
			const hasStoredLogin = hasLoginCredential(agentDir, identity.providerId);
			registerProvider(pi, {
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: currentConnection.baseUrlInput,
				apiKey: hasStoredLogin ? undefined : currentConnection.apiKey,
				models: loaded.models,
				defaultBaseUrl,
				agentDir,
				streamSimple,
				fastMode,
				refreshCoordinator: modelRefreshCoordinator,
				onFastModeChange,
			});

			if (fromCache && !options.forceRefresh) {
				void registerConfiguredProvider(currentConnection, { forceRefresh: true }).catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`failed to refresh cached models (${message}); keeping the cached model list.`);
				});
			}

			return { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
		} catch (error) {
			if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;
			throw error;
		}
	};
	refreshModelsForFast = async (ctx: ExtensionContext): Promise<void> => {
		const currentConnection = resolveConnection(agentDir, identity.providerId);
		if (!currentConnection) return;

		const refreshed = await registerConfiguredProvider(currentConnection, { forceRefresh: true });
		if (!refreshed) return;
		const currentModel = ctx.model;
		if (!currentModel || currentModel.provider !== identity.providerId) return;

		const refreshedModel = ctx.modelRegistry.find(identity.providerId, currentModel.id);
		if (!refreshedModel) {
			throw new Error(`Refreshed model ${identity.providerId}/${currentModel.id} is unavailable`);
		}
		if (JSON.stringify(refreshedModel.cost) === JSON.stringify(currentModel.cost)) return;
		if (!(await pi.setModel(refreshedModel))) {
			throw new Error(`Unable to activate refreshed model ${identity.providerId}/${currentModel.id}`);
		}
	};
	registerRefreshCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
		refreshCoordinator: modelRefreshCoordinator,
		onRefresh: (currentConnection) => registerConfiguredProvider(currentConnection, { forceRefresh: true }),
	});

	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		await registerConfiguredProvider(connection);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			logWarn(`models request unauthorized (${message}). Use /login ${identity.providerName} to reconfigure.`);
		} else {
			logWarn(
				`failed to load models (${message}). Use /login ${identity.providerName} or check ${CONFIG_FILE_NAME} / CLIPROXYAPI_* env vars.`,
			);
		}
	}
}
