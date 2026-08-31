import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const EXTENSION_PATH = resolve("extensions/index.ts");

it("makes a cache-miss catalog available to pi --list-models during startup", async () => {
	const server = createServer((request, response) => {
		if (
			request.url === "/v1/models?client_version=pi" &&
			request.headers.authorization === "Bearer list-models-key"
		) {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					models: [
						{
							slug: "list-native-model",
							display_name: "List Native Model",
							context_window: 64_000,
							max_completion_tokens: 4096,
							input_modalities: ["text"],
						},
					],
				}),
			);
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Unable to resolve test server address");

	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxy-list-models-"));
	try {
		writeFileSync(
			join(agentDir, "cliproxyapi.json"),
			JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "list-models-key" }),
			"utf8",
		);
		mkdirSync(join(agentDir, "tmp"), { recursive: true });
		writeFileSync(
			join(agentDir, "tmp", "models-dev-cache.json"),
			JSON.stringify({
				timestamp: Date.now(),
				providers: {
					openai: {
						models: {
							"list-native-model": {
								cost: { input: 1, output: 2 },
								limit: { context: 64_000, output: 4096 },
							},
						},
					},
				},
			}),
			"utf8",
		);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SKIP_VERSION_CHECK: "1",
		};
		for (const name of [
			"CLIPROXYAPI_API_KEY",
			"CLIPROXYAPI_BASE_URL",
			"CLIPROXYAPI_FAST",
			"CLIPROXYAPI_PROVIDER_ID",
			"CLIPROXYAPI_PROVIDER_NAME",
		]) {
			delete env[name];
		}

		const { stdout } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "--no-extensions", "-e", EXTENSION_PATH, "--list-models", "list-native"],
			{ cwd: process.cwd(), env, timeout: 30_000 },
		);
		expect(stdout).toContain("cliproxyapi");
		expect(stdout).toContain("list-native-model");
		expect(stdout).toContain("64K");
		expect(stdout).toContain("4.1K");
	} finally {
		await new Promise<void>((resolveClose, rejectClose) => {
			server.close((error) => (error ? rejectClose(error) : resolveClose()));
		});
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 45_000);
