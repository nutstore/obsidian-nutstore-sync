import { describe, expect, it, vi } from 'vitest'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'

describe('MessageFactory.removeIncompleteToolCalls', () => {
	it('removes an interrupted tool part while preserving assistant text', () => {
		const factory = new MessageFactory(
			{ app: {} } as never,
			{} as never,
			vi.fn(),
		)
		const agent = createEmptyMasterAgent(1)
		agent.timeline.push({
			id: 'assistant',
			role: 'assistant',
			parts: [
				{ type: 'text', text: 'I will check.' },
				{
					type: 'dynamic-tool',
					toolCallId: 'call-interrupted',
					toolName: 'read_file',
					state: 'input-available',
					input: { path: 'note.md' },
				},
			],
		})
		expect(factory.removeIncompleteToolCalls(agent)).toBe(true)
		expect(agent.timeline[0].parts).toEqual([
			{ type: 'text', text: 'I will check.' },
		])
		expect(factory.removeIncompleteToolCalls(agent)).toBe(false)
	})
})
