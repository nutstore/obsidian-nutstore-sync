import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { getSessionSubagents } from '~/ai/chat/domain'
import { MAX_CONCURRENT_TASKS_PER_SESSION } from '~/ai/chat/prompts'
import { normalizeRehydratedExecution } from '~/ai/chat/session/rehydration-execution'
import { createAbortError } from '~/utils/abort'
import type { AgentTurnResult } from '~/ai/chat/runtime/agent-runner'
import { createAIRuntimeHarness } from '../harness/ai-runtime-harness'
import {
	DeterministicScheduler,
	flushMicrotasks,
	flushUntil,
} from '../harness/async-scheduler'
import { simParams } from '../harness/sim-config'

const COMPLETED_TURN = (text: string): AgentTurnResult => ({
	status: 'completed',
	text,
})

describe('AI runtime deterministic interleaving & chaos simulation', () => {
	it('maintains state-machine invariants under arbitrary completion/failure/cancellation interleavings and slot saturation', async () => {
		const outcomeArb = fc.constantFrom<'complete' | 'fail' | 'cancel'>(
			'complete',
			'fail',
			'cancel',
		)
		const scenarioArb = fc.record({
			spawnCount: fc.integer({
				min: MAX_CONCURRENT_TASKS_PER_SESSION + 1,
				max: MAX_CONCURRENT_TASKS_PER_SESSION + 5,
			}),
			outcomes: fc.array(outcomeArb, { minLength: 8, maxLength: 16 }),
			stepOrder: fc.array(fc.nat(30), { minLength: 10, maxLength: 40 }),
			abortAtStep: fc.option(fc.integer({ min: 0, max: 4 }), {
				nil: undefined,
			}),
		})

		await fc.assert(
			fc.asyncProperty(scenarioArb, async (scenario) => {
				const scheduler = new DeterministicScheduler()
				let turnCounter = 0

				const h = createAIRuntimeHarness({
					onRunTurn: ({ agent, abortSignal }) => {
						const idx = turnCounter++
						const plannedOutcome =
							scenario.outcomes[idx % scenario.outcomes.length]
						return scheduler.defer(`turn:${agent.id}:${idx}`, () => {
							if (abortSignal?.aborted || plannedOutcome === 'cancel') {
								throw createAbortError(`Cancelled #${idx}`)
							}
							if (plannedOutcome === 'fail') {
								throw new Error(`Injected failure #${idx} 中性故障 🌱`)
							}
							return COMPLETED_TURN(`Result #${idx} 中性结果 🌿`)
						})
					},
				})

				const spawnedIds: string[] = []
				for (let i = 0; i < scenario.spawnCount; i += 1) {
					const agent = await h.spawn(`Task #${i} 任务 🌱`)
					spawnedIds.push(agent.id)
				}
				await flushMicrotasks(12)

				// Concurrency slot cap must never be exceeded
				const initialRunning = getSessionSubagents(h.session).filter(
					(agent) => agent.status === 'running',
				)
				expect(initialRunning.length).toBeLessThanOrEqual(
					MAX_CONCURRENT_TASKS_PER_SESSION,
				)

				// Step through completions in randomized deterministic order
				let steps = 0
				while (scheduler.pendingCount > 0 && steps < 100) {
					if (
						scenario.abortAtStep !== undefined &&
						steps === scenario.abortAtStep &&
						!h.controller.signal.aborted
					) {
						h.controller.abort()
						h.manager.cancelAllNonTerminalAgents(h.session)
						await flushMicrotasks(8)
					}
					const choice = scenario.stepOrder[steps % scenario.stepOrder.length]
					await scheduler.stepAt(choice)
					await flushMicrotasks(10)

					const runningNow = getSessionSubagents(h.session).filter(
						(agent) => agent.status === 'running',
					)
					expect(runningNow.length).toBeLessThanOrEqual(
						MAX_CONCURRENT_TASKS_PER_SESSION,
					)
					steps += 1
				}

				await flushUntil(
					() =>
						getSessionSubagents(h.session).every(
							(agent) =>
								agent.status === 'completed' ||
								agent.status === 'failed' ||
								agent.status === 'cancelled',
						),
					{ maxTicks: 80 },
				)

				// Invariant 0: Turns actually executed through our scheduler
				expect(turnCounter).toBeGreaterThan(0)

				// Invariant 1: Zero zombie running/queued agents remain
				const subagents = getSessionSubagents(h.session)
				expect(subagents).toHaveLength(scenario.spawnCount)
				for (const agent of subagents) {
					expect(['completed', 'failed', 'cancelled']).toContain(agent.status)
					expect(agent.finishedAt).toBeDefined()
				}

				// Invariant 2: Zero duplicate task-result-ready notifications per taskId
				const notifiedTaskIds = new Set<string>()
				for (const wake of h.masterWakes) {
					for (const part of wake.input.parts) {
						if (
							part.type === 'data-system-notification' &&
							part.data.kind === 'task-result-ready'
						) {
							expect(
								notifiedTaskIds.has(part.data.taskId),
								`Duplicate task-result-ready notification for ${part.data.taskId}`,
							).toBe(false)
							notifiedTaskIds.add(part.data.taskId)
						}
					}
				}
			}),
			simParams(24, 601),
		)
	})

	it('rolls back cleanly without leaking uncommitted messages when persistSession fails mid-delivery', async () => {
		let failNextPersist = false
		const h = createAIRuntimeHarness({
			onPersistSession: async (target) => {
				if (failNextPersist) {
					failNextPersist = false
					throw new Error('Disk full 磁盘已满 💥')
				}
				void target
			},
		})

		const worker = await h.spawn('Worker task 工作任务 🌱')
		await flushMicrotasks()

		const beforeCount = worker.pendingInputs.length
		failNextPersist = true
		await expect(
			h.manager.sendMessage(
				h.address('master'),
				worker.id,
				'Uncommitted message 未提交消息 🌿',
			),
		).rejects.toThrow('Disk full')

		// Failed persist must not leave a ghost pending input behind
		expect(worker.pendingInputs).toHaveLength(beforeCount)

		// Subsequent healthy message delivery must succeed cleanly
		await h.manager.sendMessage(
			h.address('master'),
			worker.id,
			'Committed message 已提交消息 ✅',
		)
		expect(worker.pendingInputs).toHaveLength(beforeCount + 1)

		// Cleanly finish turn 1, then turn 2 triggered by the committed message
		expect({
			status: worker.status,
			turns: h.activeTurns.get(worker.id)?.length ?? 0,
			pending: worker.pendingInputs.length,
		}).toEqual({ status: 'running', turns: 1, pending: 1 })
		h.getLatestTurn(worker.id)!.deferred.resolve(COMPLETED_TURN('Turn 1 done'))
		await flushUntil(() => (h.activeTurns.get(worker.id)?.length ?? 0) === 2)
		h.getLatestTurn(worker.id)!.deferred.resolve(COMPLETED_TURN('Turn 2 done'))
		await flushUntil(() => worker.status === 'completed')
	})

	it('rehydrates crashed mid-flight sessions without leaving any running, queued, or waiting subagent zombies', () => {
		const statuses = [
			'running',
			'queued',
			'waiting',
			'completed',
			'failed',
			'cancelled',
		] as const

		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...statuses), { minLength: 1, maxLength: 8 }),
				(subStatuses) => {
					const h = createAIRuntimeHarness()
					subStatuses.forEach((status, index) => {
						const id = `agent-${index}`
						h.master.subagents[id] = {
							...h.master,
							id,
							type: 'subagent',
							status,
							subagents: {},
							pendingInputs: [],
							timeline: [],
							operations: {},
							toolTimings: {},
						}
					})

					const hadNonTerminal = subStatuses.some(
						(status) =>
							status === 'running' ||
							status === 'queued' ||
							status === 'waiting',
					)
					const changed = normalizeRehydratedExecution(h.session)
					expect(changed).toBe(hadNonTerminal)

					for (const agent of getSessionSubagents(h.session)) {
						expect(['completed', 'failed', 'cancelled']).toContain(agent.status)
					}
				},
			),
			simParams(40, 602),
		)
	})
})
