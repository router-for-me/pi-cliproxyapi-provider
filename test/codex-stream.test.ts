import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BunPluginRuntime,
	computePatchedModuleCachePath,
	hasNativeMidConvoEffort,
	installBareImportResolver,
	loadCliproxyCodexStreams,
	MID_CONVO_BASELINE_EFFORT,
	patchCodexSource,
	reshapeConfigurationUpdates,
	resolveCodexModuleFromNodeEntry,
	resolveConfigurationUpdateEffort,
	resolveOriginalCodexModulePath,
	resolvePackageFromNodeModules,
	sharedSupportsConfigurationUpdate,
	wellKnownCodexModuleCandidates,
	writePatchedModuleCache,
} from "../extensions/codex-stream.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function writeFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

const CODEX_RELATIVE = join("node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js");

function failingResolveSpecifier(): string {
	throw Object.assign(new Error("Cannot find package '@earendil-works/pi-ai'"), { code: "ERR_MODULE_NOT_FOUND" });
}

function writeMachOLikeHost(root: string): string {
	const entryPath = join(root, "omp-darwin-arm64");
	writeFile(entryPath, "\x00Mach-O");
	return entryPath;
}

function writePartialJsonPackage(nodeModulesDir: string): string {
	const packageDir = join(nodeModulesDir, "partial-json");
	writeFile(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "partial-json",
			type: "module",
			exports: "./index.js",
		}),
	);
	writeFile(join(packageDir, "index.js"), `export function parse(text) {\n\treturn { ok: true, text };\n}\n`);
	return join(packageDir, "index.js");
}

function writeOmpPluginsCodexTree(home: string): { codexPath: string; jsonParsePath: string; partialJsonPath: string } {
	const pluginsNodeModules = join(home, ".omp", "plugins", "node_modules");
	const codexPath = join(home, ".omp", "plugins", CODEX_RELATIVE);
	const jsonParsePath = join(dirname(dirname(codexPath)), "utils", "json-parse.js");
	writeFile(
		codexPath,
		`import { parsePartial } from "../utils/json-parse.js";\nexport function streamSimple() {\n\treturn parsePartial('{"ok":');\n}\nexport function stream() {\n\treturn streamSimple();\n}\n`,
	);
	writeFile(
		jsonParsePath,
		`import { parse } from "partial-json";\nexport function parsePartial(text) {\n\treturn parse(text);\n}\n`,
	);
	const partialJsonPath = writePartialJsonPackage(pluginsNodeModules);
	return { codexPath, jsonParsePath, partialJsonPath };
}

