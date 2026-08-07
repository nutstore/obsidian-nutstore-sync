import { describe, expect, it } from 'vitest'
import type { AssistantModelMessage } from 'ai'
import { copyModelMessage } from './message-copy'

describe('copyModelMessage', () => {
	it('copies mutable tool input without sharing nested state', () => {
		const source: AssistantModelMessage = {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					toolCallId: 'call',
					toolName: 'demo',
					input: { nested: { value: 'before' } },
				},
			],
		}

		const copy = copyModelMessage(source)
		if (!Array.isArray(copy.content)) {
			throw new Error('Expected copied assistant content')
		}
		const copiedPart = copy.content[0]
		if (copiedPart?.type !== 'tool-call') {
			throw new Error('Expected copied tool call')
		}
		;(copiedPart.input as { nested: { value: string } }).nested.value = 'after'

		expect(source.content[0]).toMatchObject({
			input: { nested: { value: 'before' } },
		})
	})
})
