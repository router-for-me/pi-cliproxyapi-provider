import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { FastModeController } from "./fast.ts";
import { loadModelsCache, type PiProviderModel, type ResolvedConnection, resolveMappedModels } from "./lib.ts";

class RefreshGeneration {
	private generation = 0;
	private activeController: AbortController | undefined;

	begin(parentSignal: AbortSignal): { generation: number; signal: AbortSignal } {
		this.activeController?.abort();
		const controller = new AbortController();
		this.activeController = controller;
		this.generation += 1;
		return {
			generation: this.generation,
			signal: AbortSignal.any([parentSignal, controller.signal]),
		};
	}

	isCurrent(generation: number): boolean {
		return this.generation === generation;
	}
}

function directRefreshContext(allowNetwork: boolean, signal: AbortSignal): RefreshModelsContext {
	return {
		allowNetwork,
		...(allowNetwork ? { force: true } : {}),
		signal,
		publish: async ({ update }) => {
			if (signal.aborted) return false;
			update?.();
			return true;
		},
	};
}

/**
 * Owns the extension's stable catalog reference and its single Pi refresh seam.
 * Pi supplies lifecycle contexts after registration; startup and login use the
 * same callback with a direct context before Pi can initiate a refresh.
 */
export class ModelCatalogController {
	private readonly models: PiProviderModel[] = [];
	private readonly refreshGeneration = new RefreshGeneration();

	constructor(
		private readonly agentDir: string,
		private readonly fastMode: FastModeController,
		private readonly resolveConnection: () => ResolvedConnection | null,
	) {}

	getModels(): PiProviderModel[] {
		return this.models;
	}

	/** Cache-first startup; only a cache miss blocks on the remote catalog. */
	async initialize(connection: ResolvedConnection, signal = new AbortController().signal): Promise<boolean> {
		await this.refreshModels(directRefreshContext(false, signal), connection);
		const fromCache = this.hasMatchingCache(connection);
		if (!fromCache && !signal.aborted) {
			await this.refreshModels(directRefreshContext(true, signal), connection);
		}
		return fromCache;
	}

	/** Validate an unpersisted /login connection through the canonical refresh callback. */
	async refreshConnection(connection: ResolvedConnection, signal = new AbortController().signal): Promise<void> {
		await this.refreshModels(directRefreshContext(true, signal), connection);
	}

	/** Legacy extension shape adapted by Pi into Provider.refreshModels. */
	readonly refreshModels = async (
		context: RefreshModelsContext,
		connectionOverride?: ResolvedConnection,
	): Promise<PiProviderModel[]> => {
		const connection = connectionOverride ?? this.resolveConnection();
		if (!connection) return this.models;

		const refresh = this.refreshGeneration.begin(context.signal);
		if (!context.allowNetwork) {
			const cached = loadModelsCache(this.agentDir, connection.baseUrlInput);
			if (cached && this.cacheMatchesFastMode(cached.fastMode)) {
				await context.publish({
					update: () => this.publish(cached.models, cached.fastModelIds, refresh.generation, refresh.signal),
				});
			}
			return this.models;
		}

		try {
			const { loaded } = await resolveMappedModels(this.agentDir, connection.baseUrlInput, connection.apiKey, {
				forceRefresh: true,
				fastMode: this.fastMode.isEnabled(),
				signal: refresh.signal,
				shouldCommit: () => this.refreshGeneration.isCurrent(refresh.generation),
			});
			await context.publish({
				update: () => this.publish(loaded.models, loaded.fastModelIds, refresh.generation, refresh.signal),
			});
			return this.models;
		} catch (error) {
			// A direct startup/login refresh can supersede a Pi-owned generation.
			// In that case Pi should retain the current list, not report a false failure.
			if (!context.signal.aborted && !this.refreshGeneration.isCurrent(refresh.generation)) return this.models;
			throw error;
		}
	};

	private hasMatchingCache(connection: ResolvedConnection): boolean {
		const cached = loadModelsCache(this.agentDir, connection.baseUrlInput);
		return cached !== null && this.cacheMatchesFastMode(cached.fastMode);
	}

	private cacheMatchesFastMode(cachedFastMode: boolean | undefined): boolean {
		return (cachedFastMode ?? false) === this.fastMode.isEnabled();
	}

	private publish(models: PiProviderModel[], fastModelIds: string[], generation: number, signal: AbortSignal): void {
		if (signal.aborted || !this.refreshGeneration.isCurrent(generation)) return;
		this.models.splice(0, this.models.length, ...models);
		this.fastMode.setSupportedModelIds(fastModelIds);
	}
}
