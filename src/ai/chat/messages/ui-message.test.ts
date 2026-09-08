import { describe, expect, it } from 'vitest'
import {
	modelMessageToUIMessage,
	selectContextTimeline,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import type { AppUIMessage } from '~/ai/chat/types'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'

describe('UIMessage model round-trip', () => {
	it('retains unsummarized turns when a checkpoint anchor was deleted', () => {
		const neutralText = 'Hello 你好 🌿'
		const message = (
			id: string,
			role: 'user' | 'assistant',
			createdAt: number,
		): AppUIMessage => ({
			id,
			role,
			metadata: { createdAt },
			parts: [{ type: 'text', text: neutralText }],
		})
		const checkpoint: AppUIMessage = {
			id: 'neutral-checkpoint',
			role: 'user',
			metadata: { createdAt: 5 },
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode: 'summary',
						summary: neutralText,
						summarizedThroughMessageId: 'neutral-deleted-anchor',
						retainedMessageIds: [
							'neutral-retained-user',
							'neutral-retained-assistant',
						],
					},
				},
			],
		}

		expect(
			selectContextTimeline([
				message('neutral-summarized-user', 'user', 1),
				message('neutral-retained-user', 'user', 3),
				message('neutral-retained-assistant', 'assistant', 4),
				checkpoint,
				message('neutral-appended-user', 'user', 6),
			]).map((item) => item.id),
		).toEqual([
			'neutral-checkpoint',
			'neutral-retained-user',
			'neutral-retained-assistant',
			'neutral-appended-user',
		])
	})

	it('keeps legacy prior context when its only summary anchor was deleted', () => {
		const neutralText = 'Hello 你好 🌿'
		const prior: AppUIMessage = {
			id: 'neutral-prior-user',
			role: 'user',
			metadata: { createdAt: 1 },
			parts: [{ type: 'text', text: neutralText }],
		}
		const checkpoint: AppUIMessage = {
			id: 'neutral-legacy-checkpoint',
			role: 'user',
			metadata: { createdAt: 2 },
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode: 'summary',
						summary: neutralText,
						summarizedThroughMessageId: 'neutral-deleted-anchor',
					},
				},
			],
		}

		expect(
			selectContextTimeline([prior, checkpoint]).map((item) => item.id),
		).toEqual(['neutral-legacy-checkpoint', 'neutral-prior-user'])
	})

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
								resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/explorer-one.txt`,
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
						text: `<SystemNotification>{"kind":"task-result-ready","taskId":"explorer-one","resultPath":"${BASH_TMP_MOUNT_POINT}/session/tasks/explorer-one.txt"}</SystemNotification>`,
					},
				],
			},
		])
	})

	it('serializes current date context for model messages', async () => {
		expect(
			await uiMessagesToModelMessages([
				{
					id: 'date-context',
					role: 'user',
					parts: [
						{
							type: 'data-workspace-context',
							data: {
								deltas: [
									{
										key: 'currentDate',
										content: {
											date: '2024-02-29',
											weekday: 'Thursday',
											timezone: 'Asia/Shanghai',
										},
										hash: 'date-context-hash',
									},
								],
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
						text: '<AdditionalContext>{"currentDate":{"date":"2024-02-29","weekday":"Thursday","timezone":"Asia/Shanghai"}}</AdditionalContext>',
					},
				],
			},
		])
	})
})