describe("wellKnownCodexModuleCandidates", () => {
	it("lists HOME/.omp, HOME/.pi, and global package roots without host-specific paths", () => {
		const candidates = wellKnownCodexModuleCandidates("/home/user");
		expect(candidates).toEqual([
			join("/home/user", ".omp", "plugins", CODEX_RELATIVE),
			join("/home/user", ".omp", "plugins", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/home/user", ".pi", "agent", "npm", CODEX_RELATIVE),
			join(
				"/home/user",
				".pi",
				"agent",
				"npm",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".bun", "install", "global", CODEX_RELATIVE),
			join(
				"/home/user",
				".bun",
				"install",
				"global",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".npm-global", CODEX_RELATIVE),
			join("/home/user", ".npm-global", "lib", CODEX_RELATIVE),
			join("/home/user", ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/home/user", "Library", "pnpm", "global", "5", CODEX_RELATIVE),
			join(
				"/home/user",
				"Library",
				"pnpm",
				"global",
				"5",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".local", "share", "pnpm", "global", "5", CODEX_RELATIVE),
			join(
				"/home/user",
				".local",
				"share",
				"pnpm",
				"global",
				"5",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/usr", "local", "lib", CODEX_RELATIVE),
			join("/usr", "local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/opt", "homebrew", "lib", CODEX_RELATIVE),
			join("/opt", "homebrew", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
		]);
		expect(candidates.join("\n")).not.toMatch(/\/Users\/|\/home\/(?!user\b)|Ravi|tailscale/i);
	});
});

describe("resolveOriginalCodexModulePath", () => {
	it("still resolves the installed package when import.meta.resolve works", () => {
		const resolved = resolveOriginalCodexModulePath();
		expect(resolved.path).toMatch(/openai-codex-responses\.js$/);
		expect(existsSync(resolved.path)).toBe(true);
		expect(resolved.dir).toBe(dirname(resolved.path));
	});

	it("prefers host nodeEntry over import.meta.resolve candidate to keep module identity aligned with host", () => {
		const hostRoot = tempDir("pi-cpa-host-root-");
		const cliEntry = join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		const hostCodex = join(
			hostRoot,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		writeFile(cliEntry, "");
		writeFile(hostCodex, "");

		const otherDir = tempDir("pi-cpa-specifier-root-");
		const otherCodex = join(otherDir, "openai-codex-responses.js");
		writeFile(otherCodex, "");

		const resolved = resolveOriginalCodexModulePath({
			nodeEntry: cliEntry,
			resolveSpecifier: () => pathToFileURL(otherCodex).href,
		});

		expect(resolved.path).toBe(hostCodex);
	});

	it("prefers import.meta.resolve over a HOME/.omp candidate when nodeEntry is not a Node host", () => {
		const home = tempDir("pi-cpa-home-shadow-");
		writeOmpPluginsCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({ homeDirectory: home, nodeEntry: undefined });
		expect(resolved.path).not.toBe(join(home, ".omp", "plugins", CODEX_RELATIVE));
		expect(resolved.path).toMatch(
			/[\\/]node_modules[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]api[\\/]openai-codex-responses\.js$/,
		);
	});

	it("resolves a HOME/.omp/plugins candidate when import.meta.resolve fails and argv is a Mach-O host", () => {
		const home = tempDir("pi-cpa-omp-home-");
		const hostDir = tempDir("pi-cpa-omp-host-");
		const { codexPath } = writeOmpPluginsCodexTree(home);
		const nodeEntry = writeMachOLikeHost(hostDir);

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry,
			homeDirectory: home,
		});

		expect(resolved.path).toBe(codexPath);
		expect(resolved.dir).toBe(dirname(codexPath));
	});

	it("resolves a nested HOME/.pi/agent/npm candidate for the bundled pi host", () => {
		const home = tempDir("pi-cpa-pi-home-");
		const hostDir = tempDir("pi-cpa-pi-host-");
		const nested = join(
			home,
			".pi",
			"agent",
			"npm",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_RELATIVE,
		);
		writeFile(nested, "export {}\n");

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: writeMachOLikeHost(hostDir),
			homeDirectory: home,
		});

		expect(resolved.path).toBe(nested);
	});

	it("resolves bundled host module through wrapper script importing target CLI entry", () => {
		const hostRoot = tempDir("pi-cpa-wrapper-root-");
		const targetCli = join(hostRoot, "bundle", "cli.js");
		const codexModule = join(
			hostRoot,
			"bundle",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		const wrapper = join(hostRoot, "bin", "pi");

		writeFile(targetCli, "export {}\n");
		writeFile(codexModule, "export {}\n");
		writeFile(
			wrapper,
			`import { join } from "node:path";\nconst cliPath = ${JSON.stringify(targetCli)};\nawait import(cliPath);\n`,
		);

		expect(resolveCodexModuleFromNodeEntry(wrapper)).toBe(codexModule);
	});
});

describe("writePatchedModuleCache", () => {
	it("rewrites a bare partial-json import so a tmpdir cache can load it", async () => {
		const home = tempDir("pi-cpa-bare-home-");
		const cacheDir = tempDir("pi-cpa-bare-cache-");
		const { codexPath, partialJsonPath } = writeOmpPluginsCodexTree(home);
		const cachePath = join(cacheDir, "patched-bare.mjs");

		writePatchedModuleCache(
			cachePath,
			`import { parse } from "partial-json";\nexport const parsed = parse("x");\n`,
			codexPath,
		);

		const rewritten = readFileSync(cachePath, "utf8");
		expect(rewritten).toContain(pathToFileURL(partialJsonPath).href);
		expect(rewritten).not.toContain('from "partial-json"');

		const loaded = (await import(pathToFileURL(cachePath).href)) as { parsed: { ok: boolean; text: string } };
		expect(loaded.parsed).toEqual({ ok: true, text: "x" });
	});

	it("resolves partial-json after locating openai-codex-responses via HOME/.omp and writing the cache outside that tree", async () => {
		const home = tempDir("pi-cpa-graph-home-");
		const hostDir = tempDir("pi-cpa-graph-host-");
		const cacheDir = tempDir("pi-cpa-graph-cache-");
		const { codexPath, jsonParsePath } = writeOmpPluginsCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: writeMachOLikeHost(hostDir),
			homeDirectory: home,
		});
		expect(resolved.path).toBe(codexPath);

		const cachePath = join(cacheDir, "openai-codex-responses-cpa-test.mjs");
		writePatchedModuleCache(cachePath, readFileSync(resolved.path, "utf8"), resolved.path);

		const entrySource = readFileSync(cachePath, "utf8");
		expect(entrySource).not.toContain('from "../utils/json-parse.js"');
		expect(entrySource).toContain(pathToFileURL(jsonParsePath).href);

		const loaded = (await import(pathToFileURL(cachePath).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loaded.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
	});

	it("preserves shared module identity so session-resources cleanup reaches patched streams", async () => {
		const home = tempDir("pi-cpa-shared-home-");
		const cacheDir = tempDir("pi-cpa-shared-cache-");
		const codexPath = join(home, ".omp", "plugins", CODEX_RELATIVE);
		const sessionResourcesPath = join(dirname(dirname(codexPath)), "session-resources.js");

		writeFile(
			sessionResourcesPath,
			`export const cleanups = new Set();
export function registerCleanup(fn) { cleanups.add(fn); }
export function runCleanups() { for (const fn of cleanups) fn(); }
`,
		);

		writeFile(
			codexPath,
			`import { registerCleanup } from "../session-resources.js";
export function registerHook(fn) { registerCleanup(fn); }
`,
		);

		const cachePath = join(cacheDir, "openai-codex-responses-cpa-test.mjs");
		writePatchedModuleCache(cachePath, readFileSync(codexPath, "utf8"), codexPath);

		// Host imports original module directly
		const hostModule = (await import(pathToFileURL(sessionResourcesPath).href)) as {
			cleanups: Set<() => void>;
			runCleanups: () => void;
		};

		// Patched cache module registers into session resources
		const patchedModule = (await import(pathToFileURL(cachePath).href)) as {
			registerHook: (fn: () => void) => void;
		};

		let cleanedUp = false;
		patchedModule.registerHook(() => {
			cleanedUp = true;
		});

		expect(hostModule.cleanups.size).toBe(1);
		hostModule.runCleanups();
		expect(cleanedUp).toBe(true);
	});

	it("isolates cache keys across different installation paths using production hashing", async () => {
		const homeA = tempDir("pi-cpa-inst-a-");
		const homeB = tempDir("pi-cpa-inst-b-");
		const { codexPath: codexPathA } = writeOmpPluginsCodexTree(homeA);
		const { codexPath: codexPathB } = writeOmpPluginsCodexTree(homeB);

		// Same content, different locations
		expect(readFileSync(codexPathA, "utf8")).toBe(readFileSync(codexPathB, "utf8"));

		const cacheDir = tempDir("pi-cpa-dual-cache-");
		const source = readFileSync(codexPathA, "utf8");

		const outPathA = computePatchedModuleCachePath(codexPathA, source, cacheDir);
		const outPathB = computePatchedModuleCachePath(codexPathB, source, cacheDir);

		// Cache paths must be different because originalPath is hashed
		expect(outPathA).not.toBe(outPathB);

		writePatchedModuleCache(outPathA, source, codexPathA);
		writePatchedModuleCache(outPathB, source, codexPathB);

		const sourceA = readFileSync(outPathA, "utf8");
		const sourceB = readFileSync(outPathB, "utf8");

		expect(sourceA).not.toBe(sourceB);
		expect(sourceA).toContain(pathToFileURL(homeA).href);
		expect(sourceB).toContain(pathToFileURL(homeB).href);

		// Removing install A does not affect install B
		rmSync(homeA, { recursive: true, force: true });
		const loadedB = (await import(pathToFileURL(outPathB).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loadedB.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
	});
});

describe("resolvePackageFromNodeModules", () => {
	it("walks up from the importer and prefers ESM export conditions for root and subpath imports", () => {
		const root = tempDir("pi-cpa-resolve-exports-");
		const packageDir = join(root, "node_modules", "@scope", "dual");
		writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@scope/dual",
				exports: {
					".": { types: "./index.d.ts", require: "./index.cjs", import: "./index.mjs" },
					"./sub": { default: "./sub.js" },
				},
			}),
		);
		const importer = join(root, "node_modules", "consumer", "dist", "deep", "file.js");

		expect(resolvePackageFromNodeModules("@scope/dual", importer)).toBe(join(packageDir, "index.mjs"));
		expect(resolvePackageFromNodeModules("@scope/dual/sub", importer)).toBe(join(packageDir, "sub.js"));
	});

	it("falls back to module/main without exports and fails for missing packages", () => {
		const root = tempDir("pi-cpa-resolve-main-");
		writeFile(
			join(root, "node_modules", "legacy", "package.json"),
			JSON.stringify({ name: "legacy", main: "lib/main.js", module: "es/main.js" }),
		);
		const importer = join(root, "src", "file.js");

		expect(resolvePackageFromNodeModules("legacy", importer)).toBe(
			join(root, "node_modules", "legacy", "es/main.js"),
		);
		expect(() => resolvePackageFromNodeModules("absent", importer)).toThrow(/Cannot resolve package "absent"/);
	});
});

describe("installBareImportResolver", () => {
	it("rewrites bare imports only for modules inside the original pi-ai package", () => {
		const home = tempDir("pi-cpa-bun-hook-");
		const { codexPath, jsonParsePath, partialJsonPath } = writeOmpPluginsCodexTree(home);
		writeFile(
			join(dirname(dirname(dirname(codexPath))), "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-ai" }),
		);
		const hooks: Array<{ filter: RegExp; load: (args: { path: string }) => { contents: string } }> = [];
		const bun: BunPluginRuntime = {
			plugin: ({ setup }) => setup({ onLoad: ({ filter }, load) => hooks.push({ filter, load }) }),
		};

		installBareImportResolver(codexPath, bun);

		expect(hooks).toHaveLength(1);
		const [{ filter, load }] = hooks;
		expect(filter.test(jsonParsePath)).toBe(true);
		expect(filter.test(partialJsonPath)).toBe(false);
		const { contents } = load({ path: jsonParsePath });
		expect(contents).toContain(`from ${JSON.stringify(pathToFileURL(partialJsonPath).href)}`);
		expect(contents).not.toContain('from "partial-json"');
	});
});

