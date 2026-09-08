import type { AppUIMessage, ChatSubmission } from '~/ai/chat/types'
import { copyUserContextItems } from '~/ai/chat/context/user-context'
import createId from '~/utils/create-id'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'

export interface TaskOrigin {
	turnId: string
	signal: AbortSignal
}

export type MasterTurn =
	| {
			turnId: string
			kind: 'user-submission'
			submission: ChatSubmission
	  }
	| {
			turnId: string
			kind: 'agent-input'
			input: AppUIMessage
			origin: TaskOrigin
	  }
	| {
			turnId: string
			kind: 'regenerate'
			targetMessageId: string
	  }

export interface ActiveMasterTurn {
	turn: MasterTurn
	abortController: AbortController
}

export interface MasterTurnScheduler {
	queued: MasterTurn[]
	active?: ActiveMasterTurn
}

export function createMasterTurnScheduler(): MasterTurnScheduler {
	return { queued: [] }
}

export function enqueueUserSubmission(
	runtime: SessionRuntimeState,
	submission: ChatSubmission,
) {
	const turnId = createId('turn')
	runtime.scheduler.queued.push({
		turnId,
		kind: 'user-submission',
		submission: {
			text: submission.text,
			userContext: copyUserContextItems(submission.userContext),
		},
	})
	return turnId
}

export function enqueueAgentInput(
	runtime: SessionRuntimeState,
	input: AppUIMessage,
	origin: TaskOrigin,
) {
	if (origin.signal.aborted) return undefined
	const turnId = createId('turn')
	runtime.scheduler.queued.push({
		turnId,
		kind: 'agent-input',
		input,
		origin,
	})
	return turnId
}

export function enqueueRegenerate(
	runtime: SessionRuntimeState,
	targetMessageId: string,
) {
	const turnId = createId('turn')
	runtime.scheduler.queued.push({
		turnId,
		kind: 'regenerate',
		targetMessageId,
	})
	return turnId
}

export function claimNextTurn(runtime: SessionRuntimeState) {
	if (runtime.scheduler.active) return undefined
	while (runtime.scheduler.queued.length > 0) {
		const turn = runtime.scheduler.queued.shift()!
		if (turn.kind === 'agent-input' && turn.origin.signal.aborted) continue
		const active: ActiveMasterTurn = {
			turn,
			abortController: new AbortController(),
		}
		runtime.scheduler.active = active
		return active
	}
	return undefined
}

export function ownsActiveTurn(
	runtime: SessionRuntimeState,
	turnId: string,
	signal: AbortSignal,
) {
	const active = runtime.scheduler.active
	return (
		active?.turn.turnId === turnId && active.abortController.signal === signal
	)
}

export function isTurnAlive(
	runtime: SessionRuntimeState,
	sessionId: string,
	turnId: string,
	signal: AbortSignal,
	isDeleted: (sessionId: string) => boolean,
) {
	return (
		!isDeleted(sessionId) &&
		!signal.aborted &&
		ownsActiveTurn(runtime, turnId, signal)
	)
}

export function completeActiveTurn(
	runtime: SessionRuntimeState,
	turnId: string,
	signal: AbortSignal,
) {
	if (!ownsActiveTurn(runtime, turnId, signal)) return false
	runtime.scheduler.active = undefined
	return true
}

export function failActiveTurn(
	runtime: SessionRuntimeState,
	turnId: string,
	signal: AbortSignal,
) {
	return completeActiveTurn(runtime, turnId, signal)
}

export function cancelActiveTurn(
	runtime: SessionRuntimeState,
	turnId: string,
	signal: AbortSignal,
) {
	return completeActiveTurn(runtime, turnId, signal)
}

export function discardQueuedTurns(
	runtime: SessionRuntimeState,
	shouldDiscard: (turn: MasterTurn) => boolean,
) {
	runtime.scheduler.queued = runtime.scheduler.queued.filter(
		(turn) => !shouldDiscard(turn),
	)
}

export function hasQueuedTurns(runtime: SessionRuntimeState) {
	return runtime.scheduler.queued.length > 0
}

export function getQueuedUserSubmissions(runtime: SessionRuntimeState) {
	return runtime.scheduler.queued.flatMap((turn) =>
		turn.kind === 'user-submission' ? [turn.submission] : [],
	)
}
