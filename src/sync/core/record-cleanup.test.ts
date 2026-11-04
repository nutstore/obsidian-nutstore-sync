import { describe, expect, it } from 'vitest'
import type { FsWalkResult } from '~/fs/fs.interface'
import { shouldCreateCleanRecordTask } from './record-cleanup'

const recordPath = 'Notes 笔记🌿/Entry 记录.md'
function entry(path: string, ignored: boolean): FsWalkResult {
	return {
		stat: {
			path,
			basename: path.split('/').pop() ?? path,
			isDir: false,
			isDeleted: false,
			mtime: 1,
			size: 1,
		},
		ignored,
	}
}
type Presence = 'absent' | 'visible' | 'ignored'
const states: Presence[] = ['absent', 'visible', 'ignored']
function walk(state: Presence): FsWalkResult[] {
	return state === 'absent' ? [] : [entry(recordPath, state === 'ignored')]
}

describe('orphaned synchronization records', () => {
	for (const local of states) {
		for (const remote of states) {
			it(`cleans only after absence on both sides (local ${local}, remote ${remote})`, () => {
				expect(
					shouldCreateCleanRecordTask(recordPath, walk(local), walk(remote)),
				).toBe(local === 'absent' && remote === 'absent')
			})
		}
	}

	it('distinguishes an exact path from a parent, sibling or longer name', () => {
		const local = [
			entry('Notes 笔记🌿', true),
			entry(`${recordPath}.archive`, false),
		]
		const remote = [entry('Notes 笔记🌿/Other 其他.md', false)]
		expect(shouldCreateCleanRecordTask(recordPath, local, remote)).toBe(true)
	})

	it('retains history as inclusion changes until the path disappears from both sides', () => {
		const local = [entry(recordPath, false)]
		const remote = [entry(recordPath, true)]
		expect(shouldCreateCleanRecordTask(recordPath, local, remote)).toBe(false)
		local[0].ignored = true
		expect(shouldCreateCleanRecordTask(recordPath, local, remote)).toBe(false)
		remote[0].ignored = false
		expect(shouldCreateCleanRecordTask(recordPath, [], remote)).toBe(false)
		expect(shouldCreateCleanRecordTask(recordPath, [], [])).toBe(true)
	})
})
