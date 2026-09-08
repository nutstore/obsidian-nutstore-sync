import type { ToolCallRepeatState } from '~/ai/core/tool-call-repeat'
import type { AgentTurnResult } from '~/ai/chat/runtime/agent-runner'
import type {
	ContextCompactionCoordinator,
	ContextCompactionProgress,
	ContextCompactionRequest,
} from '~/ai/chat/runtime/context-compaction-coordinator'

interface AgentLoopStateBase {
	continuation?: ToolCallRepeatState
}

export type AgentLoopState =
	| (AgentLoopStateBase & { type: 'checking-context' })
	| (AgentLoopStateBase & {
			type: 'compacting' | 'running-turn'
			request: ContextCompactionRequest
	  })

export type AgentLoopError =
	| { type: 'compaction-failed'; cause: unknown }
	| { type: 'compaction-no-progress'; progress: ContextCompactionProgress }
	| { type: 'turn-failed'; cause: unknown }

export type AgentLoopResult =
	| { status: 'completed'; text: string }
	| { status: 'cancelled' }
	| { status: 'failed'; error: AgentLoopError }

interface AgentLoopOptions {
	compactionCoordinator: Pick<
		ContextCompactionCoordinator,
		'inspect' | 'compact' | 'shouldSuspendAtSafePoint'
	>
	createCompactionRequest: () => ContextCompactionRequest
	isTurnAlive: () => boolean
	runTurn: (
		continuation: ToolCallRepeatState | undefined,
		shouldSuspendAtSafePoint: () => boolean,
	) => Promise<AgentTurnResult>
	onStateChange?: (state: AgentLoopState['type']) => void
}

/**
 * Runs one agent through context preparation and model turns.
 *
 * State machine:
 *
 * checking-context
 *   cancelled -------------------------------> cancelled
 *   compaction required ----------------------> compacting
 *   context ready ----------------------------> running-turn
 *
 * compacting
 *   cancelled -------------------------------> cancelled
 *   committed --------------------------------> checking-context
 *   failed -----------------------------------> failed
 *
 * running-turn
 *   cancelled --------------------------------> cancelled
 *   turn error -------------------------------> failed
 *   completed --------------------------------> completed
 *   needs-compaction -------------------------> checking-context
 *
 * Cancellation is terminal and has priority over starting new work. A
 * committed compaction always returns through checking-context so the next
 * model turn is built from the new timeline. A compaction must also reduce the
 * estimated context size; success without progress is terminal to prevent a
 * compact -> check -> compact cycle.
 */
export async function runAgentLoop({
	compactionCoordinator,
	createCompactionRequest,
	isTurnAlive,
	runTurn,
	onStateChange,
}: AgentLoopOptions): Promise<AgentLoopResult> {
	let state: AgentLoopState = { type: 'checking-context' }

	while (true) {
		if (!isTurnAlive()) return { status: 'cancelled' }
		onStateChange?.(state.type)
		try {
			switch (state.type) {
				case 'checking-context': {
					const request = createCompactionRequest()
					const decision = compactionCoordinator.inspect(request)
					if (!isTurnAlive()) return { status: 'cancelled' }
					state = {
						type: decision === 'compact' ? 'compacting' : 'running-turn',
						request,
						continuation: state.continuation,
					}
					break
				}

				case 'compacting': {
					const progress = await compactionCoordinator.compact(state.request)
					if (!isTurnAlive()) return { status: 'cancelled' }
					if (progress.afterTokens >= progress.beforeTokens) {
						return {
							status: 'failed',
							error: { type: 'compaction-no-progress', progress },
						}
					}
					state = {
						type: 'checking-context',
						continuation: state.continuation,
					}
					break
				}

				case 'running-turn': {
					const request = state.request
					const result: AgentTurnResult = await runTurn(
						state.continuation,
						() =>
							!isTurnAlive() ||
							compactionCoordinator.shouldSuspendAtSafePoint(request),
					)
					if (!isTurnAlive()) return { status: 'cancelled' }
					if (result.status === 'completed') return result
					state = {
						type: 'checking-context',
						continuation: result.continuation,
					}
					break
				}
			}
		} catch (cause) {
			if (!isTurnAlive()) return { status: 'cancelled' }
			return {
				status: 'failed',
				error:
					state.type === 'running-turn'
						? { type: 'turn-failed', cause }
						: { type: 'compaction-failed', cause },
			}
		}
	}
}
