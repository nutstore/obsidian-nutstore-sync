// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createProviderConfig } from '~/ai/catalog/config'
import { ModuleScope } from '~/modules/lifecycle'
import { createAppAI } from '../capabilities/ai'
import { createAppAIHost } from './host'
import { AppAIBridge } from './bridge'
import {
	APP_AI_LIMITS,
	appAIRequestSchema,
	type AppAIEvent,
	type AppAIHost,
	type AppAIStreamPart,
} from './contract'

const resolve = vi.hoisted(() => vi.fn())
vi.mock('~/ai/core/runtime', () => ({
	resolveLanguageModel: resolve,
	assertProviderUsable: () => {},
}))

type ModelPart =
	Awaited<
		ReturnType<MockLanguageModelV4['doStream']>
	>['stream'] extends ReadableStream<infer P>
		? P
		: never
const tokenUsage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const finish = (tools = false): ModelPart => ({
	type: 'finish',
	finishReason: { unified: tools ? 'tool-calls' : 'stop', raw: undefined },
	usage: tokenUsage,
})
function response(parts: ModelPart[]) {
	return {
		stream: new ReadableStream<ModelPart>({
			start(controller) {
				for (const part of parts) controller.enqueue(part)
				controller.close()
			},
		}),
	}
}
function text(value = '你好 Hello 🌿') {
	return response([
		{ type: 'text-start', id: 'text' },
		{ type: 'text-delta', id: 'text', delta: value },
		{ type: 'text-end', id: 'text' },
		finish(),
	])
}
const inputSchema = {
	type: 'object',
	properties: { text: { type: 'string' } },
	required: ['text'],
	additionalProperties: false,
}
function setup(responses = [text()]) {
	const model = new MockLanguageModelV4({ doStream: responses })
	resolve.mockReturnValue({ model })
	const provider = createProviderConfig({
		id: 'neutral',
		apiKey: 'neutral-placeholder',
		models: {
			neutral: {
				id: 'neutral',
				tool_call: true,
				structured_output: true,
				limit: { context: 100_000, output: 1000 },
			},
		},
	})
	const settings = {
		providers: { neutral: provider },
		defaultModel: { providerId: 'neutral', modelId: 'neutral' },
	}
	const scope = new ModuleScope()
	const host = createAppAIHost(() => settings, scope)
	const events: AppAIEvent[] = []
	const client = createAppAI((method, ...args) =>
		bridge.dispatch(method.slice(3), structuredClone(args)),
	)
	const bridge = new AppAIBridge(host, (event) => {
		events.push(event)
		client.receive(structuredClone(event))
	})
	return { model, provider, settings, scope, host, client, bridge, events }
}
afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
	vi.restoreAllMocks()
})

