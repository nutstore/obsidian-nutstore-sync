import type { ChatDisplayBlock, ChatRunState } from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from '~/ai/chat/ui/types'
import { toolCallDisplayTitle } from './utils'

export interface TurnMessage {
	kind: 'message'
	key: string
	item: ChatTimelineMessageItem
	blocks: ChatDisplayBlock[]
}

export interface TurnProcess {
	kind: 'process'
	key: string
	messages: TurnMessage[]
	active: boolean
}

export type TurnRow = TurnMessage | TurnProcess

/** UI-only slices retain the original message and block identities for actions. */
export function projectTurns(
	timeline: readonly ChatTimelineMessageItem[],
	sessionId: string | undefined,
	runState: ChatRunState,
): TurnRow[] {
	const rows: TurnRow[] = []
	let turn: ChatTimelineMessageItem[] = []
	let userId: string | undefined
	const messageRow = (
		item: ChatTimelineMessageItem,
		blocks = item.displayBlocks,
	): TurnMessage => ({
		kind: 'message',
		key: JSON.stringify([sessionId, item.message.id]),
		item,
		blocks,
	})
	const flush = (active: boolean) => {
		const assistants = turn.filter((item) => item.message.role === 'assistant')
		const last = assistants.at(-1)
		const final =
			last && !last.displayBlocks.some((block) => block.kind === 'tool-call')
				? last
				: undefined
		const process: TurnProcess = {
			kind: 'process',
			key: JSON.stringify([sessionId, userId, 'process']),
			messages: [],
			active,
		}
		let inserted = false
		for (const item of turn) {
			if (item.message.role !== 'assistant') {
				rows.push(messageRow(item))
				continue
			}
			const blocks =
				item === final
					? item.displayBlocks.filter((block) => block.kind !== 'content')
					: item.displayBlocks
			if (blocks.length) {
				process.messages.push(messageRow(item, blocks))
				if (!inserted) {
					rows.push(process)
					inserted = true
				}
			}
			if (item === final) {
				const body = item.displayBlocks.filter(
					(block) => block.kind === 'content',
				)
				if (body.length) rows.push(messageRow(item, body))
			}
		}
		turn = []
	}
	for (const item of timeline) {
		if (
			item.message.role === 'user' &&
			!(
				item.displayBlocks.length > 0 &&
				item.displayBlocks.every(
					(block) => block.kind === 'system-notification',
				)
			)
		) {
			flush(false)
			userId = item.message.id
			rows.push(messageRow(item))
		} else if (userId === undefined) rows.push(messageRow(item))
		else turn.push(item)
	}
	flush(runState !== 'idle')
	return rows
}

/** Finished turns use a stable label; active turns describe the last assistant’s tools. */
export function turnProcessTitle(
	process: TurnProcess,
	labels: { thinking: string; completed: string },
): string {
	if (!process.active) return labels.completed
	const calls =
		process.messages
			.at(-1)
			?.item.displayBlocks.filter((block) => block.kind === 'tool-call') ?? []
	return calls.length
		? calls
				.map((block) => toolCallDisplayTitle(block.toolCall) || labels.thinking)
				.join(', ')
		: labels.thinking
}
