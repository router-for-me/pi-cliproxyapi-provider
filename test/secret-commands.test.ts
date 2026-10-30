import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTH_FILE_NAME,
	CONFIG_FILE_NAME,
	fetchCodexModels,
	loadAuthConnection,
	resolveConnection,
	saveConfigFile,
} from "../extensions/lib.ts";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

let agentDir: string;
let command: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-cpa-secret-command-"));
	command = `!secret-manager read ${agentDir}`;
	vi.stubEnv("CLIPROXYAPI_API_KEY", undefined);
	vi.stubEnv("CLIPROXYAPI_BASE_URL", undefined);
	vi.mocked(execSync).mockReset().mockReturnValue("  resolved-test-key\n");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

function writeAuth(type: "api_key" | "oauth", value: string): void {
	writeFileSync(
		join(agentDir, AUTH_FILE_NAME),
		JSON.stringify({ cliproxyapi: type === "api_key" ? { type, key: value } : { type, access: value } }),
	);
}

describe("API key commands", () => {
	it("resolves config commands for model discovery, caches stdout, and never persists the result", async () => {
		saveConfigFile(agentDir, { baseUrl: "https://proxy.example", apiKey: command });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"models":[]}'));
		const connection = resolveConnection(agentDir, "cliproxyapi");
		expect(connection?.apiKey).toBe("resolved-test-key");
		if (!connection) throw new Error("Expected a resolved connection");
		await fetchCodexModels(connection.modelsUrl, connection.apiKey);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://proxy.example/v1/models?client_version=pi",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer resolved-test-key" }),
			}),
		);
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("resolved-test-key");
		expect(execSync).toHaveBeenCalledTimes(1);
		expect(execSync).toHaveBeenCalledWith(command.slice(1), {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		saveConfigFile(agentDir, { fast: true });
		const stored = readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8");
		expect(JSON.parse(stored).apiKey).toBe(command);
		expect(stored).not.toContain("resolved-test-key");
	});

	it("resolves api_key credentials without executing commands during metadata reads", () => {
		writeAuth("api_key", command);
		expect(loadAuthConnection(agentDir, "cliproxyapi")?.apiKey).toBe(command);
		expect(execSync).not.toHaveBeenCalled();
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("resolved-test-key");
		expect(execSync).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(join(agentDir, AUTH_FILE_NAME), "utf8")).cliproxyapi.key).toBe(command);
	});

	it("does not execute lower-priority commands when the environment provides a key", () => {
		saveConfigFile(agentDir, { apiKey: command });
		writeAuth("api_key", `${command}-auth`);
		vi.stubEnv("CLIPROXYAPI_API_KEY", "!literal-environment-key");
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("!literal-environment-key");
		expect(execSync).not.toHaveBeenCalled();
	});

	it("does not execute an auth command overridden by the config file", () => {
		saveConfigFile(agentDir, { apiKey: "file-key" });
		writeAuth("api_key", command);
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("file-key");
		expect(execSync).not.toHaveBeenCalled();
	});

	it("never interprets OAuth access tokens as commands", () => {
		writeAuth("oauth", "!literal-oauth-token");
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("!literal-oauth-token");
		expect(execSync).not.toHaveBeenCalled();
	});

	it("rejects failed commands without leaking their error or falling back to an old key", () => {
		saveConfigFile(agentDir, { apiKey: command });
		writeAuth("api_key", "old-auth-key");
		vi.mocked(execSync).mockImplementation(() => {
			throw Object.assign(new Error(`failed ${command}: sensitive stderr`), { stdout: "sensitive stdout" });
		});
		expect(() => resolveConnection(agentDir, "cliproxyapi")).toThrowError(
			new Error("Failed to resolve CLIProxyAPI API key command. Check the command and its authorization."),
		);
	});

	it("rejects empty command output and allows a later retry", () => {
		saveConfigFile(agentDir, { apiKey: command });
		vi.mocked(execSync).mockReturnValueOnce(" \n");
		expect(() => resolveConnection(agentDir, "cliproxyapi")).toThrow(/Failed to resolve CLIProxyAPI API key command/);
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("resolved-test-key");
		expect(execSync).toHaveBeenCalledTimes(2);
	});

	it("executes a changed command instead of returning the previous command's cached key", () => {
		saveConfigFile(agentDir, { apiKey: command });
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("resolved-test-key");
		saveConfigFile(agentDir, { apiKey: `${command}-changed` });
		vi.mocked(execSync).mockReturnValueOnce("changed-test-key");
		expect(resolveConnection(agentDir, "cliproxyapi")?.apiKey).toBe("changed-test-key");
		expect(execSync).toHaveBeenCalledTimes(2);
	});
});
