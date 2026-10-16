/**
 * Load a patched openai-codex-responses implementation for CLIProxyAPI.
 *
 * Differences from stock pi-ai:
 * - extractAccountId never throws; plain API keys are allowed
 * - chatgpt-account-id header is omitted when account id is unavailable
 * - provider id(s) are added to CODEX_TOOL_CALL_PROVIDERS for tool-call id handling
 * - model/message api id uses cliproxyapi-codex-responses
 *
 * The patched module is derived at runtime from the installed
 * @earendil-works/pi-ai openai-codex-responses implementation so we track
 * upstream protocol fixes without vendoring 1200+ lines.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const CLIPROXYAPI_CODEX_API = "cliproxyapi-codex-responses" as const;

export type CliproxyCodexStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CloseCodexWebSocketSessions = (sessionId?: string) => void;

export type CliproxyCodexStreams = {
	streamSimple: CliproxyCodexStreamSimple;
	stream: CliproxyCodexStreamSimple;
	rawStreamSimple: CliproxyCodexStreamSimple;
	rawStream: CliproxyCodexStreamSimple;
	api: typeof CLIPROXYAPI_CODEX_API;
	closeOpenAICodexWebSocketSessions: CloseCodexWebSocketSessions;
};

export interface CliproxyCodexStreamOptions {
	shouldUseFast?: (model: Model<Api>) => boolean;
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

interface TranscriptMessage {
	role?: string;
	content?: unknown;
	sections?: Record<string, string | null | undefined>;
	toolsAdded?: unknown[];
	toolsRemoved?: Array<{ name: string }>;
	[key: string]: unknown;
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text.trim())
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Adapt a pi >=0.86.0 TranscriptContext into a classic Context with top-level systemPrompt and tools.
 *
 * In pi >=0.86.0, custom provider stream handlers receive a normalized TranscriptContext where
 * system prompt sections and tool declarations are encoded into system messages inside context.messages.
 * Classic openai-codex-responses expects context.systemPrompt and context.tools, and fails when
 * encountering system messages inside context.messages during token estimation or payload generation.
 */
export function adaptTranscriptContext(context: Context | { messages?: unknown[]; [key: string]: unknown }): Context {
	if (!context || !Array.isArray(context.messages)) {
		return context as Context;
	}

	const rawMessages = context.messages as TranscriptMessage[];
	const hasSystemMessage = rawMessages.some((m) => m && m.role === "system");

	if (!hasSystemMessage) {
		return context as Context;
	}

	let leadingText = "";
	const sections = new Map<string, string>();
	const toolsMap = new Map<string, unknown>();

	if (Array.isArray(context.tools)) {
		for (const tool of context.tools) {
			if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
				toolsMap.set(tool.name, tool);
			}
		}
	}

	const nonSystemMessages: unknown[] = [];

	for (const msg of rawMessages) {
		if (!msg || typeof msg !== "object") continue;

		if (msg.role === "system") {
			const text = extractContentText(msg.content);
			if (text) {
				leadingText = leadingText ? `${leadingText}\n\n${text}` : text;
			}
			if (msg.sections && typeof msg.sections === "object") {
				for (const [name, sectionText] of Object.entries(msg.sections)) {
					if (sectionText === null || sectionText === undefined) {
						sections.delete(name);
					} else if (typeof sectionText === "string" && sectionText.trim()) {
						sections.set(name, sectionText.trim());
					}
				}
			}
			if (Array.isArray(msg.toolsRemoved)) {
				for (const tool of msg.toolsRemoved) {
					if (tool && typeof tool.name === "string") {
						toolsMap.delete(tool.name);
					}
				}
			}
			if (Array.isArray(msg.toolsAdded)) {
				for (const tool of msg.toolsAdded) {
					if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
						toolsMap.set(tool.name, tool);
					}
				}
			}
		} else {
			nonSystemMessages.push(msg);
		}
	}

	const sectionParts = [...sections.values()];
	const extractedSystemPrompt = [leadingText, ...sectionParts].filter(Boolean).join("\n\n");
	const finalSystemPrompt =
		extractedSystemPrompt || (typeof context.systemPrompt === "string" ? context.systemPrompt : undefined);
	const finalTools =
		toolsMap.size > 0
			? [...toolsMap.values()]
			: Array.isArray(context.tools) && context.tools.length > 0
				? context.tools
				: undefined;

	return {
		...(context as Record<string, unknown>),
		systemPrompt: finalSystemPrompt,
		tools: finalTools as Context["tools"],
		messages: nonSystemMessages as Context["messages"],
	};
}

/**
 * Ensure a classic context with top-level systemPrompt/tools is represented as a TranscriptContext.
 * If the context already contains a system message in context.messages, it is returned untouched.
 */
export function ensureTranscriptContext(context: Context | { messages?: unknown[]; [key: string]: unknown }): Context {
	if (!context || !Array.isArray(context.messages)) return context as Context;
	const hasSystemMessage = (context.messages as Array<{ role?: string }>).some((m) => m && m.role === "system");
	if (hasSystemMessage) return context as Context;

	const hasSystemPrompt = typeof context.systemPrompt === "string" && context.systemPrompt.length > 0;
	const hasTools = Array.isArray(context.tools) && context.tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return context as Context;

	return {
		...(context as Record<string, unknown>),
		messages: [
			{
				role: "system",
				content: context.systemPrompt ?? "",
				...(hasTools ? { toolsAdded: context.tools } : {}),
				timestamp: 0,
			},
			...context.messages,
		] as Context["messages"],
	};
}

export function supportsTranscriptSource(source: string): boolean {
	return source.includes("resolveTranscriptTools") || source.includes("resolveTranscript");
}

export function adaptContextForModule(
	context: Context | { messages?: unknown[]; [key: string]: unknown },
	supportsTranscript: boolean,
): Context {
	return supportsTranscript ? ensureTranscriptContext(context) : adaptTranscriptContext(context);
}

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}