describe("resolveConfigurationUpdateEffort", () => {
	const model = {
		compat: { supportsMidConvoEffort: true },
		thinkingLevelMap: { off: "none", high: "high" },
	};

	it("returns the mapped effort only for capable models with a requested level", () => {
		expect(resolveConfigurationUpdateEffort(model, { reasoningEffort: "high" })).toBe("high");
		expect(resolveConfigurationUpdateEffort(model, { reasoningEffort: "off" })).toBe("none");
		expect(resolveConfigurationUpdateEffort(model, { reasoningEffort: "xhigh" })).toBe("xhigh");
		expect(resolveConfigurationUpdateEffort(model, {})).toBeUndefined();
		expect(resolveConfigurationUpdateEffort(model, undefined)).toBeUndefined();
		expect(resolveConfigurationUpdateEffort({}, { reasoningEffort: "high" })).toBeUndefined();
		expect(
			resolveConfigurationUpdateEffort({ compat: { supportsMidConvoEffort: false } }, { reasoningEffort: "high" }),
		).toBeUndefined();
	});

	it("routes raw none efforts through the off mapping", () => {
		expect(resolveConfigurationUpdateEffort(model, { reasoningEffort: "none" })).toBe("none");
		expect(
			resolveConfigurationUpdateEffort(
				{ compat: { supportsMidConvoEffort: true }, thinkingLevelMap: { off: "low" } },
				{ reasoningEffort: "none" },
			),
		).toBe("low");
		expect(
			resolveConfigurationUpdateEffort(
				{ compat: { supportsMidConvoEffort: true }, thinkingLevelMap: { off: null } },
				{ reasoningEffort: "none" },
			),
		).toBeUndefined();
		expect(
			resolveConfigurationUpdateEffort({ compat: { supportsMidConvoEffort: true } }, { reasoningEffort: "none" }),
		).toBe("none");
	});

	it("pins the request-level baseline effort", () => {
		expect(MID_CONVO_BASELINE_EFFORT).toBe("medium");
	});
});

