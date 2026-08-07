import { describe, expect, it } from 'vitest'
import { createFragmentReadTracker } from '~/ai/tools/file-operation'
import { type ChatFragment } from '~/ai/chat/domain'

describe('createFragmentReadTracker', () => {
	it('reports a path as read when it was in readVaultPaths at creation', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
			readVaultPaths: ['notes/a.md'],
		}
		const tracker = createFragmentReadTracker(fragment)

		expect(tracker.hasRead('notes/a.md')).toBe(true)
		expect(tracker.hasRead('notes/b.md')).toBe(false)
	})

	it('does not report a path as read when marked after tracker creation (batch-snapshot)', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const tracker = createFragmentReadTracker(fragment)

		expect(tracker.hasRead('notes/a.md')).toBe(false)
		tracker.markRead('notes/a.md')
		expect(tracker.hasRead('notes/a.md')).toBe(false)
		expect(fragment.readVaultPaths).toEqual(['notes/a.md'])
	})

	it('allows a path marked in a previous batch to be read in the next batch', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const batch1Tracker = createFragmentReadTracker(fragment)
		batch1Tracker.markRead('notes/a.md')
		expect(batch1Tracker.hasRead('notes/a.md')).toBe(false)

		const batch2Tracker = createFragmentReadTracker(fragment)
		expect(batch2Tracker.hasRead('notes/a.md')).toBe(true)
	})

	it('deduplicates markRead calls for the same path', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const tracker = createFragmentReadTracker(fragment)

		tracker.markRead('notes/a.md')
		tracker.markRead('notes/a.md')
		tracker.markRead('notes/a.md')

		expect(fragment.readVaultPaths).toEqual(['notes/a.md'])
	})

	it('tracks multiple distinct paths across batches', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const batch1 = createFragmentReadTracker(fragment)
		batch1.markRead('notes/a.md')
		batch1.markRead('notes/b.md')

		const batch2 = createFragmentReadTracker(fragment)
		expect(batch2.hasRead('notes/a.md')).toBe(true)
		expect(batch2.hasRead('notes/b.md')).toBe(true)
		expect(batch2.hasRead('notes/c.md')).toBe(false)
		expect(fragment.readVaultPaths).toEqual(['notes/a.md', 'notes/b.md'])
	})

	it('initializes readVaultPaths lazily when undefined', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		expect(fragment.readVaultPaths).toBeUndefined()

		const tracker = createFragmentReadTracker(fragment)
		tracker.markRead('notes/a.md')

		expect(fragment.readVaultPaths).toEqual(['notes/a.md'])
	})

	it('does not throw when markRead receives an empty path', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const tracker = createFragmentReadTracker(fragment)

		expect(() => tracker.markRead('')).not.toThrow()
		expect(fragment.readVaultPaths).toBeUndefined()
	})

	it('hasRead returns false when readVaultPaths is undefined', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const tracker = createFragmentReadTracker(fragment)

		expect(tracker.hasRead('notes/a.md')).toBe(false)
	})

	it('hasRead does not mutate the fragment', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
			readVaultPaths: ['notes/a.md'],
		}
		const tracker = createFragmentReadTracker(fragment)

		tracker.hasRead('notes/a.md')
		tracker.hasRead('notes/b.md')

		expect(fragment.readVaultPaths).toEqual(['notes/a.md'])
	})

	it('accepts an explicit readSnapshot parameter', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
			readVaultPaths: ['notes/live.md'],
		}
		const snapshot = new Set(['notes/snapshot-only.md'])
		const tracker = createFragmentReadTracker(fragment, snapshot)

		expect(tracker.hasRead('notes/snapshot-only.md')).toBe(true)
		expect(tracker.hasRead('notes/live.md')).toBe(false)

		tracker.markRead('notes/new.md')
		expect(fragment.readVaultPaths).toEqual(['notes/live.md', 'notes/new.md'])
		expect(tracker.hasRead('notes/new.md')).toBe(false)
	})

	it('resetSnapshot advances to include reads from the current batch', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const tracker = createFragmentReadTracker(fragment)

		tracker.markRead('notes/a.md')
		expect(tracker.hasRead('notes/a.md')).toBe(false)

		tracker.resetSnapshot()
		expect(tracker.hasRead('notes/a.md')).toBe(true)
		expect(tracker.hasRead('notes/b.md')).toBe(false)
	})

	it('resetSnapshot picks up reads from multiple batches', () => {
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const tracker = createFragmentReadTracker(fragment)

		tracker.markRead('notes/a.md')
		tracker.resetSnapshot()
		expect(tracker.hasRead('notes/a.md')).toBe(true)

		tracker.markRead('notes/b.md')
		expect(tracker.hasRead('notes/b.md')).toBe(false)

		tracker.resetSnapshot()
		expect(tracker.hasRead('notes/a.md')).toBe(true)
		expect(tracker.hasRead('notes/b.md')).toBe(true)
	})
})
