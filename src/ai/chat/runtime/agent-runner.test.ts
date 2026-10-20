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
	presentation?: { firstText: string; finalText: string },
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
				...(presentation
					? [
							{ type: 'text-start' as const, id: 'progress' },
							{
								type: 'text-delta' as const,
								id: 'progress',
								delta: presentation.firstText,
							},
							{ type: 'text-end' as const, id: 'progress' },
						]
					: []),
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
				{
					type: 'text-delta',
					id: 'reply',
					delta: presentation?.finalText ?? 'Result 结果 🌿',
				},
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
	it('preserves progress and tool outcomes in the ordinary chat transcript', async () => {
		const tools = {
			lookup: tool({
				inputSchema: z.object({ text: z.string() }),
				execute: async ({ text }) => text,
			}),
		}
		const progress = '准备制作 Preparing App 🌿'
		const final = '制作完成 App ready 📘'
		const { run, model, agent } = harness(tools, undefined, {
			firstText: progress,
			finalText: final,
		})
		expect((await run(() => false)).status).toBe('completed')
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(progress)
		expect(JSON.stringify(agent.timeline)).toContain(progress)
		expect(JSON.stringify(agent.timeline)).toContain(final)
		expect(
			agent.timeline
				.flatMap((message) => message.parts)
				.some(
					(part) =>
						part.type === 'dynamic-tool' && part.state === 'output-available',
				),
		).toBe(true)
	})
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

	it('receives an agent message only after all parallel tools have terminal outcomes', async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const view = harness({
			lookup: tool({
				inputSchema: z.object({ text: z.string() }),
				execute: ({ text }) => text,
			}),
			inspect: tool({
				inputSchema: z.object({ text: z.string() }),
				execute: async ({ text }) => {
					await gate
					return text
				},
			}),
		})
		const running = view.run(() => false)
		await vi.waitFor(() =>
			expect(view.agent.toolTimings.lookup?.finishedAt).toBeDefined(),
		)
		view.agent.pendingInputs.push({
			id: 'agent-mail',
			role: 'user',
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'agent-message',
						sender: 'explorer',
						recipient: 'master',
						message: '补充依据 / Additional evidence 🌿',
						createdAt: 1,
					},
				},
			],
		})
		expect(
			view.agent.timeline.some((message) => message.id === 'agent-mail'),
		).toBe(false)
		release()
		expect(await running).toMatchObject({ status: 'needs-input' })
		expect(view.model.doStreamCalls).toHaveLength(1)
		await view.run(() => false)
		const transcript = await uiMessagesToModelMessages(view.agent.timeline)
		expect(transcript.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'user',
			'assistant',
		])
		expect(JSON.stringify(transcript[3])).toContain('AgentInformation')
		expect(view.agent.pendingInputs).toEqual([])
	})

	it('waits until a pure text response ends before receiving agent input', async () => {
		const view = harness({})
		let output!: ReadableStreamDefaultController<StreamPart>
		view.model.doStream = async () => ({
			stream: new ReadableStream<StreamPart>({
				start(controller) {
					output = controller
					controller.enqueue({ type: 'text-start', id: 'text' })
					controller.enqueue({
						type: 'text-delta',
						id: 'text',
						delta: '主题 / Theme 🌿',
					})
				},
			}),
		})
		const running = view.run(() => false)
		await vi.waitFor(() => expect(output).toBeDefined())
		view.agent.pendingInputs.push({
			id: 'agent-mail',
			role: 'user',
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'agent-message',
						sender: 'explorer',
						recipient: 'master',
						message: '补充依据 / Additional evidence 🌿',
						createdAt: 1,
					},
				},
			],
		})
		expect(
			view.agent.timeline.some((message) => message.id === 'agent-mail'),
		).toBe(false)
		output.enqueue({ type: 'text-end', id: 'text' })
		output.enqueue(finish(false))
		output.close()
		expect(await running).toMatchObject({ status: 'needs-input' })
		expect(view.agent.pendingInputs).toHaveLength(1)
	})

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
