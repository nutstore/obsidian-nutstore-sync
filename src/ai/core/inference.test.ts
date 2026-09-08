import { describe, expect, it } from 'vitest'
import {
	resolveModelOutputLimit,
	resolveSummaryOutputTokenBudget,
} from './inference'

function modelWithOutputLimit(output: number) {
	return { limit: { context: 1_000_000, output } }
}

describe('output token budgets', () => {
	it('uses the configured model output limit for ordinary generation', () => {
		expect(resolveModelOutputLimit(modelWithOutputLimit(384_000))).toBe(384_000)
	})

	it.each([0, -1, 1.5])(
		'ignores an invalid model output limit of %s',
		(outputLimit) => {
			expect(
				resolveModelOutputLimit(modelWithOutputLimit(outputLimit)),
			).toBeUndefined()
		},
	)

	it('keeps a summary budget independent from the model output limit', () => {
		expect(resolveSummaryOutputTokenBudget(modelWithOutputLimit(384_000))).toBe(
			16_384,
		)
	})

	it('keeps the summary request below a small model context window', () => {
		expect(
			resolveSummaryOutputTokenBudget({
				limit: { context: 8_000, output: 16_000 },
			}),
		).toBe(800)
	})
})
