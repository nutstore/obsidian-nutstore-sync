import { describe, expect, it } from 'vitest'
import type { ToolCallPart } from 'ai'
import { createToolCallRoundSignature } from './tool-call-repeat'

function signature(input: unknown) {
	const call: ToolCallPart = {
		type: 'tool-call',
		toolCallId: 'neutral',
		toolName: 'neutral',
		input,
	}
	return createToolCallRoundSignature([call])
}

describe('tool call signatures', () => {
	it('preserves prototype-named fields while ignoring object key order', () => {
		const first = JSON.parse(
			'{"text":"中性 Neutral 🌿","nested":{"__proto__":{"text":"记录 Record 🌿"}}}',
		)
		const reordered = JSON.parse(
			'{"nested":{"__proto__":{"text":"记录 Record 🌿"}},"text":"中性 Neutral 🌿"}',
		)
		const different = JSON.parse(
			'{"text":"中性 Neutral 🌿","nested":{"__proto__":{"text":"条目 Entry 🌿"}}}',
		)
		expect(signature(first)).toBe(signature(reordered))
		expect(signature(first)).not.toBe(signature(different))
		expect(signature(first)).not.toBe(
			signature({ text: '中性 Neutral 🌿', nested: {} }),
		)
	})
})