describe("mid-convo capability detection", () => {
	it("detects shared-converter configuration_update support", () => {
		expect(sharedSupportsConfigurationUpdate('type: "configuration_update" options?.configurationUpdateEffort')).toBe(
			true,
		);
		expect(sharedSupportsConfigurationUpdate('type: "configuration_update"')).toBe(false);
		expect(sharedSupportsConfigurationUpdate("")).toBe(false);
	});

	it("only treats actual upstream wiring as native support", () => {
		expect(hasNativeMidConvoEffort("// ports getConfigurationUpdateEffort behavior")).toBe(false);
		expect(hasNativeMidConvoEffort('"cliproxyapi-getConfigurationUpdateEffort"')).toBe(false);
		expect(hasNativeMidConvoEffort("function getConfigurationUpdateEffort(model, options, compat) {}")).toBe(false);
		expect(
			hasNativeMidConvoEffort(
				"function getConfigurationUpdateEffort(model, options, compat) {}\nconst configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);",
			),
		).toBe(true);
	});
});

describe("patchCodexSource mid-convo effort", () => {
	function installedSource(): string {
		const { path } = resolveOriginalCodexModulePath();
		return readFileSync(path, "utf8");
	}

	it("injects the configuration_update machinery into the installed codex source", () => {
		const patched = patchCodexSource(installedSource(), ["cliproxyapi"], { supportsConfigurationUpdate: true });

		expect(patched).toContain("cpaGetConfigurationUpdateEffort");
		expect(patched).toContain("CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT");
		expect(patched).toContain("providerThinkingLevel: cpaConfigurationUpdateEffort");
		expect(patched).toContain("configurationUpdateEffort: cpaConfigurationUpdateEffort");
		expect(patched).toContain("grammarToolInputProperties, cpaConfigurationUpdateEffort)");
		expect(patched).toContain("cpaReshapeConfigurationUpdates(messages).input");
		expect(patched).toContain("cpaReshapeConfigurationUpdates(messages).firstEffort");
		// The WebSocket response replay must not emit configuration updates:
		// the stored full request already ends with the trailing update.
		expect(patched).not.toContain("configurationUpdateEffort: cpaGetConfigurationUpdateEffort");
	});

	it("skips the optional patch without shared-converter support", () => {
		const patched = patchCodexSource(installedSource(), ["cliproxyapi"]);
		expect(patched).not.toContain("cpaGetConfigurationUpdateEffort");
		expect(patched).not.toContain("CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT");
	});

	it("loads a legacy-shaped source without the transcript anchors", () => {
		// Pre-1.3.0 hosts build the body from `context`, not normalizedContext.
		const legacy = installedSource().replace(
			"buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties)",
			"buildRequestBody(model, context, options, codexSessionId, grammarToolInputProperties)",
		);
		expect(legacy).not.toBe(installedSource());
		expect(() => patchCodexSource(legacy, ["cliproxyapi"])).not.toThrow();
	});

	it("does not treat a provider id containing the resolver name as native support", () => {
		const patched = patchCodexSource(installedSource(), ["cliproxyapi-getConfigurationUpdateEffort"], {
			supportsConfigurationUpdate: true,
		});
		expect(patched).toContain("function cpaGetConfigurationUpdateEffort");
	});
});