describe('App AI SDK adapter', () => {
	it('preserves SDK reasoning continuation metadata across saved history', async () => {
		const metadata = {
			neutral: { signature: '推理续接 Reasoning continuation 🌿' },
		}
		const h = setup([
			response([
				{ type: 'reasoning-start', id: 'reasoning' },
				{ type: 'reasoning-delta', id: 'reasoning', delta: '分析 Analysis 🌿' },
				{ type: 'reasoning-end', id: 'reasoning', providerMetadata: metadata },
				{ type: 'text-start', id: 'text' },
				{ type: 'text-delta', id: 'text', delta: '完成 Done 🌿' },
				{ type: 'text-end', id: 'text' },
				finish(),
			]),
			text(),
		])
		const agent = h.client.api.createAgent()
		const first = await agent.generate({ prompt: '分析 Analyze 🌿' })
		const history = structuredClone(first.responseMessages)
		expect(history[0].content).toContainEqual({
			type: 'reasoning',
			text: '分析 Analysis 🌿',
			providerOptions: metadata,
		})
		await agent.generate({
			messages: [...history, { role: 'user', content: '继续 Continue 🌿' }],
		})
		expect(h.model.doStreamCalls[1].prompt).toContainEqual(
			expect.objectContaining({
				role: 'assistant',
				content: expect.arrayContaining([
					expect.objectContaining({
						type: 'reasoning',
						providerOptions: metadata,
					}),
				]),
			}),
		)
	})

	it('bounds concurrency across App runtimes sharing the same host', async () => {
		const h = setup()
		resolve.mockReturnValue({
			model: new MockLanguageModelV4({
				doStream: async () => new Promise(() => {}),
			}),
		})
		const controllers = Array.from(
			{ length: APP_AI_LIMITS.globalConcurrent },
			() => new AbortController(),
		)
		const request = appAIRequestSchema.parse({
			runId: 1,
			streaming: false,
			settings: {},
			call: { prompt: '等待 Wait 🌿' },
		})
		const execution = (signal: AbortSignal) => ({
			signal,
			emit: () => {},
			execute: async () => null,
		})
		const runs = controllers.map((controller) =>
			h
				.host(request, execution(controller.signal))
				.catch((error: unknown) => error),
		)
		await expect(
			h.host(request, execution(new AbortController().signal)),
		).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
		controllers.forEach((controller) => controller.abort())
		for (const result of await Promise.all(runs))
			expect(result).toMatchObject({ code: 'CANCELLED' })
	})

	it('streams SDK events and returns only generated messages; replay never executes historical calls', async () => {
		const h = setup([text(), text('继续 Continue 🌿')])
		const agent = h.client.api.createAgent({
			instructions: '中性助手 Neutral helper 🌿',
		})
		const stream = await agent.stream({ prompt: '问候 Greet 🌿' })
		const parts: AppAIStreamPart[] = []
		for await (const part of stream.stream) parts.push(part)
		let streamed = ''
		for await (const chunk of stream.textStream) streamed += chunk
		expect(streamed).toBe('你好 Hello 🌿')
		expect(await stream.text).toBe(streamed)
		expect(parts.map((part) => part.type)).toEqual([
			'start',
			'start-step',
			'text-start',
			'text-delta',
			'text-end',
			'finish-step',
			'finish',
		])
		const history = await stream.responseMessages
		expect(history).toEqual([
			{ role: 'assistant', content: [{ type: 'text', text: streamed }] },
		])
		expect(await stream.finishReason).toBe('stop')
		expect((await stream.usage).inputTokens).toBe(10)
		expect(h.model.doStreamCalls).toHaveLength(1)
		const next = await agent.generate({
			messages: [
				{ role: 'user', content: '问候 Greet 🌿' },
				...history,
				{ role: 'user', content: '继续 Continue 🌿' },
			],
		})
		expect(next.responseMessages).toHaveLength(1)
		expect(next.text).toBe('继续 Continue 🌿')
		expect(h.model.doStreamCalls[1].prompt).toHaveLength(4)
		h.bridge.close()
	})

	it('uses the SDK tool loop, validates inputs and preserves paired tool history', async () => {
		const h = setup([
			response([
				{
					type: 'tool-call',
					toolCallId: 'call',
					toolName: 'inspect',
					input: JSON.stringify({ text: '条目 Item 🌿' }),
				},
				finish(true),
			]),
			text('检查完成 Inspection complete 🌿'),
			text('继续 Continue 🌿'),
		])
		const execute = vi.fn(async (input) => ({ inspected: input.text }))
		const agent = h.client.api.createAgent({
			tools: {
				inspect: {
					description: '检查条目 Inspect an item 🌿',
					inputSchema,
					execute,
				},
			},
		})
		const result = await agent.generate({
			prompt: '检查条目 Inspect an item 🌿',
		})
		expect(execute).toHaveBeenCalledOnce()
		expect(execute).toHaveBeenCalledWith(
			{ text: '条目 Item 🌿' },
			expect.objectContaining({
				toolCallId: 'call',
				abortSignal: expect.any(AbortSignal),
			}),
		)
		expect(result.responseMessages.map((message) => message.role)).toEqual([
			'assistant',
			'tool',
			'assistant',
		])
		expect(result.usage.inputTokens).toBe(20)
		expect(h.events.filter((event) => 'toolCall' in event)).toHaveLength(1)
		await agent.generate({
			messages: [
				...result.responseMessages,
				{ role: 'user', content: '继续 Continue 🌿' },
			],
		})
		expect(execute).toHaveBeenCalledOnce()
		expect(h.model.doStreamCalls).toHaveLength(3)
	})

	it('rejects invalid model tool arguments before entering App code', async () => {
		const h = setup([
			response([
				{
					type: 'tool-call',
					toolCallId: 'invalid',
					toolName: 'inspect',
					input: '{"text":5}',
				},
				finish(true),
			]),
			text(),
		])
		const execute = vi.fn(async () => null)
		const result = await h.client.api
			.createAgent({
				tools: {
					inspect: { description: '检查 Inspect 🌿', inputSchema, execute },
				},
			})
			.generate({ prompt: '检查 Inspect 🌿' })
		expect(execute).not.toHaveBeenCalled()
		expect(
			result.responseMessages.some((message) => message.role === 'tool'),
		).toBe(true)
	})

	it('validates structured output and rejects schema violations', async () => {
		const h = setup([text('{"text":"落子 Move 🌿"}'), text('{"text":5}')])
		const agent = h.client.api.createAgent({
			output: h.client.api.Output.object({ schema: inputSchema }),
		})
		expect((await agent.generate({ prompt: '选择 Choose 🌿' })).output).toEqual(
			{ text: '落子 Move 🌿' },
		)
		await expect(
			agent.generate({ prompt: '选择 Choose 🌿' }),
		).rejects.toMatchObject({ code: 'INVALID_OUTPUT' })
	})

	it('enforces JSON Schema constraints without conversion or default insertion', async () => {
		const h = setup([
			text('{"items":["条目 Item 🌿","条目 Item 🌿"]}'),
			text('{}'),
			text('{"items":["条目 Item 🌿"]}'),
		])
		const agent = h.client.api.createAgent({
			output: h.client.api.Output.object({
				schema: {
					type: 'object',
					properties: {
						items: {
							type: 'array',
							uniqueItems: true,
							items: { type: 'string' },
							default: [],
						},
					},
					required: ['items'],
					additionalProperties: false,
				},
			}),
		})
		for (let index = 0; index < 2; index++)
			await expect(
				agent.generate({ prompt: '整理条目 Organize items 🌿' }),
			).rejects.toMatchObject({ code: 'INVALID_OUTPUT' })
		expect(
			(await agent.generate({ prompt: '整理条目 Organize items 🌿' })).output,
		).toEqual({ items: ['条目 Item 🌿'] })
	})

	it('preserves tool-calls finishReason when the SDK step condition stops the loop', async () => {
		const h = setup([
			response([
				{
					type: 'tool-call',
					toolCallId: 'call',
					toolName: 'inspect',
					input: '{"text":"检查 Inspect 🌿"}',
				},
				finish(true),
			]),
		])
		const result = await h.client.api
			.createAgent({
				stopWhen: h.client.api.isStepCount(1),
				tools: {
					inspect: {
						description: '检查 Inspect 🌿',
						inputSchema,
						execute: async () => null,
					},
				},
			})
			.generate({ prompt: '检查 Inspect 🌿' })
		expect(result.finishReason).toBe('tool-calls')
		expect(h.model.doStreamCalls).toHaveLength(1)
	})

	it('keeps model settings host-owned and redacts provider failures', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const h = setup()
		h.settings.defaultModel.modelId = 'missing'
		await expect(
			h.client.api.createAgent().generate({ prompt: '问候 Greet 🌿' }),
		).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
		h.settings.defaultModel.modelId = 'neutral'
		h.provider.models.neutral.tool_call = false
		await expect(
			h.client.api
				.createAgent({
					tools: {
						inspect: {
							description: '检查 Inspect 🌿',
							inputSchema,
							execute: async () => null,
						},
					},
				})
				.generate({ prompt: '检查 Inspect 🌿' }),
		).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
		resolve.mockReturnValue({
			model: new MockLanguageModelV4({
				doStream: async () => {
					throw new Error('neutral provider detail 🌿')
				},
			}),
		})
		await expect(
			h.client.api.createAgent().generate({ prompt: '问候 Greet 🌿' }),
		).rejects.toMatchObject({ code: 'AI_FAILED', message: 'AI_FAILED' })
	})

	it('aborts an overdue App tool instead of allowing another model step', async () => {
		vi.useFakeTimers()
		const h = setup([
			response([
				{
					type: 'tool-call',
					toolCallId: 'call',
					toolName: 'inspect',
					input: '{"text":"等待 Wait 🌿"}',
				},
				finish(true),
			]),
		])
		let signal: AbortSignal | undefined
		const pending = h.client.api
			.createAgent({
				tools: {
					inspect: {
						description: '等待 Wait 🌿',
						inputSchema,
						execute: (_input, context) => {
							signal = context.abortSignal
							return new Promise(() => {})
						},
					},
				},
			})
			.generate({ prompt: '等待 Wait 🌿' })
		const rejected = expect(pending).rejects.toMatchObject({
			code: 'LIMIT_EXCEEDED',
		})
		await vi.waitFor(() => expect(signal).toBeDefined())
		await vi.advanceTimersByTimeAsync(APP_AI_LIMITS.toolTimeoutMs)
		await rejected
		expect(signal!.aborted).toBe(true)
		expect(h.model.doStreamCalls).toHaveLength(1)
	})

	it.each(['cancel', 'runtime', 'module'] as const)(
		'cancels pending tools on %s and prevents late results from resuming inference',
		async (kind) => {
			const h = setup([
				response([
					{
						type: 'tool-call',
						toolCallId: 'call',
						toolName: 'inspect',
						input: '{"text":"等待 Wait 🌿"}',
					},
					finish(true),
				]),
			])
			let context: { abortSignal: AbortSignal } | undefined
			let complete!: (value: null) => void
			const controller = new AbortController()
			const promise = h.client.api
				.createAgent({
					tools: {
						inspect: {
							description: '等待 Wait 🌿',
							inputSchema,
							execute: (_input, value) => {
								context = value
								return new Promise<null>((resolve) => {
									complete = resolve
								})
							},
						},
					},
				})
				.generate({ prompt: '等待 Wait 🌿', abortSignal: controller.signal })
			const rejection = expect(promise).rejects.toMatchObject({
				code: 'CANCELLED',
			})
			await vi.waitFor(() => expect(context).toBeDefined())
			if (kind === 'cancel') controller.abort()
			if (kind === 'runtime') h.bridge.close()
			if (kind === 'module') h.scope.close()
			await rejection
			expect(context!.abortSignal.aborted).toBe(true)
			complete(null)
			await Promise.resolve()
			expect(h.model.doStreamCalls).toHaveLength(1)
		},
	)
})