/** Apply Fast before pi's shared payload hooks so later extensions retain final control. */
export async function applyFastPayloadHook(
	payload: unknown,
	model: Model<Api>,
	onPayload?: PayloadHook,
): Promise<unknown> {
	const fastPayload = withPriorityServiceTier(payload);
	const nextPayload = await onPayload?.(fastPayload, model);
	return nextPayload === undefined ? fastPayload : nextPayload;
}

export function wrapStreamSimpleForFast(
	streamSimple: CliproxyCodexStreamSimple,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamSimple {
	return (model, context, streamOptions) => {
		const hostSystemPrompt = (context as Context & { systemPrompt?: string | string[] }).systemPrompt;
		const compatibleContext = Array.isArray(hostSystemPrompt)
			? { ...context, systemPrompt: hostSystemPrompt.join("\n\n") }
			: context;

		if (!shouldUseFast?.(model)) {
			return streamSimple(model, compatibleContext, streamOptions);
		}
		return streamSimple(model, compatibleContext, {
			...streamOptions,
			onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, streamOptions?.onPayload),
		});
	};
}

const EXTRACT_ACCOUNT_ID_PATCH = `function extractAccountId(token) {
    // CLIProxyAPI accepts plain API keys as well as ChatGPT JWTs.
    // Never throw: missing account id simply means no chatgpt-account-id header.
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return "";
        const payload = JSON.parse(atob(parts[1]));
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        return typeof accountId === "string" && accountId.trim() ? accountId : "";
    }
    catch {
        return "";
    }
}`;

/** Request-level reasoning.effort pinned while configuration_update items carry the level. */
export const MID_CONVO_BASELINE_EFFORT = "medium";

interface MidConvoModelLike {
	compat?: { supportsMidConvoEffort?: boolean };
	thinkingLevelMap?: Record<string, string | null | undefined>;
}

/**
 * Resolve the effort to carry in configuration_update items, or undefined to
 * keep the classic request-level effort. Mirrors pi-ai openai-responses, plus
 * the Codex adapter's special case: raw efforts of "none" route through the
 * thinkingLevelMap off entry, whose null disables the update entirely.
 */
export function resolveConfigurationUpdateEffort(
	model: MidConvoModelLike,
	options?: { reasoningEffort?: string; reasoningSummary?: string },
): string | undefined {
	if (model.compat?.supportsMidConvoEffort !== true || !options?.reasoningEffort) {
		return undefined;
	}
	if (options.reasoningEffort === "none") {
		const offEffort = model.thinkingLevelMap?.off === undefined ? "none" : model.thinkingLevelMap.off;
		return offEffort ?? undefined;
	}
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}

interface WireInputItemLike {
	type?: string;
	role?: string;
	reasoning?: { effort?: unknown };
}

/**
 * Reshape configuration_update placement to the documented mid-conversation
 * semantics (https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation):
 * the effort in force for the first assistant turn becomes the request-level
 * reasoning.effort (which then never changes), and each later effort change
 * is a single configuration_update item placed immediately before the user
 * message it applies to. The shared converter instead emits one update
 * immediately before the assistant turn it governed, plus a trailing one
 * for the current turn; that layout must be mapped per turn: the update
 * before an assistant turn belongs before the user message that prompted
 * it, and a trailing update is pulled back before the last user message.
 * Only effort changes survive, so adjacent duplicates cannot occur.
 *
 * Bodies without any configuration_update item are returned unchanged.
 */