interface CapturedRequest {
	url: string;
	body: Record<string, any>;
}

function cannedSseFetch(captured: CapturedRequest[]): typeof fetch {
	return async (input, init) => {
		const rawBody = init?.body;
		let text: string;
		if (typeof rawBody === "string") {
			text = rawBody;
		} else if (rawBody instanceof Uint8Array) {
			const { zstdDecompressSync } = await import("node:zlib");
			text = zstdDecompressSync(rawBody).toString("utf8");
		} else {
			text = "{}";
		}
		captured.push({ url: String(input), body: JSON.parse(text) });

		const messageItem = {
			type: "message",
			id: `msg_turn_${captured.length}`,
			role: "assistant",
			content: [{ type: "output_text", text: `reply ${captured.length}`, annotations: [] }],
			status: "completed",
		};
		const events = [
			{ type: "response.output_item.done", output_index: 0, item: messageItem },
			{
				type: "response.completed",
				response: {
					id: `resp_turn_${captured.length}`,
					status: "completed",
					output: [messageItem],
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 1 },
					},
				},
			},
		];
		const payload = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
}

function midConvoModel(supportsMidConvoEffort: boolean): any {
	return {
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "cliproxyapi-codex-responses",
		provider: "cliproxyapi",
		baseUrl: "http://127.0.0.1:8317",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
		...(supportsMidConvoEffort ? { compat: { supportsMidConvoEffort: true } } : {}),
	};
}

function systemMessage(): any {
	return { role: "system", content: "You are a test harness.", timestamp: 0 };
}

