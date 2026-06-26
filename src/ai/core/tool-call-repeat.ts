import type { AIToolCall } from './types'

export const REPEATED_TOOL_CALL_THRESHOLD = 5

export interface ToolCallRepeatState {
	lastSignature?: string
	consecutiveCount: number
	isRepeatedTooManyTimes: boolean
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortJsonValue(item))
	}

	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
		)
	}

	return value
}

export function createToolCallRoundSignature(toolCalls: AIToolCall[]) {
	return JSON.stringify(
		toolCalls.map((toolCall) => ({
			name: toolCall.toolName,
			arguments: JSON.stringify(sortJsonValue(toolCall.input ?? {})),
		})),
	)
}

export function updateToolCallRepeatState(
	state: ToolCallRepeatState,
	toolCalls: AIToolCall[],
): ToolCallRepeatState {
	const signature = createToolCallRoundSignature(toolCalls)
	const consecutiveCount =
		state.lastSignature === signature ? state.consecutiveCount + 1 : 1

	return {
		lastSignature: signature,
		consecutiveCount,
		isRepeatedTooManyTimes: consecutiveCount >= REPEATED_TOOL_CALL_THRESHOLD,
	}
}
