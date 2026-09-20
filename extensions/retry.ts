import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRANSIENT_STREAM_ERROR_PATTERN =
	/\bclosed network connection\b|\bstream disconnected before completion: stream closed before response\.completed\b|\binvalid SSE data JSON\b/i;
const NETWORK_ERROR_PREFIX = "network error:";
const CAPACITY_ERROR_PATTERN = /maximum usage size allowed during peak load|\bno healthy upstream\b/i;
const CAPACITY_ERROR_PREFIX = "capacity error:";

export function normalizeCapacityError(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "error" || !message.errorMessage) {
		return message;
	}
	if (message.errorMessage.startsWith(CAPACITY_ERROR_PREFIX) || !CAPACITY_ERROR_PATTERN.test(message.errorMessage)) {
		return message;
	}

	return {
		...message,
		errorMessage: `${CAPACITY_ERROR_PREFIX} ${message.errorMessage}`,
	};
}

export function normalizeTransientNetworkError(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "error" || !message.errorMessage) {
		return message;
	}
	if (isRetryableAssistantError(message) || !TRANSIENT_STREAM_ERROR_PATTERN.test(message.errorMessage)) {
		return message;
	}

	return {
		...message,
		errorMessage: `${NETWORK_ERROR_PREFIX} ${message.errorMessage}`,
	};
}

export function registerTransientNetworkErrorRetry(pi: ExtensionAPI, providerId: string): void {
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== providerId) {
			return;
		}

		const normalized = normalizeTransientNetworkError(normalizeCapacityError(message));
		if (normalized === message) {
			return;
		}
		return { message: normalized };
	});
}