export function reshapeConfigurationUpdates<T extends Record<string, unknown>>(body: T): T {
	const input = (body as { input?: unknown }).input;
	if (!Array.isArray(input)) {
		return body;
	}
	const items = input as WireInputItemLike[];
	const firstUpdate = items.find((item) => item?.type === "configuration_update");
	if (!firstUpdate) {
		return body;
	}
	const firstEffort = typeof firstUpdate.reasoning?.effort === "string" ? firstUpdate.reasoning.effort : undefined;

	const ASSISTANT_ITEM_TYPES = new Set([
		"reasoning",
		"message",
		"function_call",
		"custom_tool_call",
		"tool_search_call",
		"web_search_call",
		"programmatic_tool_calling",
	]);
	const isAssistantItem = (item: WireInputItemLike | undefined): boolean => {
		if (!item || item.type === undefined || !ASSISTANT_ITEM_TYPES.has(item.type)) {
			return false;
		}
		// Typed user/developer messages are prompts, not assistant output.
		return item.type !== "message" || item.role === "assistant" || item.role === undefined;
	};
	const isTurnStart = (item: WireInputItemLike | undefined): boolean =>
		item?.role === "user" || item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
	const isPertinent = (item: WireInputItemLike | undefined): boolean => isTurnStart(item) || isAssistantItem(item);
	const effortOf = (update: WireInputItemLike): string | undefined =>
		typeof update.reasoning?.effort === "string" ? update.reasoning.effort : undefined;

	// Gather the turns of a single origin pass: each turn starts at a user
	// message or a block of tool outputs and ends at the next turn start.
	// Tool-continuation turns remember the exact prompt boundary where their
	// update was transmitted (last tool output, trailing metadata included).
	interface TurnSegment {
		startIndex: number;
		update: WireInputItemLike | undefined;
		answered: boolean;
		toolContinuation: boolean;
		lastToolOutputIndex: number;
		promptBoundaryIndex: number;
	}
	const turns: TurnSegment[] = [];
	let seenFirstUpdate = false;
	let pendingForwardUpdate: WireInputItemLike | undefined;
	let trailingForwardUpdate: WireInputItemLike | undefined;
	let trailingForwardIsTrailing = false;
	const orphanUpdates: Array<{ update: WireInputItemLike; anchorIndex: number }> = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const previousPertinent = [...items.slice(0, index)].reverse().find((entry) => isPertinent(entry));
		if (isTurnStart(item) && !(previousPertinent && isTurnStart(previousPertinent))) {
			turns.push({
				startIndex: index,
				update: pendingForwardUpdate,
				answered: false,
				toolContinuation: item?.role !== "user",
				lastToolOutputIndex: -1,
				promptBoundaryIndex: -1,
			});
			pendingForwardUpdate = undefined;
		}
		const currentTurn = turns[turns.length - 1];
		if (currentTurn) {
			if (isAssistantItem(item)) {
				currentTurn.answered = true;
			} else if (currentTurn.toolContinuation && !currentTurn.answered && item?.type !== "configuration_update") {
				if (isTurnStart(item)) {
					currentTurn.lastToolOutputIndex = index;
				}
				currentTurn.promptBoundaryIndex = index;
			}
		}
		if (item?.type !== "configuration_update") {
			continue;
		}
		if (!seenFirstUpdate) {
			seenFirstUpdate = true;
			continue;
		}
		let nextPertinent: WireInputItemLike | undefined;
		for (let scan = index + 1; scan < items.length; scan++) {
			if (isPertinent(items[scan])) {
				nextPertinent = items[scan];
				break;
			}
		}
		if (nextPertinent && isAssistantItem(nextPertinent)) {
			// Historical update governing the assistant output that follows.
			if (currentTurn) {
				currentTurn.update ??= item;
			} else {
				orphanUpdates.push({ update: item, anchorIndex: index });
			}
		} else {
			// Forward or trailing update; the last one of a run wins.
			pendingForwardUpdate = item;
			trailingForwardUpdate = item;
			trailingForwardIsTrailing = items.slice(index + 1).every((entry) => !isPertinent(entry));
		}
	}

	// Orphan updates (history starting mid-conversation, before any turn)
	// stay at the exact chronological boundary where they were recorded;
	// seed the tracked effort from them in order so later changes compare
	// against the actual wire state.
	let trackedEffort = firstEffort ?? MID_CONVO_BASELINE_EFFORT;
	const orphanByAnchorIndex = new Map<number, WireInputItemLike>();
	for (const orphan of orphanUpdates) {
		const orphanEffort = effortOf(orphan.update);
		if (orphanEffort !== undefined) {
			trackedEffort = orphanEffort;
		}
		orphanByAnchorIndex.set(orphan.anchorIndex, orphan.update);
	}
	const announcementByIndex = new Map<number, WireInputItemLike>();
	const announcementAfterIndex = new Map<number, WireInputItemLike>();
	let currentEffort = trackedEffort;
	for (const turn of turns) {
		const effort = turn.update ? effortOf(turn.update) : undefined;
		if (effort !== undefined && effort !== currentEffort) {
			if (turn.toolContinuation) {
				// Tool continuations announce right after their full prompt
				// (tool outputs plus any trailing metadata), the same boundary
				// the update occupied when first transmitted.
				const boundaryIndex =
					turn.promptBoundaryIndex !== -1
						? turn.promptBoundaryIndex
						: turn.lastToolOutputIndex !== -1
							? turn.lastToolOutputIndex
							: turn.startIndex;
				announcementAfterIndex.set(boundaryIndex, turn.update!);
			} else {
				announcementByIndex.set(turn.startIndex, turn.update!);
			}
			currentEffort = effort;
		}
	}
	const trailingTarget = [...turns].reverse().find((turn) => !turn.answered);
	let trailingAtEnd = false;
	if (trailingForwardUpdate && trailingForwardIsTrailing) {
		// The last forward update governs the current (unanswered) turn. The
		// converter already attached it to that turn; re-decide it here so its
		// announcement is placed before the turn's user message.
		if (trailingTarget && announcementByIndex.get(trailingTarget.startIndex) === trailingForwardUpdate) {
			announcementByIndex.delete(trailingTarget.startIndex);
			// Announcing it advanced the tracked effort; step back to the
			// effort announced by the preceding turns before comparing.
			let effortBefore = firstEffort ?? MID_CONVO_BASELINE_EFFORT;
			for (const turn of turns) {
				if (turn === trailingTarget) {
					break;
				}
				const announced = announcementByIndex.get(turn.startIndex);
				const announcedEffort = announced ? effortOf(announced) : undefined;
				if (announcedEffort !== undefined) {
					effortBefore = announcedEffort;
				}
			}
			currentEffort = effortBefore;
		}
		const effort = effortOf(trailingForwardUpdate);
		if (effort === undefined || effort !== currentEffort) {
			if (trailingTarget && items[trailingTarget.startIndex]?.role === "user") {
				announcementByIndex.set(trailingTarget.startIndex, trailingForwardUpdate);
			} else {
				// Tool-loop continuation or no turn to attach to: keep the
				// update in force from the end instead of rewriting history.
				trailingAtEnd = true;
			}
		}
	}

	const reshaped: WireInputItemLike[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item?.type === "configuration_update") {
			const orphan = orphanByAnchorIndex.get(index);
			if (orphan) {
				reshaped.push(orphan);
			}
			continue;
		}
		const announced = announcementByIndex.get(index);
		if (announced) {
			reshaped.push(announced);
		}
		reshaped.push(item);
		const announcedAfter = announcementAfterIndex.get(index);
		if (announcedAfter) {
			reshaped.push(announcedAfter);
		}
	}
	if (trailingAtEnd && trailingForwardUpdate) {
		reshaped.push(trailingForwardUpdate);
	}

	const reasoning = (body as { reasoning?: { effort?: unknown } }).reasoning;
	const nextReasoning =
		reasoning && typeof reasoning === "object"
			? { ...reasoning, effort: firstEffort ?? MID_CONVO_BASELINE_EFFORT }
			: { effort: firstEffort ?? MID_CONVO_BASELINE_EFFORT, summary: "auto" };
	return { ...body, input: reshaped, reasoning: nextReasoning };
}