function userMessage(text: string): any {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function configurationUpdates(body: Record<string, any>): string[] {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.filter((item: any) => item?.type === "configuration_update").map((item: any) => item.reasoning?.effort);
}

function configurationUpdateIndices(body: Record<string, any>): number[] {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.flatMap((item: any, index: number) => (item?.type === "configuration_update" ? [index] : []));
}

function userItemIndex(body: Record<string, any>, text: string): number {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.findIndex((item: any) => item?.role === "user" && JSON.stringify(item).includes(text));
}

function wireUserItemIndex(body: Record<string, any>, text: string): number {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.findIndex((item: any) => {
		if (item?.role === "user") return JSON.stringify(item).includes(text);
		return (
			Array.isArray(item?.content) &&
			item.content.some((c: any) => c?.type === "input_text" && String(c.text ?? "").includes(text))
		);
	});
}

describe("reshapeConfigurationUpdates", () => {
	const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
	const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
	const assistant = (text: string) => ({
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
	});

	it("promotes the first turn effort to the request level", () => {
		// OpenAI documentation example shape: first user turn runs at the
		// request-level effort, the follow-up switches via configuration_update.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-astra",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT, summary: "auto" },
			input: [
				user("Draft a database migration plan."),
				update("low"),
				assistant("ok"),
				update("high"),
				user("Analyze failure modes"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		expect(configurationUpdateIndices(body)).toEqual([2]);
		expect(userItemIndex(body, "Analyze failure modes")).toBe(3);
	});

	it("collapses repeated efforts and pulls the trailing change before its user message", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("high"),
				assistant("a1"),
				update("high"),
				user("two"),
				update("high"),
				assistant("a2"),
				update("xhigh"),
				user("three"),
				update("xhigh"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(configurationUpdates(body)).toEqual(["xhigh"]);
		expect(configurationUpdateIndices(body)).toEqual([4]);

		const trailingChange = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [user("one"), update("high"), assistant("a1"), user("two"), update("xhigh")],
		});
		expect(configurationUpdates(trailingChange)).toEqual(["xhigh"]);
		expect(configurationUpdateIndices(trailingChange)).toEqual([2]);
		expect(userItemIndex(trailingChange, "two")).toBe(3);
	});

	it("leaves bodies without configuration updates untouched", () => {
		const body = { model: "m", reasoning: { effort: "high" }, input: [user("one")] };
		expect(reshapeConfigurationUpdates(body)).toBe(body);
	});

	it("reshapes the captured request log shape with a tool turn", () => {
		// Mirrors ~/Downloads/openai.json: converter layout for turns run at
		// high then xhigh, the second turn ending in tool output.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT, summary: "auto" },
			input: [
				user("hello"),
				update("high"),
				assistant("a1"),
				user("model?"),
				update("xhigh"),
				{ type: "function_call", call_id: "c1", name: "whoami", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "gpt" },
				update("xhigh"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(configurationUpdates(body)).toEqual(["xhigh"]);
		// The surviving update sits immediately before the second user item.
		expect(configurationUpdateIndices(body)).toEqual([2]);
		expect(userItemIndex(body, "model?")).toBe(3);
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"message",
			"configuration_update",
			"user",
			"function_call",
			"function_call_output",
		]);
	});

	it("keeps a bare function_call turn's update on its own user item", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("high"),
				assistant("a1"),
				user("two"),
				update("xhigh"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				user("three"),
				update("xhigh"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(configurationUpdates(body)).toEqual(["xhigh"]);
		const updateIndex = configurationUpdateIndices(body)[0];
		expect(userItemIndex(body, "two")).toBe(updateIndex + 1);
	});

	it("keeps a mid-tool-loop change at the end instead of rewriting history", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		const items = body.input as any[];
		expect(items[items.length - 1].type).toBe("configuration_update");
		expect(userItemIndex(body, "one")).toBe(0);
	});

	it("preserves a return to an earlier effort in docs-shaped input", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-astra",
			reasoning: { effort: "low" },
			input: [
				user("one"),
				update("low"),
				assistant("a1"),
				update("high"),
				user("two"),
				assistant("a2"),
				user("three"),
				update("low"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high", "low"]);
		const indices = configurationUpdateIndices(body);
		expect(userItemIndex(body, "two")).toBe(indices[0] + 1);
		expect(userItemIndex(body, "three")).toBe(indices[1] + 1);
	});

	it("replays a tool-continuation update after its tool-output block", () => {
		// Request N+1 form of the mid-tool-loop change: the update must stay
		// after the tool outputs so the transmitted prefix never changes.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				update("high"),
				assistant("a1"),
				user("two"),
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"configuration_update",
			"message",
			"user",
		]);
	});

	it("keeps tool-continuation updates after trailing metadata on replay", () => {
		const developer = { role: "developer", content: [{ type: "input_text", text: "meta" }] };
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				developer,
				update("high"),
				assistant("a1"),
				user("two"),
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"developer",
			"configuration_update",
			"message",
			"user",
		]);
	});

	it("keeps orphan updates at their chronological boundaries", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				update("low"),
				assistant("a0"),
				update("high"),
				assistant("a1"),
				user("one"),
				update("low"),
				assistant("a2"),
				update("low"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high", "low"]);
		// The orphan high update stays between the two leading assistant items.
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"message",
			"configuration_update",
			"message",
			"configuration_update",
			"user",
			"message",
		]);
	});

	it("does not treat typed user messages as assistant output", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				assistant("a1"),
				update("high"),
				{ type: "message", role: "user", content: [{ type: "output_text", text: "two" }] },
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		const updateIndex = configurationUpdateIndices(body)[0];
		expect(userItemIndex(body, "two")).toBe(updateIndex + 1);
		// The update must not move before the first user item.
		expect(userItemIndex(body, "one")).toBe(0);
	});

	it("seeds effort tracking from orphan updates", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				update("low"),
				assistant("a0"),
				update("high"),
				assistant("a1"),
				user("one"),
				update("low"),
				assistant("a2"),
				update("low"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high", "low"]);
		const updateIndex = configurationUpdateIndices(body)[1];
		expect(userItemIndex(body, "one")).toBe(updateIndex + 1);
	});

	it("promotes a lone trailing update to the request level", () => {
		// First request of a session whose first turn is still in a tool loop:
		// the only update is the first turn's effort, so it becomes the
		// request-level effort and no update item remains.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(configurationUpdates(body)).toEqual([]);
	});

	it("falls back to the baseline when the first effort is missing", () => {
		const body = reshapeConfigurationUpdates({
			model: "m",
			input: [user("one"), { type: "configuration_update", reasoning: {} }, assistant("a1")],
		});
		expect((body as { reasoning?: unknown }).reasoning).toEqual({
			effort: MID_CONVO_BASELINE_EFFORT,
			summary: "auto",
		});
		expect(configurationUpdates(body)).toEqual([]);
	});
});

