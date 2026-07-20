import { describe, expect, it } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import {
	createEmptyMasterAgent,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import { buildTimeline } from './view-projection'
import { taskTool } from '~/ai/tools/task'

describe('buildTimeline', () => {
	it('projects a detached snapshot of the canonical UI message', () => {
		const master = createEmptyMasterAgent(1)
		const message = {
			id: 'message',
			role: 'assistant' as const,
			parts: [
				{
					type: 'dynamic-tool' as const,
					toolName: 'task',
					toolCallId: 'task-call',
					state: 'output-available' as const,
					input: { subagent_type: 'explorer', prompt: 'inspect file' },
					output: { taskId: 'explorer-one', status: 'dispatched' },
				},
			],
		}
		master.timeline.push(message)
		master.toolTimings['task-call'] = { startedAt: 10, finishedAt: 25 }
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const item = buildTimeline(session)[0]
		if (!item) throw new Error('Expected message item')
		expect(item.message).not.toBe(message)
		expect(item.message.parts[0]).not.toBe(message.parts[0])
		expect(item.displayBlocks[0]?.kind).toBe('tool-call')

		const block = item.displayBlocks[0]
		if (block?.kind !== 'tool-call') throw new Error('Expected tool block')
		expect(block.toolCall).toBe(item.message.parts[0])
		expect(block.toolCall.output).not.toBe(message.parts[0].output)
		expect(block.timing).toEqual({ startedAt: 10, finishedAt: 25 })
	})

	it('keeps reactive metadata out of task results sent back to the model', async () => {
		const master = createEmptyMasterAgent(1)
		const output = { taskId: 'explorer-one', status: 'dispatched' }
		master.timeline.push({
			id: 'assistant',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'task',
					toolCallId: 'task-call',
					state: 'output-available',
					input: { subagent_type: 'explorer', prompt: 'inspect file' },
					output,
				},
			],
		})

		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const item = buildTimeline(session)[0]
		if (!item) throw new Error('Expected message')
		const part = item.message.parts[0]
		if (part.type !== 'dynamic-tool' || part.state !== 'output-available') {
			throw new Error('Expected completed tool call')
		}

		Object.defineProperty(part.output as object, Symbol('solid-proxy'), {
			value: {},
		})
		Object.defineProperty(part.output as object, Symbol('store-node'), {
			value: {},
		})

		expect(Reflect.ownKeys(part.output as object)).toHaveLength(4)
		expect(Reflect.ownKeys(output)).toEqual(['taskId', 'status'])

		const messages = await uiMessagesToModelMessages(master.timeline)
		const toolMessage = messages[1]
		expect(toolMessage?.role).toBe('tool')
		if (toolMessage?.role !== 'tool') throw new Error('Expected tool message')
		const result = toolMessage.content[0]
		expect(result?.type).toBe('tool-result')
		if (result?.type !== 'tool-result') throw new Error('Expected tool result')
		expect(result.output).toEqual({ type: 'json', value: output })
		expect(Reflect.ownKeys((result.output as { value: object }).value)).toEqual(
			['taskId', 'status'],
		)
	})

	it('uses the task tool model output when rebuilding model history', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'assistant',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'task',
					toolCallId: 'task-call',
					state: 'output-available',
					input: { subagent_type: 'explorer', prompt: 'inspect file' },
					output: {
						taskId: 'explorer-one',
						subagentType: 'explorer',
						status: 'dispatched',
					},
				},
			],
		})
		const messages = await uiMessagesToModelMessages(master.timeline, {
			task: taskTool,
		})
		const toolMessage = messages[1]
		if (toolMessage?.role !== 'tool') throw new Error('Expected tool message')
		const result = toolMessage.content[0]
		if (result?.type !== 'tool-result') throw new Error('Expected tool result')
		expect(result.output).toEqual({
			type: 'text',
			value: expect.stringContaining('Task dispatched. Task ID: explorer-one.'),
		})
	})
})
