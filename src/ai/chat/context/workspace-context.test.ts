import { describe, expect, it, vi } from 'vitest'
import { hash as hashObject } from 'ohash'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import { MemoryRepository } from '~/ai/memory/repository'
import {
	listMemoryEntries,
	MEMORY_NOTE_CHARACTER_LIMIT,
	countMemoryCharacters,
} from '~/ai/memory/memory-note'
import { uiMessagesToModelMessages } from '~/ai/chat/messages/ui-message'
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

describe('workspace memory additions', () => {
	const path = '.agents/nutstore-sync/偏好/记忆 🧠.md'
	const firstText = 'Prefers metric units 偏好公制单位 📏'
	const secondText = 'Weekly review 每周复盘 🗓️'

	function setup(content = firstText, enabled = true) {
		const files: Record<string, string> = { [path]: content }
		const settings = { enabled, path }
		const memory = new MemoryRepository(
			{
				vault: {
					adapter: {
						exists: async (path: string) => path in files,
						read: async (path: string) => files[path],
					},
				},
			} as never,
			() => settings,
		)
		return {
			files,
			settings,
			memory,
			capture: () => captureWorkspaceContexts(createApp(), { memory }),
		}
	}

	function memoryDelta(text: string): WorkspaceContextDelta {
		const entry = listMemoryEntries(text)[0]
		return { key: `memory:${entry.id}`, content: entry, hash: entry.id }
	}

	it('injects one structured addition per distinct nonblank line without a note snapshot', async () => {
		const { memory, capture } = setup(
			`\n${firstText}\n${secondText}\n${firstText}\n`,
		)
		await memory.refresh()
		const current = capture()
		expect(current.filter((entry) => entry.key.startsWith('memory:'))).toEqual([
			memoryDelta(firstText),
			memoryDelta(secondText),
		])
		expect(current.some((entry) => entry.key === 'memory')).toBe(false)
		expect(computeChangedContexts([], current)).toEqual(current)
	})

	it('injects only new lines while deduplicating additions across multiple prior messages', async () => {
		const { files, memory, capture } = setup()
		await memory.refresh()
		const first = capture()
		const history = [asPreviousMessage(first)]
		expect(computeChangedContexts(history, first)).toEqual([])
		files[path] += `\n${secondText}`
		await memory.refresh()
		const second = computeChangedContexts(history, capture())
		expect(second).toEqual([memoryDelta(secondText)])
		history.push({ ...asPreviousMessage(second), id: 'second-addition' })
		expect(computeChangedContexts(history, capture())).toEqual([])
		files[path] += '\nDrafts in inbox 草稿收件箱 📥'
		await memory.refresh()
		expect(computeChangedContexts(history, capture())).toEqual([
			memoryDelta('Drafts in inbox 草稿收件箱 📥'),
		])
	})

	it('sends only replacement content when a line is edited and no removal record', async () => {
		const { files, memory, capture } = setup(`${firstText}\n${secondText}`)
		await memory.refresh()
		const history = [asPreviousMessage(capture())]
		const replacement = 'Monthly review 每月复盘 🗓️'
		files[path] = `${replacement}\n${firstText}`
		await memory.refresh()
		expect(computeChangedContexts(history, capture())).toEqual([
			memoryDelta(replacement),
		])
	})

	it('sends no update for reordering, duplicate lines, removals or an emptied file', async () => {
		const { files, memory, capture } = setup(`${firstText}\n${secondText}`)
		await memory.refresh()
		const history = [asPreviousMessage(capture())]
		for (const content of [
			`${secondText}\n\n${firstText}\n${firstText}`,
			firstText,
			'',
			`\n${firstText}`,
		]) {
			files[path] = content
			await memory.refresh()
			expect(computeChangedContexts(history, capture())).toEqual([])
		}
		delete files[path]
		await memory.refresh()
		expect(computeChangedContexts(history, capture())).toEqual([])
	})

	it('omits disabled memory without clearing previous additions', async () => {
		const { memory, settings, capture } = setup()
		await memory.refresh()
		const history = [asPreviousMessage(capture())]
		settings.enabled = false
		await memory.refresh()
		expect(capture().some((entry) => entry.key.startsWith('memory:'))).toBe(
			false,
		)
		expect(computeChangedContexts(history, capture())).toEqual([])
		settings.enabled = true
		await memory.refresh()
		expect(computeChangedContexts(history, capture())).toEqual([])
	})

	it('rediscloses current lines after reset instead of deduplicating against discarded history', async () => {
		const { memory, capture } = setup()
		await memory.refresh()
		const current = capture()
		const checkpoint: AppUIMessage = {
			id: 'reset',
			role: 'user',
			parts: [{ type: 'data-context-checkpoint', data: { mode: 'reset' } }],
		}
		expect(
			computeChangedContexts([asPreviousMessage(current), checkpoint], current),
		).toEqual(current)
	})

	it('deduplicates against retained additions after summary while redisclosing omitted current lines', async () => {
		const { memory, capture } = setup(`${firstText}\n${secondText}`)
		await memory.refresh()
		const current = capture()
		const old = {
			...asPreviousMessage(
				current.filter((entry) => entry.key !== memoryDelta(secondText).key),
			),
			id: 'summarized-addition',
		}
		const retained = {
			...asPreviousMessage([memoryDelta(secondText)]),
			id: 'retained-addition',
		}
		const checkpoint: AppUIMessage = {
			id: 'summary',
			role: 'user',
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode: 'summary',
						summary: 'Review continues 继续复盘 🗓️',
						summarizedThroughMessageId: old.id,
						retainedMessageIds: [retained.id],
					},
				},
			],
		}
		expect(
			computeChangedContexts([old, retained, checkpoint], current),
		).toEqual(
			current.filter((entry) => entry.key !== memoryDelta(secondText).key),
		)
	})

	it('can inject new lines beyond the previous note prefix because budgeting follows deduplication', async () => {
		const prefix = Array.from(
			{ length: 80 },
			(_, index) => `Review topic 复盘主题 🗓️ ${index} ${'📚'.repeat(100)}`,
		).join('\n')
		const { files, memory, capture } = setup(prefix)
		await memory.refresh()
		const history = [asPreviousMessage(capture())]
		files[path] += `\n${secondText}`
		await memory.refresh()
		expect(computeChangedContexts(history, capture())).toEqual([
			memoryDelta(secondText),
		])
	})

	it('bounds complete additions and delivers deferred lines on subsequent messages', async () => {
		const note = Array.from(
			{ length: 80 },
			(_, index) => `Review topic 复盘主题 🗓️ ${index} ${'📚'.repeat(100)}`,
		).join('\n')
		const { memory, capture } = setup(note)
		await memory.refresh()
		const current = capture()
		const history: AppUIMessage[] = []
		const disclosed = new Set<string>()
		for (let batch = 0; batch < 10; batch++) {
			const additions = computeChangedContexts(history, current)
			const memories = additions.filter((entry) =>
				entry.key.startsWith('memory:'),
			)
			const payload = Object.fromEntries(
				memories.map((entry) => [entry.key, entry.content]),
			)
			expect(
				countMemoryCharacters(JSON.stringify(payload)),
			).toBeLessThanOrEqual(MEMORY_NOTE_CHARACTER_LIMIT)
			for (const entry of memories) {
				expect(disclosed.has(entry.key)).toBe(false)
				disclosed.add(entry.key)
			}
			history.push({
				...asPreviousMessage(additions),
				id: `addition-batch-${batch}`,
			})
			if (!memories.length) break
		}
		expect(disclosed.size).toBe(listMemoryEntries(note).length)
		expect(computeChangedContexts(history, current)).toEqual([])
	})

	it('preserves independent memory records in the model-facing AdditionalContext', async () => {
		const { memory, capture } = setup(`${firstText}\n${secondText}`)
		await memory.refresh()
		const additions = capture().filter((entry) =>
			entry.key.startsWith('memory:'),
		)
		const modelMessages = await uiMessagesToModelMessages([
			asPreviousMessage(additions),
		])
		expect(modelMessages).toEqual([
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: `<AdditionalContext>${JSON.stringify(Object.fromEntries(additions.map((entry) => [entry.key, entry.content])))}</AdditionalContext>`,
					},
				],
			},
		])
	})
})
