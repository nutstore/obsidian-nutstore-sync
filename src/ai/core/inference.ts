import type { AIModelConfig } from './types'

/** The configured model is the single source of truth for generation output, including context compression. */
export function resolveModelOutputLimit(
	model: Pick<AIModelConfig, 'limit'> | undefined,
) {
	return toPositiveInteger(model?.limit?.output)
}

function toPositiveInteger(value: number | undefined) {
	return value !== undefined && Number.isInteger(value) && value > 0
		? value
		: undefined
}
