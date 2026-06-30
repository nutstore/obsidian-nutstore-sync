import { describe, expect, it } from 'vitest'
import {
	getUserContextItemHash,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import {
	enqueuePendingSubmission,
	hasQueuedSubmission,
} from './pending-submission'

function makeContext(
	hash: string,
): Extract<UserContextItem, { type: 'vault-path' }> {
	return {
		type: 'vault-path',
		hash,
		kind: 'file',
		path: `${hash}.md`,
	}
}

describe('pending submission helpers', () => {
	it('ignores draft user context when deciding whether auto-resume should run', () => {
		expect(
			hasQueuedSubmission({
				pending: [],
			}),
		).toBe(false)

		expect(
			hasQueuedSubmission({
				pending: [{ text: 'hello', userContext: [] }],
			}),
		).toBe(true)

		expect(
			hasQueuedSubmission({
				pending: [{ text: '', userContext: [makeContext('ctx-1')] }],
			}),
		).toBe(true)
	})

	it('enqueues a single pending submission and dedupes its user context', () => {
		const draft = makeContext('draft')
		const active = makeContext('active')
		const duplicateActive = makeContext('active')

		const merged = enqueuePendingSubmission(
			[],
			{ text: 'hello', userContext: [draft] },
			[active, duplicateActive],
			(items) => {
				const seen = new Set<string>()
				return items.filter((item) => {
					const hash = getUserContextItemHash(item)
					if (seen.has(hash)) {
						return false
					}
					seen.add(hash)
					return true
				})
			},
		)

		expect(merged).toHaveLength(1)
		expect(merged[0]?.text).toBe('hello')
		expect(
			merged[0]?.userContext.map((item) => getUserContextItemHash(item)),
		).toEqual(['draft', 'active'])
	})
})
