import { describe, expect, it } from 'vitest'
import {
	modelMessageToUIMessage,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'

describe('UIMessage model round-trip', () => {
	it('preserves provider metadata required by later model calls', async () => {
		const uiMessage = modelMessageToUIMessage(
			{
				role: 'assistant',
				content: [
					{
						type: 'reasoning',
						text: 'thinking',
						providerOptions: { anthropic: { signature: 'signature' } },
					},
					{
						type: 'tool-call',
						toolCallId: 'call',
						toolName: 'read',
						input: { path: 'note.md' },
						providerOptions: { openai: { itemId: 'item' } },
					},
				],
			},
			{ id: 'message', createdAt: 1 },
		)

		expect(await uiMessagesToModelMessages([uiMessage])).toEqual([
			{
				role: 'assistant',
				content: [
					{
						type: 'reasoning',
						text: 'thinking',
						providerOptions: { anthropic: { signature: 'signature' } },
					},
					{
						type: 'tool-call',
						toolCallId: 'call',
						toolName: 'read',
						input: { path: 'note.md' },
						providerExecuted: undefined,
						providerOptions: { openai: { itemId: 'item' } },
					},
				],
			},
		])
	})

	it('preserves structured system notifications in model text', async () => {
		expect(
			await uiMessagesToModelMessages([
				{
					id: 'notification',
					role: 'user',
					parts: [
						{
							type: 'data-system-notification',
							data: {
								kind: 'task-result-ready',
								taskId: 'explorer-one',
								resultPath: '/tmp/session/tasks/explorer-one.txt',
							},
						},
					],
				},
			]),
		).toEqual([
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: '<SystemNotification>{"kind":"task-result-ready","taskId":"explorer-one","resultPath":"/tmp/session/tasks/explorer-one.txt"}</SystemNotification>',
					},
				],
			},
		])
	})
})
