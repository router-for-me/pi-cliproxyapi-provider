export type FastPreference = boolean | "ultrafast";
export type FastServiceTier = "priority" | "ultrafast";

/** Global speed preference plus the capability set advertised by CPA. */
export class FastModeController {
	private supportedModelIds = new Set<string>();

	constructor(private preference: FastPreference) {}

	getPreference(): FastPreference {
		return this.preference;
	}

	setPreference(preference: FastPreference): void {
		this.preference = preference;
	}

	setSupportedModelIds(modelIds: Iterable<string>): void {
		this.supportedModelIds = new Set(
			Array.from(modelIds, (modelId) => modelId.trim()).filter((modelId) => modelId.length > 0),
		);
	}

	isEnabled(): boolean {
		return this.preference !== false;
	}

	isModelSupported(modelId: string): boolean {
		return this.supportedModelIds.has(modelId.trim());
	}

	getServiceTierFor(modelId: string): FastServiceTier | undefined {
		if (!this.isEnabled() || !this.isModelSupported(modelId)) return undefined;
		return this.preference === "ultrafast" ? "ultrafast" : "priority";
	}
}
