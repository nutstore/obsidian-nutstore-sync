import { describe, expect, it, vi } from 'vitest'
import { hash as hashObject } from 'ohash'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import { MemoryRepository } from '~/ai/memory/repository'
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
	return captureWorkspaceContexts(
		createApp(),
		{},
		{
			now: () => date,
		},
	)
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
		const current = captureWorkspaceContexts(createApp(), {
			skills: repository,
		})

		expect(current.find((entry) => entry.key === 'skills')).toEqual({
			key: 'skills',
			content: catalog,
			hash: hashObject(catalog),
		})
		expect(computeChangedContexts([], current)).toEqual(current)
	})

	it('does not inject memory without a memory source', () => {
		const repository = {
			getCatalog: () => [
				{
					name: 'review',
					description: 'Review neutral notes 复核中性笔记 🌿',
					path: '/.agents/skills/review/SKILL.md',
				},
			],
		} as SkillRepository

		const current = captureWorkspaceContexts(createApp(), {
			skills: repository,
		})
		expect(current.some((entry) => entry.key.startsWith('memory'))).toBe(false)
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
		const current = captureWorkspaceContexts(createApp(), {
			skills: repository,
		})
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

describe('workspace memory context', () => {
	function createMemory(files: Record<string, string>, enabled = true) {
		const app = {
			vault: {
				adapter: {
					exists: async (path: string) => path in files,
					read: async (path: string) => files[path],
				},
			},
		} as never
		return new MemoryRepository(app, () => ({
			enabled,
			path: '.agents/nutstore-sync/偏好/记忆 🧠.md',
		}))
	}

	it('discloses the note once and again only after it changes', async () => {
		const files = {
			'.agents/nutstore-sync/偏好/记忆 🧠.md':
				'- Prefers metric units 偏好公制单位 📏\n',
		}
		const memory = createMemory(files)
		await memory.refresh()
		const first = captureWorkspaceContexts(createApp(), { memory })
		const disclosure = {
			path: '.agents/nutstore-sync/偏好/记忆 🧠.md',
			content: '- Prefers metric units 偏好公制单位 📏',
		}
		expect(first.find((entry) => entry.key === 'memory')).toEqual({
			key: 'memory',
			content: disclosure,
			hash: hashObject(disclosure),
		})
		const history = [asPreviousMessage(first)]
		expect(computeChangedContexts(history, first)).toEqual([])

		files['.agents/nutstore-sync/偏好/记忆 🧠.md'] +=
			'- Weekly review on Fridays 每周五复盘 🗓️\n'
		await memory.refresh()
		expect(
			computeChangedContexts(
				history,
				captureWorkspaceContexts(createApp(), { memory }),
			),
		).toEqual([expect.objectContaining({ key: 'memory' })])
	})

	it('discloses an emptied note so forgotten memory leaves the context', async () => {
		const files: Record<string, string> = {
			'.agents/nutstore-sync/偏好/记忆 🧠.md': '- Old preference 旧偏好 📦\n',
		}
		const memory = createMemory(files)
		await memory.refresh()
		const history = [
			asPreviousMessage(captureWorkspaceContexts(createApp(), { memory })),
		]

		delete files['.agents/nutstore-sync/偏好/记忆 🧠.md']
		await memory.refresh()
		expect(
			computeChangedContexts(
				history,
				captureWorkspaceContexts(createApp(), { memory }),
			),
		).toEqual([
			expect.objectContaining({
				key: 'memory',
				content: { path: '.agents/nutstore-sync/偏好/记忆 🧠.md', content: '' },
			}),
		])
	})

	it('omits memory while it is disabled and ignores keys absent from the capture', async () => {
		const memory = createMemory(
			{ '.agents/nutstore-sync/偏好/记忆 🧠.md': '- Hidden 隐藏 🙈\n' },
			false,
		)
		await memory.refresh()
		const current = captureWorkspaceContexts(createApp(), { memory })
		expect(current.some((entry) => entry.key === 'memory')).toBe(false)
		const history = [
			asPreviousMessage([
				{ key: 'memory', content: 'Old 旧 📦', hash: hashObject('Old 旧 📦') },
				...current,
			]),
		]
		expect(computeChangedContexts(history, current)).toEqual([])
	})
})
