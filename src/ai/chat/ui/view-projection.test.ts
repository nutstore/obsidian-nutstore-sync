import { describe, expect, it } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import type { ChatAgentState } from '~/ai/chat/types'
import {
	createEmptyMasterAgent,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import { ChatViewProjector } from './view-projection'
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
		master.operations.message = [
			{
				vaultPath: 'note.md',
				operation: 'update',
				before: { kind: 'file', contentBase64: 'YQ==' },
				after: { kind: 'file', contentBase64: 'Yg==' },
				toolCallId: 'task-call',
			},
		]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const item = new ChatViewProjector().projectSession(session).timeline[0]
		if (!item) throw new Error('Expected message item')
		expect(item.message).not.toBe(message)
		expect(item.message.parts[0]).not.toBe(message.parts[0])
		expect(item.displayBlocks[0]?.kind).toBe('tool-call')

		const block = item.displayBlocks[0]
		if (block?.kind !== 'tool-call') throw new Error('Expected tool block')
		expect(block.toolCall).toBe(item.message.parts[0])
		expect(block.toolCall.output).not.toBe(message.parts[0].output)
		expect(block.timing).toEqual({ startedAt: 10, finishedAt: 25 })
		expect(block.fileChanges).toEqual(master.operations.message)
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
		const item = new ChatViewProjector().projectSession(session).timeline[0]
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

describe('ChatViewProjector cache', () => {
	const sessionWith = (
		master: ReturnType<typeof createEmptyMasterAgent>,
	): ChatSession => ({
		schemaVersion: 2,
		id: 'session',
		createdAt: 1,
		updatedAt: 1,
		subagents: { master },
	})

	it('reuses detached items until a message changes', () => {
		const master = createEmptyMasterAgent(1)
		const first = {
			id: 'first',
			role: 'user' as const,
			parts: [{ type: 'text' as const, text: 'Read 读取 🌿' }],
		}
		const second = {
			id: 'second',
			role: 'assistant' as const,
			parts: [{ type: 'text' as const, text: 'Reply 回复 🌿' }],
		}
		master.timeline.push(first, second)
		const session = sessionWith(master)
		const projector = new ChatViewProjector()

		const initial = projector.projectSession(session).timeline
		const unchanged = projector.projectSession(session).timeline

		expect(unchanged).toBe(initial)
		expect(unchanged[0]).toBe(initial[0])

		const part = second.parts[0]
		if (part?.type !== 'text') throw new Error('Expected a text part')
		part.text = 'Reply 回复 🌿\nDone 完成 🚀'
		const changed = projector.projectSession(session).timeline

		expect(changed).not.toBe(initial)
		expect(changed[0]).toBe(initial[0])
		expect(changed[1]).not.toBe(initial[1])
		expect(changed[1].message).not.toBe(second)
		expect(changed[1].message.parts[0]).toMatchObject({
			type: 'text',
			text: 'Reply 回复 🌿\nDone 完成 🚀',
		})
	})

	it('refreshes a tool block when its timing or file changes arrive', () => {
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'assistant',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'write',
					toolCallId: 'call-1',
					state: 'input-available',
					input: { purpose: 'Update 更新 🌿' },
				},
			],
		})
		const session = sessionWith(master)
		const projector = new ChatViewProjector()

		const initial = projector.projectSession(session).timeline
		master.toolTimings['call-1'] = { startedAt: 10, finishedAt: 20 }
		const withTiming = projector.projectSession(session).timeline

		expect(withTiming[0]).not.toBe(initial[0])
		const timingBlock = withTiming[0].displayBlocks[0]
		if (timingBlock?.kind !== 'tool-call')
			throw new Error('Expected a tool block')
		expect(timingBlock.timing).toEqual({ startedAt: 10, finishedAt: 20 })

		master.operations.assistant = [
			{
				vaultPath: 'notes/neutral.md',
				operation: 'update',
				before: { kind: 'file', contentBase64: 'YQ==' },
				after: { kind: 'file', contentBase64: 'Yg==' },
				toolCallId: 'call-1',
			},
		]
		const withOperations = projector.projectSession(session).timeline
		const fileBlock = withOperations[0].displayBlocks[0]
		if (fileBlock?.kind !== 'tool-call')
			throw new Error('Expected a tool block')
		expect(fileBlock.fileChanges).toEqual(master.operations.assistant)
	})

	it('recomputes headers without rebuilding untouched messages', () => {
		const master = createEmptyMasterAgent(1)
		master.timeline.push(
			{
				id: 'user',
				role: 'user',
				parts: [{ type: 'text', text: 'Compare 比较 🌿' }],
			},
			{
				id: 'first',
				role: 'assistant',
				metadata: { createdAt: 1, llm: { modelId: 'model-a' } },
				parts: [{ type: 'text', text: 'First 第一 🚀' }],
			},
			{
				id: 'second',
				role: 'assistant',
				metadata: { createdAt: 2, llm: { modelId: 'model-a' } },
				parts: [{ type: 'text', text: 'Second 第二 🚀' }],
			},
			{
				id: 'third',
				role: 'assistant',
				metadata: { createdAt: 3, llm: { modelId: 'model-a' } },
				parts: [{ type: 'text', text: 'Third 第三 🚀' }],
			},
		)
		const session = sessionWith(master)
		const projector = new ChatViewProjector()
		const initial = projector.projectSession(session).timeline
		expect(initial.map((item) => item.showHeader)).toEqual([
			true,
			true,
			false,
			false,
		])

		const first = master.timeline[1]
		first.metadata = {
			createdAt: 1,
			llm: { modelId: 'model-b' },
		}
		const changed = projector.projectSession(session).timeline

		expect(changed.map((item) => item.showHeader)).toEqual([
			true,
			true,
			true,
			false,
		])
		expect(changed[2]).not.toBe(initial[2])
		expect(changed[3]).toBe(initial[3])
	})

	it('reuses subagent views until their status changes', () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		master.subagents.child = child
		const session = sessionWith(master)
		const projector = new ChatViewProjector()

		const initial = projector.projectSession(session)
		const unchanged = projector.projectSession(session)
		expect(unchanged.agentsById.child).toBe(initial.agentsById.child)

		child.status = 'completed'
		const changed = projector.projectSession(session)
		expect(changed.agentsById.child).not.toBe(initial.agentsById.child)
		expect(changed.agentsById.child.status).toBe('completed')
	})
})
