import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadCliproxyCodexStreams,
	resolveOriginalCodexModulePath,
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
	const dir = mkdtempSync(join(tmpdir(), prefix));
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
	it("lists HOME/.omp and HOME/.pi plugin roots without host-specific paths", () => {
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

	it("prefers import.meta.resolve over a HOME/.omp candidate", () => {
		const home = tempDir("pi-cpa-home-shadow-");
		writeOmpPluginsCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({ homeDirectory: home });
		expect(resolved.path).not.toBe(join(home, ".omp", "plugins", CODEX_RELATIVE));
		expect(resolved.path).toMatch(/node_modules\/@earendil-works\/pi-ai\/dist\/api\/openai-codex-responses\.js$/);
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
		const { codexPath, partialJsonPath } = writeOmpPluginsCodexTree(home);

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
		expect(entrySource).toMatch(/from "file:.*\.mjs"/);

		const localFiles = [
			cachePath,
			...Array.from(new Set(entrySource.match(/file:\/\/[^"]+/g) ?? [])).map((url) => new URL(url).pathname),
		];
		expect(
			localFiles.some(
				(path) => existsSync(path) && readFileSync(path, "utf8").includes(pathToFileURL(partialJsonPath).href),
			),
		).toBe(true);

		const loaded = (await import(pathToFileURL(cachePath).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loaded.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
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
