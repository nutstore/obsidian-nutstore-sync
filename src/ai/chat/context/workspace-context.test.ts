import { describe, expect, it } from 'vitest'
import { hash as hashObject } from 'ohash'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import type { SkillRepository } from '~/ai/skills/repository'
import type { AppUIMessage } from '~/ai/chat/types'

function createApp() {
	return {
		workspace: {
			getActiveFile: () => null,
			iterateAllLeaves: () => undefined,
		},
	} as never
}

describe('workspace skill context', () => {
	it('includes metadata only and emits it through normal delta hashing', () => {
		const catalog = [
			{
				name: 'review',
				description: 'Review notes',
				path: '/vault/.agents/skills/review/SKILL.md',
			},
		]
		const repository = { getCatalog: () => catalog } as SkillRepository
		const current = captureWorkspaceContexts(createApp(), repository)

		expect(current.find((entry) => entry.key === 'skills')).toEqual({
			key: 'skills',
			content: catalog,
			hash: hashObject(catalog),
		})
		expect(computeChangedContexts([], current)).toEqual(current)
	})

	it('emits an empty catalog to clear previously disclosed skills', () => {
		const previousCatalog = [
			{
				name: 'review',
				description: 'Review notes',
				path: '/vault/.agents/skills/review/SKILL.md',
			},
		]
		const repository = {
			getCatalog: () => [],
		} as unknown as SkillRepository
		const current = captureWorkspaceContexts(createApp(), repository)
		const previousMessages = [
			{
				id: 'previous',
				role: 'user',
				parts: [
					{
						type: 'data-workspace-context',
						data: {
							deltas: [
								{
									key: 'skills',
									content: previousCatalog,
									hash: hashObject(previousCatalog),
								},
							],
						},
					},
				],
			},
		] satisfies AppUIMessage[]

		expect(computeChangedContexts(previousMessages, current)).toContainEqual({
			key: 'skills',
			content: [],
			hash: hashObject([]),
		})
	})
})
