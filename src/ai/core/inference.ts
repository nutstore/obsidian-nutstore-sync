import type { AIModelConfig } from './types'

const MIN_SUMMARY_OUTPUT_TOKENS = 4096
const MAX_SUMMARY_OUTPUT_TOKENS = 16_384
const SUMMARY_OUTPUT_CONTEXT_RATIO = 0.02
const MAX_SUMMARY_OUTPUT_CONTEXT_RATIO = 0.1

/** The configured model is the single source of truth for ordinary output. */
export function resolveModelOutputLimit(
	model: Pick<AIModelConfig, 'limit'> | undefined,
) {
	return toPositiveInteger(model?.limit?.output)
}

/** Compression has its own bounded output budget and never inherits a user’s
 * potentially very large answer budget. */
export function resolveSummaryOutputTokenBudget(
	model: Pick<AIModelConfig, 'limit'> | undefined,
): number | undefined {
	const modelOutputLimit = toPositiveInteger(model?.limit?.output)
	const contextWindow = toPositiveInteger(model?.limit?.context)
	const summaryBudget = contextWindow
		? Math.min(
				clamp(
					Math.floor(contextWindow * SUMMARY_OUTPUT_CONTEXT_RATIO),
					MIN_SUMMARY_OUTPUT_TOKENS,
					MAX_SUMMARY_OUTPUT_TOKENS,
				),
				Math.max(
					1,
					Math.floor(contextWindow * MAX_SUMMARY_OUTPUT_CONTEXT_RATIO),
				),
			)
		: MIN_SUMMARY_OUTPUT_TOKENS

	return modelOutputLimit === undefined
		? summaryBudget
		: Math.min(summaryBudget, modelOutputLimit)
}
function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(Math.max(value, minimum), maximum)
}

function toPositiveInteger(value: number | undefined) {
	return value !== undefined && Number.isInteger(value) && value > 0
		? value
		: undefined
}
