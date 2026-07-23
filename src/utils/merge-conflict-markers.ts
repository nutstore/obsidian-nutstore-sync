const START_MARKER = /^<{7,}(?: .*)?$/
const BASE_MARKER = /^\|{7,}(?: .*)?$/
const SEPARATOR_MARKER = /^={7,}$/
const END_MARKER = /^>{7,}(?: .*)?$/

type ConflictState = 'idle' | 'current' | 'base' | 'incoming'

export function countMergeConflictBlocks(content: string): number {
	let state: ConflictState = 'idle'
	let count = 0

	for (const line of content.split(/\r?\n/)) {
		if (START_MARKER.test(line)) {
			state = 'current'
			continue
		}

		if (state === 'current' && BASE_MARKER.test(line)) {
			state = 'base'
			continue
		}

		if (
			(state === 'current' || state === 'base') &&
			SEPARATOR_MARKER.test(line)
		) {
			state = 'incoming'
			continue
		}

		if (END_MARKER.test(line)) {
			if (state === 'incoming') {
				count += 1
			}
			state = 'idle'
		}
	}

	return count
}
