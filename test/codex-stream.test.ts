import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";

const { closeSessions } = vi.hoisted(() => ({ closeSessions: vi.fn() }));

vi.mock("../extensions/codex-stream.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/codex-stream.ts")>();
	return {
		...actual,
		loadCliproxyCodexStreams: vi.fn(async () => ({
			api: actual.CLIPROXYAPI_CODEX_API,
			streamSimple: vi.fn(),
			stream: vi.fn(),
			closeSessions,
		})),
	};
});

describe("patched codex WebSocket cleanup", () => {
	it("exposes the patched module close hook", async () => {
		const { loadCliproxyCodexStreams } = await vi.importActual<typeof import("../extensions/codex-stream.ts")>(
			"../extensions/codex-stream.ts",
		);
		const streams = await loadCliproxyCodexStreams();

		expect(typeof streams.closeSessions).toBe("function");
		expect(() => streams.closeSessions()).not.toThrow();
	});

	it("closes the shutting-down session's cached WebSockets", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-shutdown-test-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		for (const name of ["CLIPROXYAPI_API_KEY", "CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_PROVIDER_ID"]) {
			vi.stubEnv(name, "");
		}
		const handlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
		const pi = {
			registerCommand: vi.fn(),
			registerProvider: vi.fn(),
			unregisterProvider: vi.fn(),
			setModel: vi.fn(async () => true),
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				if (event === "session_shutdown") handlers.push(handler);
			}),
		} as unknown as ExtensionAPI;

		try {
			await providerExtension(pi);
			expect(handlers.length).toBeGreaterThan(0);
			const ctx = { sessionManager: { getSessionId: () => "session-42" } } as unknown as ExtensionContext;
			for (const handler of handlers) {
				handler({ type: "session_shutdown" }, ctx);
			}
			expect(closeSessions).toHaveBeenCalledWith("session-42");
		} finally {
			vi.unstubAllEnvs();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