describe("mid-convo effort streams", () => {
	it("promotes the first effort to the request level and keeps later changes before their user message", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		const captured: CapturedRequest[] = [];
		const fetchImpl = cannedSseFetch(captured);
		const model = midConvoModel(true);

		const first = await streams
			.streamSimple(model, { messages: [systemMessage(), userMessage("first question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoning: "low",
				fetch: fetchImpl,
				sessionId: "mid-convo-test",
			} as any)
			.result();

		expect(first.errorMessage).toBeUndefined();
		expect(first.providerThinkingLevel).toBe("low");
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
		expect(captured[0].body.prompt_cache_key).toBe("mid-convo-test");

		const second = await streams
			.streamSimple(
				model,
				{ messages: [systemMessage(), userMessage("first question"), first, userMessage("second question")] },
				{
					apiKey: "sk-test",
					transport: "sse",
					reasoning: "high",
					fetch: fetchImpl,
					sessionId: "mid-convo-test",
				} as any,
			)
			.result();

		expect(second.errorMessage).toBeUndefined();
		expect(second.providerThinkingLevel).toBe("high");
		expect(captured).toHaveLength(2);
		expect(captured[1].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[1].body)).toEqual(["high"]);
		const updateIndex = configurationUpdateIndices(captured[1].body)[0];
		expect(wireUserItemIndex(captured[1].body, "second question")).toBe(updateIndex + 1);
		expect(captured[1].body.prompt_cache_key).toBe("mid-convo-test");

		const third = await streams
			.streamSimple(
				model,
				{
					messages: [
						systemMessage(),
						userMessage("first question"),
						first,
						userMessage("second question"),
						second,
						userMessage("third question"),
					],
				},
				{
					apiKey: "sk-test",
					transport: "sse",
					reasoning: "high",
					fetch: fetchImpl,
					sessionId: "mid-convo-test",
				} as any,
			)
			.result();

		expect(third.errorMessage).toBeUndefined();
		expect(captured).toHaveLength(3);
		expect(captured[2].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[2].body)).toEqual(["high"]);
		const replayedUpdateIndex = configurationUpdateIndices(captured[2].body)[0];
		expect(wireUserItemIndex(captured[2].body, "second question")).toBe(replayedUpdateIndex + 1);
	});

	it("keeps request-level effort for models without the compat flag", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		const captured: CapturedRequest[] = [];
		const result = await streams
			.streamSimple(midConvoModel(false), { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoning: "high",
				fetch: cannedSseFetch(captured),
				sessionId: "classic-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBeUndefined();
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("high");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("keeps request-level effort when thinking is off", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		const captured: CapturedRequest[] = [];
		const result = await streams
			.streamSimple(midConvoModel(true), { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoning: "off",
				fetch: cannedSseFetch(captured),
				sessionId: "off-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBeUndefined();
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("none");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("does not emit an update for a raw none effort when off is unsupported", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		const captured: CapturedRequest[] = [];
		const model = midConvoModel(true);
		model.thinkingLevelMap = { off: null, low: "low", medium: "medium", high: "high" };
		const result = await streams
			.stream(model, { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoningEffort: "none",
				fetch: cannedSseFetch(captured),
				sessionId: "none-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBeUndefined();
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning).toBeUndefined();
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("carries a raw none effort through a nonidentity off mapping", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		const captured: CapturedRequest[] = [];
		const model = midConvoModel(true);
		model.thinkingLevelMap = { off: "low", low: "low", medium: "medium", high: "high" };
		const result = await streams
			.stream(model, { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoningEffort: "none",
				fetch: cannedSseFetch(captured),
				sessionId: "none-mapped-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBe("low");
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("keeps websocket cached continuation across a thinking level change", async () => {
		const sentFrames: Array<Record<string, any>> = [];
		let connections = 0;
		class FakeWebSocket extends EventTarget {
			readyState = 0;

			constructor(_url: string, _options?: unknown) {
				super();
				connections += 1;
				queueMicrotask(() => {
					this.readyState = 1;
					this.dispatchEvent(new Event("open"));
				});
			}

			send(data: string): void {
				const frame = JSON.parse(data) as Record<string, any>;
				sentFrames.push(frame);
				const turn = sentFrames.length;
				const messageItem = {
					type: "message",
					id: `msg_ws_${turn}`,
					role: "assistant",
					content: [{ type: "output_text", text: `ws reply ${turn}`, annotations: [] }],
					status: "completed",
				};
				const events = [
					{ type: "response.output_item.done", output_index: 0, item: messageItem },
					{
						type: "response.completed",
						response: {
							id: `resp_ws_${turn}`,
							status: "completed",
							output: [messageItem],
							usage: {
								input_tokens: 9,
								output_tokens: 2,
								total_tokens: 11,
								input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 1 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}
		}

		const originalWebSocket = globalThis.WebSocket;
		const originalTransport = process.env.CLIPROXYAPI_TRANSPORT;
		(globalThis as any).WebSocket = FakeWebSocket;
		process.env.CLIPROXYAPI_TRANSPORT = "websocket-cached";
		try {
			const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
			try {
				const model = midConvoModel(true);
				const sessionId = `ws-mid-convo-${Date.now()}`;
				const first = await streams
					.streamSimple(model, { messages: [systemMessage(), userMessage("first question")] }, {
						apiKey: "sk-test",
						reasoning: "low",
						sessionId,
					} as any)
					.result();

				expect(first.errorMessage).toBeUndefined();
				expect(first.providerThinkingLevel).toBe("low");
				expect(sentFrames).toHaveLength(1);
				expect(sentFrames[0].type).toBe("response.create");
				expect(sentFrames[0].reasoning?.effort).toBe("low");
				expect(configurationUpdates(sentFrames[0])).toEqual([]);
				expect(sentFrames[0].previous_response_id).toBeUndefined();

				const second = await streams
					.streamSimple(
						model,
						{ messages: [systemMessage(), userMessage("first question"), first, userMessage("second question")] },
						{ apiKey: "sk-test", reasoning: "high", sessionId } as any,
					)
					.result();

				expect(second.errorMessage).toBeUndefined();
				expect(second.providerThinkingLevel).toBe("high");
				expect(connections).toBe(1);
				expect(sentFrames).toHaveLength(2);
				expect(sentFrames[1].previous_response_id).toBe("resp_ws_1");
				expect(sentFrames[1].reasoning?.effort).toBe("low");
				expect(configurationUpdates(sentFrames[1])).toEqual(["high"]);
				const updateIndex = configurationUpdateIndices(sentFrames[1])[0];
				expect(wireUserItemIndex(sentFrames[1], "second question")).toBe(updateIndex + 1);
				expect(JSON.stringify(sentFrames[1].input)).toContain("second question");
				expect(JSON.stringify(sentFrames[1].input)).not.toContain("first question");
			} finally {
				streams.closeOpenAICodexWebSocketSessions();
			}
		} finally {
			(globalThis as any).WebSocket = originalWebSocket;
			if (originalTransport === undefined) {
				delete process.env.CLIPROXYAPI_TRANSPORT;
			} else {
				process.env.CLIPROXYAPI_TRANSPORT = originalTransport;
			}
		}
	});
});

describe("loadCliproxyCodexStreams", () => {
	it("still loads the patched module from the installed package graph", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("cliproxyapi-codex-responses");
	});
});
