import { describe, expect, it, vi } from 'vitest'
import { tool, type ToolSet } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import {
	createEmptyMasterAgent,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import { AgentRunner } from './agent-runner'
import { createMasterTurnScheduler } from './master-turn-scheduler'
import { InMemoryViewImageAttachmentRegistry } from '~/ai/tools/view-image-attachments'

const resolveLanguageModel = vi.hoisted(() => vi.fn())
vi.mock('~/ai/core/runtime', () => ({
	resolveLanguageModel,
	prepareMessagesForModel: (
		_provider: unknown,
		_model: string,
		messages: unknown,
	) => messages,
}))
vi.mock('~/ai/chat/prompts', () => ({
	buildAgentSystemPrompt: async () => 'Inspect 示例 🌿',
}))

type StreamPart =
	Awaited<
		ReturnType<MockLanguageModelV4['doStream']>
	>['stream'] extends ReadableStream<infer Part>
		? Part
		: never

function stream(parts: StreamPart[]) {
	return {
		stream: new ReadableStream<StreamPart>({
			start(controller) {
				for (const part of parts) controller.enqueue(part)
				controller.close()
			},
		}),
	}
}

function finish(toolCalls: boolean): StreamPart {
	return {
		type: 'finish',
		finishReason: {
			unified: toolCalls ? 'tool-calls' : 'stop',
			raw: undefined,
		},
		usage: {
			inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 5, text: 5, reasoning: 0 },
		},
	}
}

function harness(
	tools: ToolSet,
	viewImageAttachments = new InMemoryViewImageAttachmentRegistry(),
) {
	const agent = createEmptyMasterAgent(1)
	agent.timeline.push({
		id: 'input',
		role: 'user',
		parts: [{ type: 'text', text: 'Inspect 示例 🌿' }],
	})
	const session: ChatSession = {
		schemaVersion: 2,
		id: 'session',
		createdAt: 1,
		updatedAt: 1,
		subagents: { master: agent },
	}
	const model = new MockLanguageModelV4({
		doStream: [
			stream([
				...Object.keys(tools).map((toolName): StreamPart => ({
					type: 'tool-call',
					toolCallId: toolName,
					toolName,
					input: JSON.stringify({ text: 'Read 读取 🌿' }),
				})),
				finish(true),
			]),
			stream([
				{ type: 'text-start', id: 'reply' },
				{ type: 'text-delta', id: 'reply', delta: 'Result 结果 🌿' },
				{ type: 'text-end', id: 'reply' },
				finish(false),
			]),
		],
	})
	resolveLanguageModel.mockReturnValue({ model })
	const runner = new AgentRunner(
		{
			getAgentDefinition: () => ({}),
			createTools: async () => tools,
			createStableToolsContext: () => ({}),
			prepareReadTracker: () => ({ resetSnapshot: vi.fn() }),
		} as never,
		{
			persistSession: vi.fn(async () => undefined),
		} as never,
		new MessageFactory({} as never, vi.fn()),
		vi.fn(),
		{} as never,
	)
	const controller = new AbortController()
	return {
		agent,
		model,
		controller,
		run: (shouldYieldAfterToolStep: () => boolean) =>
			runner.runTurn({
				session,
				agent,
				provider: { id: 'provider' } as never,
				model: { id: 'model' } as never,
				depth: 0,
				runtime: {
					runState: 'thinking',
					draft: { text: '', userContext: [] },
					scheduler: createMasterTurnScheduler(),
					viewImageAttachments,
				},
				assistantMeta: {},
				isTurnAlive: () => !controller.signal.aborted,
				taskOrigin: { turnId: 'turn', signal: controller.signal },
				abortSignal: controller.signal,
				shouldYieldAfterToolStep,
			}),
	}
}

describe('AgentRunner input handoff', () => {
	it.each([false, true])(
		'waits for every tool outcome before yielding (error: %s)',
		async (fails) => {
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const tools = {
				lookup: tool({
					inputSchema: z.object({ text: z.string() }),
					execute: async ({ text }) => text,
				}),
				inspect: tool({
					inputSchema: z.object({ text: z.string() }),
					execute: async ({ text }) => {
						await gate
						if (fails) throw new Error('Unavailable 暂不可用 🌿')
						return text
					},
				}),
			}
			const view = harness(tools)
			const shouldYield = vi.fn(() => true)
			const result = view.run(shouldYield)
			await vi.waitFor(() =>
				expect(view.agent.toolTimings.lookup?.finishedAt).toBeDefined(),
			)
			expect(view.agent.toolTimings.inspect?.finishedAt).toBeUndefined()
			expect(shouldYield).not.toHaveBeenCalled()
			release()
			expect(await result).toMatchObject({ status: 'completed' })
			expect(view.model.doStreamCalls).toHaveLength(1)
			expect(view.controller.signal.aborted).toBe(false)
			view.agent.timeline.push({
				id: 'next',
				role: 'user',
				parts: [{ type: 'text', text: 'Continue 继续 🌿' }],
			})
			const transcript = await uiMessagesToModelMessages(
				view.agent.timeline,
				tools,
			)
			expect(transcript.map((message) => message.role)).toEqual([
				'user',
				'assistant',
				'tool',
				'user',
			])
			const results = transcript[2]
			if (results.role !== 'tool') throw new Error('Expected tool results')
			const toolResults = results.content.filter(
				(part) => part.type === 'tool-result',
			)
			expect(toolResults.map((part) => part.toolCallId).sort()).toEqual([
				'inspect',
				'lookup',
			])
			expect(
				toolResults.find((part) => part.toolCallId === 'lookup')?.output,
			).toEqual({ type: 'text', value: 'Read 读取 🌿' })
			expect(
				toolResults.find((part) => part.toolCallId === 'inspect')?.output,
			).toEqual(
				fails
					? { type: 'error-text', value: 'Unavailable 暂不可用 🌿' }
					: { type: 'text', value: 'Read 读取 🌿' },
			)
		},
	)

	it('continues the tool loop when no input is queued', async () => {
		const view = harness({
			lookup: tool({
				inputSchema: z.object({ text: z.string() }),
				execute: async ({ text }) => text,
			}),
		})
		expect(await view.run(() => false)).toEqual({
			status: 'completed',
			text: 'Result 结果 🌿',
		})
		expect(view.model.doStreamCalls).toHaveLength(2)
	})

	it('carries an uninjected tool image into the request after handoff', async () => {
		const attachments = new InMemoryViewImageAttachmentRegistry()
		const view = harness(
			{
				view_image: tool({
					inputSchema: z.object({ text: z.string() }),
					execute: async ({ text }) => {
						attachments.register('view_image', {
							type: 'file',
							mediaType: 'image/png',
							data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
						})
						return text
					},
				}),
			},
			attachments,
		)
		await view.run(() => true)
		view.agent.timeline.push({
			id: 'next',
			role: 'user',
			parts: [{ type: 'text', text: 'Describe 图像 🌿' }],
		})
		await view.run(() => false)
		const prompt = view.model.doStreamCalls[1].prompt
		expect(
			prompt.some(
				(message) =>
					message.role === 'user' &&
					message.content.some(
						(part) => part.type === 'file' && part.mediaType === 'image/png',
					),
			),
		).toBe(true)
	})
})
