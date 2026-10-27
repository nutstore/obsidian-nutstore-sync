import { describe, expect, it } from 'vitest'
import {
	createVaultPathContextItem,
	haveSameUserContextItems,
} from './user-context'

describe('haveSameUserContextItems', () => {
	it('matches the same meaningful bilingual and emoji contexts regardless of order', () => {
		const guide = createVaultPathContextItem('指南/同步说明.md', 'file')
		const status = createVaultPathContextItem('Notes/Status 🌿.md', 'file')

		expect(haveSameUserContextItems([guide, status], [status, guide])).toBe(
			true,
		)
	})

	it('treats duplicate context chips as one semantic context', () => {
		const note = createVaultPathContextItem('记录/中性主题 🚀.md', 'file')

		expect(haveSameUserContextItems([note, note], [note])).toBe(true)
	})

	it('distinguishes different context paths', () => {
		const current = createVaultPathContextItem('项目/当前方案.md', 'file')
		const revised = createVaultPathContextItem('项目/修订方案.md', 'file')

		expect(haveSameUserContextItems([current], [revised])).toBe(false)
	})
})