describe('App AI bridge policy', () => {
	const request = (runId = 1) => ({
		runId,
		streaming: false,
		settings: {},
		call: { prompt: '问候 Greet 🌿' },
	})
	it('disables AI in startup validation and rejects non-JSON, remote input and SDK escape hatches', async () => {
		const bridge = new AppAIBridge(undefined, () => {})
		await expect(bridge.dispatch('run', [request()])).rejects.toMatchObject({
			code: 'AI_UNAVAILABLE_IN_VALIDATION',
		})
		for (const input of [
			{
				...request(2),
				settings: { providerOptions: { key: '中性 Neutral 🌿' } },
			},
			{
				...request(2),
				call: {
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'image', image: 'https://example.test/neutral' },
							],
						},
					],
				},
			},
			{
				...request(2),
				settings: { stopWhen: { type: 'step-count', count: 21 } },
			},
		])
			await expect(bridge.dispatch('run', [input])).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
			})
	})
	it('bounds active requests, cancels independently and rejects unknown/duplicate tool replies', async () => {
		const host: AppAIHost = async (_request, execution) => {
			await execution.execute('inspect', null, 'pending')
			throw new Error('停止 Stopped 🌿')
		}
		const bridge = new AppAIBridge(host, () => {})
		const calls = Array.from({ length: 4 }, (_, index) => {
			const req = {
				...request(index + 1),
				settings: {
					tools: { inspect: { description: '检查 Inspect 🌿', inputSchema } },
				},
			}
			return bridge.dispatch('run', [req]).catch((error: unknown) => error)
		})
		await expect(bridge.dispatch('run', [request(5)])).rejects.toMatchObject({
			code: 'LIMIT_EXCEEDED',
		})
		await expect(
			bridge.dispatch('toolResult', [1, 'unknown', { output: null }]),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
		await bridge.dispatch('toolResult', [
			2,
			'pending',
			{ output: '完成 Done 🌿' },
		])
		await expect(
			bridge.dispatch('toolResult', [
				2,
				'pending',
				{ output: '重复 Duplicate 🌿' },
			]),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
		await bridge.dispatch('cancel', [1])
		expect(await calls[0]).toMatchObject({ code: 'CANCELLED' })
		bridge.close()
		await Promise.all(calls)
	})
	it('times out a stuck run even when no stream consumer is attached', async () => {
		vi.useFakeTimers()
		const bridge = new AppAIBridge(
			async () => new Promise(() => {}),
			() => {},
		)
		const pending = bridge.dispatch('run', [request()])
		const rejected = expect(pending).rejects.toMatchObject({
			code: 'LIMIT_EXCEEDED',
		})
		await vi.advanceTimersByTimeAsync(APP_AI_LIMITS.timeoutMs)
		await rejected
		bridge.close()
	})
	it('validates the transport contract before model work', () => {
		expect(appAIRequestSchema.safeParse(request()).success).toBe(true)
		expect(
			appAIRequestSchema.safeParse({
				...request(),
				call: { prompt: '问候 Greet 🌿', messages: [] },
			}).success,
		).toBe(false)
	})
})
