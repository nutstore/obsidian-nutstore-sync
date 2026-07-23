import { describe, expect, it } from 'vitest'
import { getTraversalWebDAVDBKey } from './get-db-key'

describe('getTraversalWebDAVDBKey', () => {
	it('uses distinct stable hash keys for endpoint, account, and remote path', async () => {
		const common = {
			remoteAccountId: 'neutral-account',
			remoteEndpoint: 'https://example.test/dav',
			remoteBaseDir: '/资料/notes',
		}
		const [first, same, otherAccount, otherEndpoint, otherPath] =
			await Promise.all([
				getTraversalWebDAVDBKey(
					common.remoteAccountId,
					common.remoteEndpoint,
					common.remoteBaseDir,
				),
				getTraversalWebDAVDBKey(
					common.remoteAccountId,
					common.remoteEndpoint,
					common.remoteBaseDir,
				),
				getTraversalWebDAVDBKey(
					'other-account',
					common.remoteEndpoint,
					common.remoteBaseDir,
				),
				getTraversalWebDAVDBKey(
					common.remoteAccountId,
					'https://示例.test/dav',
					common.remoteBaseDir,
				),
				getTraversalWebDAVDBKey(
					common.remoteAccountId,
					common.remoteEndpoint,
					'/资料/archive',
				),
			])

		expect(same).toBe(first)
		expect(new Set([first, otherAccount, otherEndpoint, otherPath]).size).toBe(
			4,
		)
		expect(first).not.toContain(common.remoteAccountId)
		expect(first).not.toContain(common.remoteBaseDir)
	})
})
