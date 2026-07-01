import { describe, expect, it } from 'vitest'
import { FsWalkResult } from '~/fs/fs.interface'
import { StatModel } from '~/model/stat.model'
import { shouldCreateCleanRecordTask } from './record-cleanup'

function file(path: string): StatModel {
	return {
		path,
		basename: path.split('/').pop() ?? path,
		isDir: false,
		isDeleted: false,
		mtime: 1,
		size: 1,
	}
}

function walkResult(path: string, ignored: boolean): FsWalkResult {
	return {
		stat: file(path),
		ignored,
	}
}

describe('shouldCreateCleanRecordTask', () => {
	it('returns false when the path still exists locally but is ignored', () => {
		expect(
			shouldCreateCleanRecordTask(
				'.obsidian/plugins/foo/data.json',
				[walkResult('.obsidian/plugins/foo/data.json', true)],
				[],
			),
		).toBe(false)
	})

	it('returns false when the path still exists remotely but is ignored', () => {
		expect(
			shouldCreateCleanRecordTask(
				'.obsidian/plugins/foo/data.json',
				[],
				[walkResult('.obsidian/plugins/foo/data.json', true)],
			),
		).toBe(false)
	})

	it('returns false when the path is still visible in either side', () => {
		expect(
			shouldCreateCleanRecordTask(
				'notes/a.md',
				[walkResult('notes/a.md', false)],
				[],
			),
		).toBe(false)
		expect(
			shouldCreateCleanRecordTask(
				'notes/a.md',
				[],
				[walkResult('notes/a.md', false)],
			),
		).toBe(false)
	})

	it('returns true only when the path is absent on both sides', () => {
		expect(shouldCreateCleanRecordTask('notes/missing.md', [], [])).toBe(true)
	})
})