const MID_CONVO_RESOLVER_SNIPPET = `/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
function cpaGetConfigurationUpdateEffort(model, options) {
    if (model.compat?.supportsMidConvoEffort !== true ||
        !options?.reasoningEffort) {
        return undefined;
    }
    if (options.reasoningEffort === "none") {
        // Mirror the Codex adapter: "none" resolves through the off mapping.
        const offEffort = model.thinkingLevelMap?.off === undefined ? "none" : model.thinkingLevelMap.off;
        return offEffort ?? undefined;
    }
    return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}
// Documented mid-conversation semantics: the first turn's effort becomes the
// fixed request-level reasoning.effort; later changes ride as configuration_update
// items placed immediately before the user message they apply to. The shared
// converter emits one update right before the assistant turn it governed plus
// a trailing one for the current turn, so map each update back to the start
// of its prompt chain (user message or preceding tool outputs), pull a
// trailing update back before the last user message, and drop repeats.
const CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT = ${JSON.stringify(MID_CONVO_BASELINE_EFFORT)};
function cpaReshapeConfigurationUpdates(input) {
    if (!Array.isArray(input)) {
        return { input, firstEffort: undefined };
    }
    const firstUpdate = input.find((item) => item?.type === "configuration_update");
    if (!firstUpdate) {
        return { input, firstEffort: undefined };
    }
    const firstEffort = typeof firstUpdate.reasoning?.effort === "string" ? firstUpdate.reasoning.effort : undefined;
    const ASSISTANT_ITEM_TYPES = new Set(["reasoning", "message", "function_call", "custom_tool_call", "tool_search_call", "web_search_call", "programmatic_tool_calling"]);
    const isAssistantItem = (item) => {
        if (!item || item.type === undefined || !ASSISTANT_ITEM_TYPES.has(item.type)) {
            return false;
        }
        return item.type !== "message" || item.role === "assistant" || item.role === undefined;
    };
    const isTurnStart = (item) => item?.role === "user" || item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
    const isPertinent = (item) => isTurnStart(item) || isAssistantItem(item);
    const effortOf = (update) => typeof update.reasoning?.effort === "string" ? update.reasoning.effort : undefined;
    const turns = [];
    let seenFirstUpdate = false;
    let pendingForwardUpdate;
    let trailingForwardUpdate;
    let trailingForwardIsTrailing = false;
    const orphanUpdates = [];
    for (let index = 0; index < input.length; index++) {
        const item = input[index];
        const previousPertinent = [...input.slice(0, index)].reverse().find((entry) => isPertinent(entry));
        if (isTurnStart(item) && !(previousPertinent && isTurnStart(previousPertinent))) {
            turns.push({ startIndex: index, update: pendingForwardUpdate, answered: false, toolContinuation: item?.role !== "user", lastToolOutputIndex: -1, promptBoundaryIndex: -1 });
            pendingForwardUpdate = undefined;
        }
        const currentTurn = turns[turns.length - 1];
        if (currentTurn) {
            if (isAssistantItem(item)) {
                currentTurn.answered = true;
            }
            else if (currentTurn.toolContinuation && !currentTurn.answered && item?.type !== "configuration_update") {
                if (isTurnStart(item)) {
                    currentTurn.lastToolOutputIndex = index;
                }
                currentTurn.promptBoundaryIndex = index;
            }
        }
        if (item?.type !== "configuration_update") {
            continue;
        }
        if (!seenFirstUpdate) {
            seenFirstUpdate = true;
            continue;
        }
        let nextPertinent;
        for (let scan = index + 1; scan < input.length; scan++) {
            if (isPertinent(input[scan])) {
                nextPertinent = input[scan];
                break;
            }
        }
        if (nextPertinent && isAssistantItem(nextPertinent)) {
            if (currentTurn) {
                currentTurn.update ??= item;
            }
            else {
                orphanUpdates.push({ update: item, anchorIndex: index });
            }
        }
        else {
            pendingForwardUpdate = item;
            trailingForwardUpdate = item;
            trailingForwardIsTrailing = input.slice(index + 1).every((entry) => !isPertinent(entry));
        }
    }
    let trackedEffort = firstEffort ?? CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT;
    const orphanByAnchorIndex = new Map();
    for (const orphan of orphanUpdates) {
        const orphanEffort = effortOf(orphan.update);
        if (orphanEffort !== undefined) {
            trackedEffort = orphanEffort;
        }
        orphanByAnchorIndex.set(orphan.anchorIndex, orphan.update);
    }
    const announcementByIndex = new Map();
    const announcementAfterIndex = new Map();
    let currentEffort = trackedEffort;
    for (const turn of turns) {
        const effort = turn.update ? effortOf(turn.update) : undefined;
        if (effort !== undefined && effort !== currentEffort) {
            if (turn.toolContinuation) {
                const boundaryIndex = turn.promptBoundaryIndex !== -1 ? turn.promptBoundaryIndex : turn.lastToolOutputIndex !== -1 ? turn.lastToolOutputIndex : turn.startIndex;
                announcementAfterIndex.set(boundaryIndex, turn.update);
            }
            else {
                announcementByIndex.set(turn.startIndex, turn.update);
            }
            currentEffort = effort;
        }
    }
    const trailingTarget = [...turns].reverse().find((turn) => !turn.answered);
    let trailingAtEnd = false;
    if (trailingForwardUpdate && trailingForwardIsTrailing) {
        if (trailingTarget && announcementByIndex.get(trailingTarget.startIndex) === trailingForwardUpdate) {
            announcementByIndex.delete(trailingTarget.startIndex);
            let effortBefore = firstEffort ?? CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT;
            for (const turn of turns) {
                if (turn === trailingTarget) {
                    break;
                }
                const announced = announcementByIndex.get(turn.startIndex);
                const announcedEffort = announced ? effortOf(announced) : undefined;
                if (announcedEffort !== undefined) {
                    effortBefore = announcedEffort;
                }
            }
            currentEffort = effortBefore;
        }
        const effort = effortOf(trailingForwardUpdate);
        if (effort === undefined || effort !== currentEffort) {
            if (trailingTarget && input[trailingTarget.startIndex]?.role === "user") {
                announcementByIndex.set(trailingTarget.startIndex, trailingForwardUpdate);
            }
            else {
                trailingAtEnd = true;
            }
        }
    }
    const reshaped = [];
    for (let index = 0; index < input.length; index++) {
        const item = input[index];
        if (item?.type === "configuration_update") {
            const orphan = orphanByAnchorIndex.get(index);
            if (orphan) {
                reshaped.push(orphan);
            }
            continue;
        }
        const announced = announcementByIndex.get(index);
        if (announced) {
            reshaped.push(announced);
        }
        reshaped.push(item);
        const announcedAfter = announcementAfterIndex.get(index);
        if (announcedAfter) {
            reshaped.push(announcedAfter);
        }
    }
    if (trailingAtEnd && trailingForwardUpdate) {
        reshaped.push(trailingForwardUpdate);
    }
    return { input: reshaped, firstEffort };
}`;

