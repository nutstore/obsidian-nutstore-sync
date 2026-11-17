import type { ChatTimelineMessageItem } from '~/ai/chat/ui/types'
import { isTurnStart } from './turn-projection'

/** Newest turns mounted on restore; older turns stay one page away. */
export const DEFAULT_VISIBLE_TURNS = 20
export const VISIBLE_TURN_PAGE = 20

/**
 * Keeps the newest `turnLimit` user turns. The slice starts at a user message
 * so turn grouping and process ownership stay intact.
 */
export function sliceTimelineByTurns(
	timeline: ChatTimelineMessageItem[],
	turnLimit: number,
): ChatTimelineMessageItem[] {
	if (turnLimit <= 0) return timeline
	let turns = 0
	for (let index = timeline.length - 1; index >= 0; index -= 1) {
		if (!isTurnStart(timeline[index])) continue
		turns += 1
		if (turns === turnLimit) return timeline.slice(index)
	}
	return timeline
}
