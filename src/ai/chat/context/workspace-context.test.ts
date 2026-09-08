import { describe, expect, it, vi } from 'vitest'
import { hash as hashObject } from 'ohash'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import type { SkillRepository } from '~/ai/skills/repository'
import type { AppUIMessage, WorkspaceContextDelta } from '~/ai/chat/types'

function createApp() {
	return {
		workspace: {
			getActiveFile: () => null,
			iterateAllLeaves: () => undefined,
		},
	} as never
}

function asPreviousMessage(deltas: WorkspaceContextDelta[]): AppUIMessage {
	return {
		id: 'previous',
		role: 'user',
		parts: [{ type: 'data-workspace-context', data: { deltas } }],
	} as AppUIMessage
}

function captureAt(date: Date) {
	return captureWorkspaceContexts(createApp(), undefined, {
		now: () => date,
	})
}

describe('workspace date context', () => {
	it('captures the local date, English weekday, and timezone', () => {
		const current = captureAt(new Date(2024, 1, 29, 12))
		const dateContext = current.find((entry) => entry.key === 'currentDate')

		expect(dateContext).toEqual({
			key: 'currentDate',
			content: {
				date: '2024-02-29',
				weekday: 'Thursday',
				timezone: expect.any(String),
			},
			hash: hashObject(dateContext?.content),
		})
	})

	it('dedupes the same day and emits a new delta after midnight', () => {
		const beforeMidnight = captureAt(new Date(2024, 1, 29, 23, 59, 59))
		const sameDay = captureAt(new Date(2024, 1, 29, 23, 59, 59, 999))
		const nextDay = captureAt(new Date(2024, 2, 1, 0, 0, 0))

		expect(
			computeChangedContexts([asPreviousMessage(beforeMidnight)], sameDay),
		).not.toContainEqual(expect.objectContaining({ key: 'currentDate' }))
		expect(
			computeChangedContexts([asPreviousMessage(beforeMidnight)], nextDay),
		).toContainEqual(
			expect.objectContaining({
				key: 'currentDate',
				content: expect.objectContaining({
					date: '2024-03-01',
					weekday: 'Friday',
				}),
			}),
		)
	})

	it('falls back to a manual weekday when Intl is unavailable', () => {
		vi.stubGlobal('Intl', undefined)
		try {
			const current = captureAt(new Date(2024, 1, 29, 12))
			const dateContext = current.find((entry) => entry.key === 'currentDate')

			expect(dateContext?.content).toEqual({
				date: '2024-02-29',
				weekday: 'Thursday',
			})
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

describe('workspace skill context', () => {
	it('includes metadata only and emits it through normal delta hashing', () => {
		const catalog = [
			{
				name: 'review',
				description: 'Review notes',
				path: '/.agents/skills/review/SKILL.md',
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

	it('does not inject long-term memory into normal workspace context', () => {
		const repository = {
			getCatalog: () => [
				{
					name: 'review',
					description: 'Review neutral notes 复核中性笔记 🌿',
					path: '/.agents/skills/review/SKILL.md',
				},
			],
		} as SkillRepository

		const current = captureWorkspaceContexts(createApp(), repository)
		expect(current.some((entry) => entry.key.startsWith('memory:'))).toBe(false)
	})

	it('emits an empty catalog to clear previously disclosed skills', () => {
		const previousCatalog = [
			{
				name: 'review',
				description: 'Review notes',
				path: '/.agents/skills/review/SKILL.md',
			},
		]
		const repository = {
			getCatalog: () => [],
		} as unknown as SkillRepository
		const current = captureWorkspaceContexts(createApp(), repository)
		const previousMessages = [
			asPreviousMessage([
				{
					key: 'skills',
					content: previousCatalog,
					hash: hashObject(previousCatalog),
				},
			]),
		]

		expect(computeChangedContexts(previousMessages, current)).toContainEqual({
			key: 'skills',
			content: [],
			hash: hashObject([]),
		})
	})
})