/**
 * Whether the installed openai-responses-shared converter honors the
 * configurationUpdateEffort option (pi >=1.3.0). Older hosts ignore the
 * unknown option, so the mid-convo machinery must stay disabled there.
 */
export function sharedSupportsConfigurationUpdate(sharedSource: string): boolean {
	return (
		sharedSource.includes('type: "configuration_update"') &&
		sharedSource.includes("options?.configurationUpdateEffort")
	);
}

/**
 * Whether a Codex adapter source already wires configuration_update support
 * natively. Uses the upstream resolver's exact wiring so stray mentions in
 * comments or identifiers do not count.
 */
export function hasNativeMidConvoEffort(source: string): boolean {
	return (
		source.includes("function getConfigurationUpdateEffort(") &&
		source.includes("const configurationUpdateEffort = getConfigurationUpdateEffort(")
	);
}

/**
 * Port pi 1.3.0 cache-preserving thinking level changes to the Codex adapter.
 *
 * Mirrors pi-ai openai-responses: when the model declares
 * compat.supportsMidConvoEffort, the real level travels as configuration_update
 * input items (replayed from providerThinkingLevel recorded on each reply),
 * so switching levels mid-session keeps the prompt prefix — and the prompt
 * cache — intact. On top of the converter layout, the built message list is
 * reshaped to the documented placement: the first turn's effort becomes the
 * fixed request-level reasoning.effort, and each later change sits right
 * before the user message it applies to.
 * The conversion itself is delegated to the shared openai-responses-shared
 * module via its configurationUpdateEffort option; callers only apply this
 * patch when that module supports it. The WebSocket response replay is left
 * untouched on purpose: the previous full request already ends with the
 * trailing configuration_update, so stored response items must not repeat it.
 */
function patchMidConvoEffort(source: string): string {
	const ANCHORS: Array<[string, string, string]> = [
		[
			"request build",
			"let body = buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties);",
			"let body = buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties, cpaConfigurationUpdateEffort);",
		],
		[
			"buildRequestBody signature",
			"model.compat?.supportsOpenAIGrammarTools ?? false)) {",
			"model.compat?.supportsOpenAIGrammarTools ?? false), cpaConfigurationUpdateEffort) {",
		],
		[
			"message conversion",
			"        toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },\n    });",
			"        toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },\n        configurationUpdateEffort: cpaConfigurationUpdateEffort,\n    });",
		],
		[
			"body input field",
			"        input: messages,",
			"        input: cpaReshapeConfigurationUpdates(messages).input,",
		],
		[
			"reasoning block",
			`        if (effort !== null) {\n            body.reasoning = {\n                effort,`,
			`        if (effort !== null) {\n            body.reasoning = {\n                effort: cpaConfigurationUpdateEffort === undefined ? effort : (cpaReshapeConfigurationUpdates(messages).firstEffort ?? CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT),`,
		],
	];

	for (const [name, anchor] of ANCHORS) {
		if (!source.includes(anchor)) {
			throw new Error(`openai-codex-responses source no longer supports the mid-convo effort patch (${name})`);
		}
	}

	let src = `${source}\n${MID_CONVO_RESOLVER_SNIPPET}\n`;
	// The output construction sits right after the stream's single async IIFE
	// opener; anchor the providerThinkingLevel injection on that block instead
	// of guessing the exact indentation of the role line.
	const iifeIndex = src.indexOf("    (async () => {");
	const roleIndex = iifeIndex === -1 ? -1 : src.indexOf('role: "assistant"', iifeIndex);
	const roleLineEnd = roleIndex === -1 ? -1 : src.indexOf("\n", roleIndex);
	if (iifeIndex === -1 || roleIndex === -1 || roleLineEnd === -1) {
		throw new Error("openai-codex-responses source no longer supports the mid-convo effort patch (output role)");
	}
	src =
		src.slice(0, iifeIndex) +
		"    const cpaConfigurationUpdateEffort = cpaGetConfigurationUpdateEffort(model, options);\n" +
		src.slice(iifeIndex, roleLineEnd) +
		"\n            ...(cpaConfigurationUpdateEffort === undefined ? {} : { providerThinkingLevel: cpaConfigurationUpdateEffort })," +
		src.slice(roleLineEnd);
	for (const [, anchor, replacement] of ANCHORS) {
		src = src.replace(anchor, replacement);
	}
	return src;
}

