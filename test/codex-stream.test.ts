import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	applyFastPayloadHook,
	type CliproxyCodexStreamSimple,
	createProtocolStreamDispatcher,
	detectProtocolFromBaseUrl,
	ensurePatchedModuleCache,
	isBunEmbeddedRuntimeEntry,
	loadCliproxyCodexStreams,
	loadCliproxyResponsesStreams,
	normalizeContextForPatchedPiAi,
	patchResponsesSource,
	preparePatchedModuleForImport,
	resolvePhysicalPiAiModule,
	resolvePiAiApiSubpath,
	withPriorityServiceTier,
} from "../extensions/codex-stream.ts";

const testContext = { messages: [] } as Context;

function testModel(baseUrl: string): Model<Api> {
	return { id: "test", provider: "cliproxyapi", baseUrl } as Model<Api>;
}

describe("isBunEmbeddedRuntimeEntry", () => {
	it("identifies OMP's virtual Bun executable path", () => {
		expect(isBunEmbeddedRuntimeEntry("/$bunfs/root/omp-darwin-arm64")).toBe(true);
		expect(isBunEmbeddedRuntimeEntry("C:\\$bunfs\\root\\omp-windows-x64.exe")).toBe(true);
		expect(isBunEmbeddedRuntimeEntry("/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(false);
		expect(isBunEmbeddedRuntimeEntry("/Users/example/.bun/bin/omp")).toBe(false);
		expect(isBunEmbeddedRuntimeEntry(undefined)).toBe(false);
	});
});

describe("preparePatchedModuleForImport", () => {
	it("bundles patched modules before importing them in embedded Bun runtimes", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-cpa-embedded-bundle-test-"));
		const entryPath = join(cacheDir, "patched.mjs");
		const outputPath = join(cacheDir, "patched-bundled.mjs");
		const dependencyPath = join(cacheDir, "json-parse.js");
		const dependencyUrl = pathToFileURL(dependencyPath).href;
		writeFileSync(entryPath, `export { parseStreamingJson } from ${JSON.stringify(dependencyUrl)};\n`, "utf8");

		let receivedOptions: Record<string, unknown> | undefined;
		try {
			const resolved = await preparePatchedModuleForImport({
				entryPath,
				outputPath,
				embeddedBun: true,
				build: async (options) => {
					receivedOptions = options as unknown as Record<string, unknown>;
					const plugin = options.plugins?.[0];
					let resolver: ((args: { path: string }) => { path: string }) | undefined;
					plugin?.setup({
						onResolve: (_options, callback) => {
							resolver = callback;
						},
					});
					expect(resolver?.({ path: dependencyUrl })).toEqual({ path: dependencyPath });
					return {
						success: true,
						logs: [],
						outputs: [{ text: async () => "export const bundled = true;\n" }],
					};
				},
			});

			expect(resolved).toBe(
				`data:text/javascript;base64,${Buffer.from("export const bundled = true;\n").toString("base64")}`,
			);
			expect(existsSync(outputPath)).toBe(false);
			expect(receivedOptions).toMatchObject({
				entrypoints: [entryPath],
				outdir: cacheDir,
				target: "bun",
				format: "esm",
				naming: "patched-bundled.mjs",
				write: false,
			});
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("keeps the generated module unchanged outside embedded Bun runtimes", async () => {
		const entryPath = join(tmpdir(), "pi-cpa-patched.mjs");
		const outputPath = join(tmpdir(), "pi-cpa-patched-bundled.mjs");
		const build = async () => {
			throw new Error("build should not run");
		};
		await expect(
			preparePatchedModuleForImport({
				entryPath,
				outputPath,
				embeddedBun: false,
				build,
			}),
		).resolves.toBe(pathToFileURL(entryPath).href);
	});

	it("rebuilds an existing embedded bundle before importing it from memory", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-cpa-embedded-rebuild-test-"));
		const entryPath = join(cacheDir, "patched.mjs");
		const outputPath = join(cacheDir, "patched-bundled.mjs");
		writeFileSync(entryPath, "export const entry = true;\n", "utf8");
		let builds = 0;
		const build = async () => {
			builds++;
			return {
				success: true,
				outputs: [{ text: async () => `export const bundled = ${builds};\n` }],
			};
		};

		try {
			await preparePatchedModuleForImport({ entryPath, outputPath, embeddedBun: true, build });
			const resolved = await preparePatchedModuleForImport({ entryPath, outputPath, embeddedBun: true, build });
			const latestSource = "export const bundled = 2;\n";

			expect(builds).toBe(2);
			expect(existsSync(outputPath)).toBe(false);
			expect(resolved).toBe(`data:text/javascript;base64,${Buffer.from(latestSource).toString("base64")}`);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("ignores a corrupted legacy bundle before importing the rebuilt source", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-cpa-embedded-repair-test-"));
		const entryPath = join(cacheDir, "patched.mjs");
		const outputPath = join(cacheDir, "patched-bundled.mjs");
		const bundledSource = "export const repaired = true;\n";
		writeFileSync(entryPath, "export const entry = true;\n", "utf8");
		writeFileSync(outputPath, "corrupted", "utf8");

		try {
			const resolved = await preparePatchedModuleForImport({
				entryPath,
				outputPath,
				embeddedBun: true,
				build: async () => ({ success: true, outputs: [{ text: async () => bundledSource }] }),
			});

			expect(readFileSync(outputPath, "utf8")).toBe("corrupted");
			expect(resolved).toBe(`data:text/javascript;base64,${Buffer.from(bundledSource).toString("base64")}`);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});

describe("resolvePiAiApiSubpath", () => {
	it("removes a JavaScript extension from package export subpaths", () => {
		expect(resolvePiAiApiSubpath("openai-responses.js")).toBe("@earendil-works/pi-ai/api/openai-responses");
		expect(resolvePiAiApiSubpath("openai-codex-responses")).toBe("@earendil-works/pi-ai/api/openai-codex-responses");
	});
});

describe("detectProtocolFromBaseUrl", () => {
	it("detects openai-responses from /v1 baseUrl", () => {
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/v1")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/v1/")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("https://relay.proxy.com/api/v1")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("relay.proxy.com:8317/v1")).toBe("openai-responses");
	});

	it("defaults to openai-codex for non-v1 baseUrl", () => {
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/backend-api/")).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/")).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317")).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl(undefined)).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl("")).toBe("openai-codex");
	});
});

describe("withPriorityServiceTier", () => {
	it("injects service_tier: priority into objects", () => {
		expect(withPriorityServiceTier({ model: "test" })).toEqual({
			model: "test",
			service_tier: "priority",
		});
	});

	it("leaves non-objects unchanged", () => {
		expect(withPriorityServiceTier("string")).toBe("string");
		expect(withPriorityServiceTier(null)).toBeNull();
		expect(withPriorityServiceTier([1, 2])).toEqual([1, 2]);
	});
});

describe("patchResponsesSource", () => {
	it("injects provider ids into OPENAI_TOOL_CALL_PROVIDERS", () => {
		const fakeSource =
			'const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);\n//# sourceMappingURL=test.js.map';
		const patched = patchResponsesSource(fakeSource, ["cliproxyapi", "custom-cpa"]);
		expect(patched).toContain(
			'const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "cliproxyapi", "custom-cpa"]);',
		);
		expect(patched).not.toContain("sourceMappingURL");
	});

	it("throws if OPENAI_TOOL_CALL_PROVIDERS is missing", () => {
		expect(() => patchResponsesSource("const foo = 1;", ["cliproxyapi"])).toThrow(/OPENAI_TOOL_CALL_PROVIDERS/);
	});
});

describe("ensurePatchedModuleCache", () => {
	it("repairs an existing corrupted cache file", () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-cpa-cache-repair-test-"));
		const targetPath = join(cacheDir, "patched.mjs");
		try {
			writeFileSync(targetPath, "truncated", "utf8");
			ensurePatchedModuleCache(targetPath, "export const complete = true;\n");
			expect(readFileSync(targetPath, "utf8")).toBe("export const complete = true;\n");
			expect(readdirSync(cacheDir)).toEqual(["patched.mjs"]);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("accepts a concurrent writer that installed the expected cache content", () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-cpa-cache-race-test-"));
		const targetPath = join(cacheDir, "patched.mjs");
		const expected = "export const complete = true;\n";
		try {
			expect(() =>
				ensurePatchedModuleCache(targetPath, expected, {
					rename: (_temporaryPath, finalPath) => {
						writeFileSync(finalPath, expected, "utf8");
						throw Object.assign(new Error("race lost"), { code: "EEXIST" });
					},
				}),
			).not.toThrow();
			expect(readFileSync(targetPath, "utf8")).toBe(expected);
			expect(readdirSync(cacheDir)).toEqual(["patched.mjs"]);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("cleans the temporary file when the atomic rename fails", () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-cpa-cache-failure-test-"));
		const targetPath = join(cacheDir, "patched.mjs");
		const renameError = Object.assign(new Error("disk failure"), { code: "EIO" });
		try {
			expect(() =>
				ensurePatchedModuleCache(targetPath, "export const complete = true;\n", {
					rename: () => {
						throw renameError;
					},
				}),
			).toThrow(renameError);
			expect(existsSync(targetPath)).toBe(false);
			expect(readdirSync(cacheDir)).toEqual([]);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});

describe("runtime module loading", () => {
	it("normalizes OMP's system prompt array for patched pi-ai streams", () => {
		const context = { systemPrompt: ["system one", "system two"], messages: [] } as unknown as Context;
		const normalized = normalizeContextForPatchedPiAi(context);

		expect(normalized).not.toBe(context);
		expect(normalized.systemPrompt).toBe("system one\n\nsystem two");
		expect((context as unknown as { systemPrompt: string[] }).systemPrompt).toEqual(["system one", "system two"]);
	});

	it("applies Responses source patches for OMP runtime entries", async () => {
		const previousEntry = process.argv[1];
		const runtimeDir = mkdtempSync(join(tmpdir(), "pi-cpa-omp-patched-loader-test-"));
		const entryPath = join(runtimeDir, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
		const marker = `cliproxyapi-omp-patched-loader-${process.pid}-${Date.now()}`;
		const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
		let generatedPath: string | undefined;
		try {
			mkdirSync(dirname(entryPath), { recursive: true });
			writeFileSync(entryPath, "", "utf8");
			process.argv[1] = entryPath;

			await loadCliproxyResponsesStreams([marker]);
			generatedPath = readdirSync(cacheDir)
				.filter((name) => name.startsWith("openai-responses-cpa-") && name.endsWith(".mjs"))
				.map((name) => join(cacheDir, name))
				.find((path) => readFileSync(path, "utf8").includes(marker));

			expect(generatedPath).toBeDefined();
		} finally {
			if (previousEntry === undefined) delete process.argv[1];
			else process.argv[1] = previousEntry;
			if (generatedPath) unlinkSync(generatedPath);
			rmSync(runtimeDir, { recursive: true, force: true });
		}
	});

	it("loads patched codex stream module successfully", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		expect(streams).toBeDefined();
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("cliproxyapi-codex-responses");
	});

	it("loads patched responses stream module successfully", async () => {
		const streams = await loadCliproxyResponsesStreams(["cliproxyapi"]);
		expect(streams).toBeDefined();
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("cliproxyapi-codex-responses");
	});

	it("loads the patched responses module from a standalone Node process", async () => {
		const marker = `cliproxyapi-standalone-node-test-${process.pid}-${Date.now()}`;
		await loadCliproxyResponsesStreams([marker]);

		const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
		const generatedPath = readdirSync(cacheDir)
			.filter((name) => name.startsWith("openai-responses-cpa-") && name.endsWith(".mjs"))
			.map((name) => join(cacheDir, name))
			.find((path) => readFileSync(path, "utf8").includes(marker));
		expect(generatedPath).toBeDefined();

		try {
			expect(() =>
				execFileSync(
					process.execPath,
					["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(generatedPath!).href)});`],
					{
						cwd: tmpdir(),
						stdio: "pipe",
					},
				),
			).not.toThrow();
		} finally {
			if (generatedPath) unlinkSync(generatedPath);
		}
	});

	it("fails clearly when embedded Bun does not expose its build API", async () => {
		const previousEntry = process.argv[1];
		const previousCwd = process.cwd();
		const isolatedCwd = mkdtempSync(join(tmpdir(), "pi-cpa-embedded-bun-test-"));
		process.argv[1] = "/$bunfs/root/omp-darwin-arm64";
		process.chdir(isolatedCwd);
		try {
			await expect(loadCliproxyResponsesStreams(["cliproxyapi-embedded-bun-test"])).rejects.toThrow(
				/embedded Bun runtime does not expose Bun\.build/,
			);
		} finally {
			process.chdir(previousCwd);
			if (previousEntry === undefined) {
				delete process.argv[1];
			} else {
				process.argv[1] = previousEntry;
			}
			rmSync(isolatedCwd, { recursive: true, force: true });
		}
	});

	it("applies fast payload hook correctly", async () => {
		const payload = { model: "gpt-4o" };
		const model = { id: "gpt-4o", provider: "cliproxyapi" } as Model<Api>;
		const next = await applyFastPayloadHook(payload, model);
		expect(next).toEqual({ model: "gpt-4o", service_tier: "priority" });
	});

	it("dispatches between codex and responses through the production dispatcher", () => {
		let lastUsed = "";
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const codexSS: CliproxyCodexStreamSimple = () => {
			lastUsed = "codex";
			return streamResult;
		};
		const responsesSS: CliproxyCodexStreamSimple = () => {
			lastUsed = "responses";
			return streamResult;
		};
		const dispatcher = createProtocolStreamDispatcher(codexSS, responsesSS);

		dispatcher(testModel("http://127.0.0.1:8317/v1/"), testContext);
		expect(lastUsed).toBe("responses");

		dispatcher(testModel("http://127.0.0.1:8317/backend-api/"), testContext);
		expect(lastUsed).toBe("codex");
	});

	it("fails clearly instead of routing responses requests through codex when the responses stream is unavailable", () => {
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const loaderError = new Error("patched source is incompatible");
		const dispatcher = createProtocolStreamDispatcher(() => streamResult, undefined, loaderError);

		let thrown: unknown;
		try {
			dispatcher(testModel("https://relay.example/v1/"), testContext);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			message: expect.stringMatching(/openai-responses protocol is unavailable.*patched source is incompatible/),
			cause: loaderError,
		});
	});
});

describe("resolvePhysicalPiAiModule", () => {
	it("resolves physical openai-codex-responses.js file", () => {
		const resolved = resolvePhysicalPiAiModule("openai-codex-responses.js");
		expect(resolved.path).toContain("openai-codex-responses.js");
		expect(resolved.dir).toBeDefined();
	});

	it("resolves physical openai-responses.js file", () => {
		const resolved = resolvePhysicalPiAiModule("openai-responses.js");
		expect(resolved.path).toContain("openai-responses.js");
		expect(resolved.dir).toBeDefined();
	});

	it("throws with a descriptive message when the module cannot be found", () => {
		expect(() => resolvePhysicalPiAiModule("non-existent-module-xyz.js")).toThrow(
			/Cannot resolve non-existent-module-xyz\.js/,
		);
	});
});