const IMPORT_FROM_SPECIFIER = /from\s+(["'])([^"']+)\1/g;

function stripSourceMappingUrl(source: string): string {
	return source.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
}

const CODEX_MODULE_RELATIVE = join(
	"node_modules",
	"@earendil-works",
	"pi-ai",
	"dist",
	"api",
	"openai-codex-responses.js",
);

/**
 * Well-known filesystem locations for openai-codex-responses.js on bundled hosts.
 *
 * @param homeDirectory - User home used as the root for `.omp` and `.pi` plugin trees
 * @returns Candidate absolute paths in probe order
 */
export function wellKnownCodexModuleCandidates(homeDirectory: string): string[] {
	return [
		join(homeDirectory, ".omp", "plugins", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".omp",
			"plugins",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join(homeDirectory, ".pi", "agent", "npm", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".pi",
			"agent",
			"npm",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join(homeDirectory, ".bun", "install", "global", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".bun",
			"install",
			"global",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join(homeDirectory, ".npm-global", CODEX_MODULE_RELATIVE),
		join(homeDirectory, ".npm-global", "lib", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".npm-global",
			"lib",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join(homeDirectory, "Library", "pnpm", "global", "5", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			"Library",
			"pnpm",
			"global",
			"5",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join(homeDirectory, ".local", "share", "pnpm", "global", "5", CODEX_MODULE_RELATIVE),
		join(
			homeDirectory,
			".local",
			"share",
			"pnpm",
			"global",
			"5",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_MODULE_RELATIVE,
		),
		join("/usr", "local", "lib", CODEX_MODULE_RELATIVE),
		join("/usr", "local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_MODULE_RELATIVE),
		join("/opt", "homebrew", "lib", CODEX_MODULE_RELATIVE),
		join("/opt", "homebrew", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_MODULE_RELATIVE),
	];
}

/**
 * Rewrite one module so relative and bare imports become absolute file URLs
 * resolved from `originalPath`'s package graph.
 *
 * @param source - Module source containing `from "..."` specifiers
 * @param originalPath - Physical file used as the resolve base
 * @returns Source with resolvable file URL imports
 */
export function rewritePatchedModuleImports(source: string, originalPath: string): string {
	const requireFromOriginal = createRequire(pathToFileURL(originalPath));
	const originalDir = dirname(originalPath);
	return stripSourceMappingUrl(
		source.replace(IMPORT_FROM_SPECIFIER, (full, _quote: string, specifier: string) => {
			if (specifier.startsWith("node:") || isBuiltin(specifier)) {
				return full;
			}
			if (specifier.startsWith(".")) {
				return `from ${JSON.stringify(pathToFileURL(join(originalDir, specifier)).href)}`;
			}
			const resolved = requireFromOriginal.resolve(specifier);
			return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
		}),
	);
}

/**
 * Write a patched module so a cache file outside the original tree
 * can still resolve bare and relative dependencies.
 *
 * @param outputPath - Destination `.mjs` path, typically under tmpdir
 * @param source - Patched entry source
 * @param originalPath - Physical openai-codex-responses.js used for resolution
 */
export function writePatchedModuleCache(outputPath: string, source: string, originalPath: string): void {
	mkdirSync(dirname(outputPath), { recursive: true });
	const rewritten = rewritePatchedModuleImports(source, originalPath);
	writeFileSync(outputPath, rewritten, "utf8");
}

function patchWebSocketTransport(source: string): string {
	const sessionIdExpression = String.raw`(?:options\?\.sessionId|cacheSessionId)`;
	const retryVariables = /let retriedWebSocketConnectionLimit\s*=\s*false;/;
	const connectionLimitRetry =
		/if \(!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit\) \{\s*retriedWebSocketConnectionLimit = true;\s*continue;\s*\}/;
	const websocketFailureHandling = new RegExp(
		String.raw`if \(aborted \|\| \(isCodexNonTransportError\(error\) && !connectionLimitBeforeStart\)\) \{[\s\S]*?recordWebSocketFailure\((${sessionIdExpression}), error\);[\s\S]*?recordWebSocketSseFallback\(\1\);\s*break;`,
	);
	const idleTtlDefinition = "const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;";
	const transportDefinition = 'const transport = options?.transport || "auto";';

	if (!source.includes(idleTtlDefinition)) {
		throw new Error("openai-codex-responses source no longer defines SESSION_WEBSOCKET_CACHE_TTL_MS");
	}
	if (!source.includes(transportDefinition)) {
		throw new Error("openai-codex-responses source no longer defines transport");
	}
	for (const pattern of [retryVariables, connectionLimitRetry, websocketFailureHandling]) {
		if (!pattern.test(source)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket transport patch");
		}
	}

	return source
		.replace(
			transportDefinition,
			'const transport = (process.env.CLIPROXYAPI_TRANSPORT || options?.transport || "auto");\n            options = options ? { ...options, transport } : { transport };',
		)
		.replace(
			retryVariables,
			`let websocketRetries = 0;
                const maxWebSocketRetries = Number.isFinite(options?.maxRetries)
                    ? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)
                    : 3;`,
		)
		.replace(connectionLimitRetry, "")
		.replace(
			websocketFailureHandling,
			(
				_match,
				activeSessionId: string,
			) => `if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
                            throw error;
                        }
                        if (!websocketStarted && websocketRetries < maxWebSocketRetries) {
                            websocketRetries++;
                            continue;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport,
                            fallbackTransport: websocketStarted ? undefined : "sse",
                            eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
                            requestBytes: new TextEncoder().encode(bodyJson).byteLength,
                        }));
                        recordWebSocketFailure(${activeSessionId}, error);
                        if (websocketStarted) {
                            throw error;
                        }
                        recordWebSocketSseFallback(${activeSessionId});
                        break;`,
		)
		.replace(
			idleTtlDefinition,
			'const SESSION_WEBSOCKET_CACHE_TTL_MS = (() => { const raw = Number.parseInt(process.env.CLIPROXYAPI_WS_IDLE_TTL_MS || "", 10); return Number.isFinite(raw) && raw > 0 && raw <= 2147483647 ? raw : 30 * 60 * 1000; })();',
		);
}

export interface PatchCodexSourceOptions {
	/** Whether the shared converter honors configurationUpdateEffort (pi >=1.3.0). */
	supportsConfigurationUpdate?: boolean;
}

export function patchCodexSource(source: string, providerIds: string[], options: PatchCodexSourceOptions = {}): string {
	let src = source;

	if (!/function extractAccountId\(token\) \{/.test(src)) {
		throw new Error("openai-codex-responses source no longer contains extractAccountId(token)");
	}
	src = src.replace(/function extractAccountId\(token\) \{[\s\S]*?\n\}/, EXTRACT_ACCOUNT_ID_PATCH);

	if (!src.includes(`headers.set("chatgpt-account-id", accountId);`)) {
		throw new Error("openai-codex-responses source no longer sets chatgpt-account-id");
	}
	src = src.replace(
		`headers.set("chatgpt-account-id", accountId);`,
		`if (accountId) {\n        headers.set("chatgpt-account-id", accountId);\n    }`,
	);

	const providersMatch = src.match(/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/);
	if (!providersMatch) {
		throw new Error("openai-codex-responses source no longer defines CODEX_TOOL_CALL_PROVIDERS");
	}
	const existing = providersMatch[1];
	const extras = providerIds
		.filter((id) => id.trim())
		.map((id) => JSON.stringify(id.trim()))
		.join(", ");
	src = src.replace(
		/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/,
		`const CODEX_TOOL_CALL_PROVIDERS = new Set([${existing}${extras ? `, ${extras}` : ""}]);`,
	);

	// Keep assistant message api metadata aligned with the registered custom api id.
	src = src.replaceAll(`api: "openai-codex-responses"`, `api: ${JSON.stringify(CLIPROXYAPI_CODEX_API)}`);

	// CLIProxyAPI prefers a persistent WebSocket transport. Reconnect before the
	// response starts, and gracefully fall back to SSE if retries are exhausted.
	// Cache-preserving thinking level changes (pi 1.3.0 openai-responses parity).
	// Requires a shared converter that honors configurationUpdateEffort; skipped
	// when the source already implements the resolver with upstream wiring.
	if (options.supportsConfigurationUpdate === true && !hasNativeMidConvoEffort(source)) {
		src = patchMidConvoEffort(src);
	}

	src = patchWebSocketTransport(src);

	// The generated module lives outside the original source map directory.
	src = src.replace(/^\/\/# sourceMappingURL=.*$/gm, "");

	return src;
}

export function resolveCodexModuleFromNodeEntry(entryPath: string): string | undefined {
	const visited = new Set<string>();
	const queue = [entryPath];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current)) continue;
		visited.add(current);

		try {
			if (!existsSync(current)) continue;
			const real = realpathSync(current);
			const require = createRequire(pathToFileURL(real));
			for (const nodeModulesDir of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
				const candidate = join(
					nodeModulesDir,
					"@earendil-works",
					"pi-ai",
					"dist",
					"api",
					"openai-codex-responses.js",
				);
				if (existsSync(candidate)) {
					return candidate;
				}
			}

			// If current is a small text script (wrapper / trampoline), inspect it for referenced entry paths or imports
			if (statSync(real).size < 8192) {
				const content = readFileSync(real, "utf8");
				// Look for path-like string literals (e.g. "/foo/bar", "./cli.js", "../dist/cli.js")
				const pathMatches = content.matchAll(/["'`]((\/|[A-Za-z]:[\\/]|\.{1,2}[\\/])[^"'`\r\n]+)["'`]/g);
				for (const match of pathMatches) {
					const ref = match[1]?.trim();
					if (ref) {
						queue.push(resolve(dirname(real), ref));
					}
				}
				const homeJoinMatch = content.match(
					/join\s*\(\s*(?:homedir\(\)|process\.env\.HOME)[^)]*["']([^"']+)["']\s*\)/,
				);
				if (homeJoinMatch) {
					const home = process.env.HOME || process.env.USERPROFILE || homedir();
					queue.push(join(home, homeJoinMatch[1]));
				}
			}
		} catch {
			// Ignore invalid or unavailable runtime entrypoints.
		}
	}
	return undefined;
}

export function computePatchedModuleCachePath(
	originalPath: string,
	patchedSource: string,
	cacheDir: string = join(tmpdir(), "pi-cliproxyapi-provider"),
): string {
	const hash = createHash("sha1")
		.update("resolved-imports-v2\n")
		.update(originalPath)
		.update("\n")
		.update(patchedSource)
		.digest("hex")
		.slice(0, 16);
	return join(cacheDir, `openai-codex-responses-cpa-${hash}.mjs`);
}

export interface ResolveOriginalCodexModulePathOptions {
	/** Override `import.meta.resolve`. Throw to simulate a bundled host with no package graph. */
	resolveSpecifier?: (specifier: string) => string;
	/** Override `process.argv[1]`. Pass a non-Node host path to skip createRequire success. */
	nodeEntry?: string | undefined;
	/** Override `HOME` / `USERPROFILE` for well-known filesystem fallbacks. */
	homeDirectory?: string | undefined;
}

/**
 * Locate the physical openai-codex-responses.js used as the patch source.
 *
 * Probe order: host nodeEntry, import.meta.resolve, then HOME/well-known paths.
 *
 * @param options - Optional resolve/argv/home overrides for tests and bundled hosts
 * @returns Existing module path and its directory
 * @throws If no candidate exists on disk
 */
export function resolveOriginalCodexModulePath(options: ResolveOriginalCodexModulePathOptions = {}): {
	path: string;
	dir: string;
} {
	// Under pi's extension loader, `@earendil-works/pi-ai` may resolve to dist/compat.js
	// and package subpath resolve for `/api/*` can fail. Prefer locating the physical
	// dist file next to the resolved package entry.
	const resolveSpecifier = options.resolveSpecifier ?? ((specifier: string) => import.meta.resolve(specifier));
	const nodeEntry = "nodeEntry" in options ? options.nodeEntry : process.argv[1];
	const homeDirectory =
		"homeDirectory" in options ? options.homeDirectory : process.env.HOME || process.env.USERPROFILE;
	const candidates: string[] = [];

	// pi bundled Node CLI exposes pi-ai as a virtual module to
	// extensions. Resolve its physical nested dependency from the CLI entry first so
	// the extension shares the exact same module instances (e.g. session resources) with the host.
	// Oh My Pi Mach-O hosts do not have a Node entry at argv[1]; skip quietly.
	if (nodeEntry) {
		const bundledHostModule = resolveCodexModuleFromNodeEntry(nodeEntry);
		if (bundledHostModule && existsSync(bundledHostModule)) {
			return { path: bundledHostModule, dir: dirname(bundledHostModule) };
		}
	}

	// Also check well-known CLI binaries if nodeEntry wasn't explicitly provided in options
	if (!("nodeEntry" in options) && homeDirectory) {
		const wellKnownEntries = [
			join(homeDirectory, ".bun", "bin", "pi"),
			join(homeDirectory, ".local", "bin", "pi"),
			join(homeDirectory, ".npm-global", "bin", "pi"),
			"/usr/local/bin/pi",
			"/opt/homebrew/bin/pi",
		];
		for (const entry of wellKnownEntries) {
			if (entry !== nodeEntry && existsSync(entry)) {
				const bundledHostModule = resolveCodexModuleFromNodeEntry(entry);
				if (bundledHostModule && existsSync(bundledHostModule)) {
					return { path: bundledHostModule, dir: dirname(bundledHostModule) };
				}
			}
		}
	}

	try {
		const subpath = resolveSpecifier("@earendil-works/pi-ai/api/openai-codex-responses");
		candidates.push(fileURLToPath(subpath));
	} catch {
		// ignore and try filesystem candidates
	}

	try {
		const main = fileURLToPath(resolveSpecifier("@earendil-works/pi-ai"));
		const distDir = dirname(main);
		candidates.push(join(distDir, "api/openai-codex-responses.js"));
		candidates.push(join(distDir, "openai-codex-responses.js"));
	} catch {
		// ignore
	}

	if (homeDirectory) {
		candidates.push(...wellKnownCodexModuleCandidates(homeDirectory));
	}

	for (const path of candidates) {
		if (path && existsSync(path)) {
			return { path, dir: dirname(path) };
		}
	}

	throw new Error(`Cannot resolve openai-codex-responses.js (tried: ${candidates.join(", ") || "none"})`);
}

export async function loadCliproxyCodexStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	const { path: originalPath } = resolveOriginalCodexModulePath();
	const originalSource = readFileSync(originalPath, "utf8");

	// The shared converter only honors configurationUpdateEffort on pi >=1.3.0.
	// Gate the optional patch (and the compat flag below) on that capability so
	// older hosts keep the classic request-level effort instead of pinning it
	// to the baseline without carrying the real level.
	const sharedSource = (() => {
		try {
			return readFileSync(join(dirname(originalPath), "openai-responses-shared.js"), "utf8");
		} catch {
			return "";
		}
	})();
	const supportsConfigurationUpdate = sharedSupportsConfigurationUpdate(sharedSource);
	const patched = patchCodexSource(originalSource, providerIds, { supportsConfigurationUpdate });

	const outPath = computePatchedModuleCachePath(originalPath, patched);
	const cacheDir = dirname(outPath);
	mkdirSync(cacheDir, { recursive: true });
	if (!existsSync(outPath)) {
		writePatchedModuleCache(outPath, patched, originalPath);
	}

	const mod = (await import(pathToFileURL(outPath).href)) as {
		streamSimple: CliproxyCodexStreamSimple;
		stream: CliproxyCodexStreamSimple;
		closeOpenAICodexWebSocketSessions?: CloseCodexWebSocketSessions;
	};

	if (typeof mod.streamSimple !== "function" || typeof mod.stream !== "function") {
		throw new Error("patched openai-codex-responses module missing streamSimple/stream exports");
	}

	// Must come from the patched module: its WebSocket cache is a separate Map
	// from the stock @earendil-works/pi-ai openai-codex-responses instance.
	const closeOpenAICodexWebSocketSessions =
		typeof mod.closeOpenAICodexWebSocketSessions === "function"
			? mod.closeOpenAICodexWebSocketSessions
			: () => {
					console.warn(
						"[pi-cliproxyapi-provider] patched openai-codex-responses module is missing closeOpenAICodexWebSocketSessions export",
					);
				};

	const supportsTranscript = supportsTranscriptSource(originalSource);
	const adaptContext = (context: Context): Context => adaptContextForModule(context, supportsTranscript);

	const adaptModel = (model: Model<Api>): Model<Api> => {
		const compat = model.compat as unknown as { supportsMidConvoEffort?: boolean } | undefined;
		if (supportsConfigurationUpdate || compat?.supportsMidConvoEffort !== true) {
			return model;
		}
		return { ...model, compat: { ...compat, supportsMidConvoEffort: false } } as Model<Api>;
	};

	// When the host adapter implements mid-convo effort natively, its placement
	// follows pi's converter layout; reshape payloads to the documented layout
	// in the wrapper instead of inside the patched module.
	const nativeMidConvoEffort = hasNativeMidConvoEffort(originalSource);
	const adaptOptions = (streamOptions?: SimpleStreamOptions): SimpleStreamOptions | undefined => {
		if (!nativeMidConvoEffort) {
			return streamOptions;
		}
		return {
			...streamOptions,
			onPayload: async (payload, payloadModel) => {
				const nextPayload = await streamOptions?.onPayload?.(payload, payloadModel);
				const effective = (nextPayload === undefined ? payload : nextPayload) as Record<string, unknown>;
				return effective && typeof effective === "object" ? reshapeConfigurationUpdates(effective) : effective;
			},
		};
	};

	const adaptedStreamSimple: CliproxyCodexStreamSimple = (model, context, streamOptions) => {
		return mod.streamSimple(adaptModel(model), adaptContext(context), adaptOptions(streamOptions));
	};
	const adaptedStream: CliproxyCodexStreamSimple = (model, context, streamOptions) => {
		return mod.stream(adaptModel(model), adaptContext(context), adaptOptions(streamOptions));
	};

	const streamSimple = wrapStreamSimpleForFast(adaptedStreamSimple, options.shouldUseFast);
	const stream = wrapStreamSimpleForFast(adaptedStream, options.shouldUseFast);

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		stream,
		rawStreamSimple: adaptedStreamSimple,
		rawStream: adaptedStream,
		closeOpenAICodexWebSocketSessions,
	};
}
