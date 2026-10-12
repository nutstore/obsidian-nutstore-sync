import type { App, WorkspaceLeaf } from 'obsidian'
import { hash as hashObject } from 'ohash'

import type { AppUIMessage, WorkspaceContextDelta } from '~/ai/chat/types'
import {
	getWorkspaceContextDeltas,
	selectContextTimeline,
} from '~/ai/chat/messages/ui-message'
import type { MemoryRepository } from '~/ai/memory/repository'
import {
	countMemoryCharacters,
	MEMORY_NOTE_CHARACTER_LIMIT,
} from '~/ai/memory/memory-note'
import type { SkillRepository } from '~/ai/skills/repository'
import { formatLocalDate } from '~/utils/local-date'

type View = WorkspaceLeaf['view'] & {
	file?: {
		path: string
	}
	containerEl?: HTMLElement
}

interface CurrentDateContext {
	date: string
	weekday: string
	timezone?: string
}

const ENGLISH_WEEKDAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
] as const

export interface WorkspaceContextOptions {
	/** Clock override for deterministic date-context tests. */
	now?: () => Date
}

function getEnglishWeekday(date: Date) {
	try {
		if (
			typeof Intl !== 'undefined' &&
			typeof Intl.DateTimeFormat === 'function'
		) {
			return new Intl.DateTimeFormat('en-US', {
				weekday: 'long',
			}).format(date)
		}
	} catch {
		// Fall back for old or partial WebView Intl implementations.
	}
	return ENGLISH_WEEKDAYS[date.getDay()] ?? 'Sunday'
}

function getLocalTimezone() {
	try {
		if (
			typeof Intl !== 'undefined' &&
			typeof Intl.DateTimeFormat === 'function'
		) {
			const timezone = Intl.DateTimeFormat().resolvedOptions?.().timeZone
			return typeof timezone === 'string' && timezone ? timezone : undefined
		}
	} catch {
		// Timezone metadata is optional and must not block context injection.
	}
	return undefined
}

function captureCurrentDateContext(date: Date): CurrentDateContext {
	const timezone = getLocalTimezone()
	return {
		date: formatLocalDate(date),
		weekday: getEnglishWeekday(date),
		...(timezone ? { timezone } : {}),
	}
}

function getConnectedFilePath(leaf: WorkspaceLeaf): string | null {
	const view = leaf.view as unknown as View
	if (
		!view?.file?.path ||
		!(
			view.getViewType() in
			['markdown', 'canvas', 'pdf', 'image', 'video', 'audio', 'bases']
		) ||
		!view.containerEl?.isConnected
	) {
		return null
	}
	return view.file.path
}

export interface WorkspaceContextSources {
	skills?: Pick<SkillRepository, 'refresh' | 'getCatalog'>
	/** One content-addressed addition per distinct line; no note snapshots or deletions. */
	memory?: Pick<MemoryRepository, 'refresh' | 'getEntries'>
}

export async function refreshWorkspaceContextSources(
	sources: WorkspaceContextSources,
) {
	await Promise.all([sources.skills?.refresh(), sources.memory?.refresh()])
}

export function captureWorkspaceContexts(
	app: App,
	sources: WorkspaceContextSources = {},
	options: WorkspaceContextOptions = {},
): WorkspaceContextDelta[] {
	const activeFile = app.workspace.getActiveFile()?.path ?? null
	const currentDate = captureCurrentDateContext(options.now?.() ?? new Date())

	const openFilePaths = new Set<string>()
	app.workspace.iterateAllLeaves((leaf) => {
		const filePath = getConnectedFilePath(leaf)
		if (filePath) {
			openFilePaths.add(filePath)
		}
	})
	const openFiles = Array.from(openFilePaths).sort()
	const contexts: WorkspaceContextDelta[] = [
		{
			key: 'currentDate',
			content: currentDate,
			hash: hashObject(currentDate),
		},
		{ key: 'activeFile', content: activeFile, hash: hashObject(activeFile) },
		{ key: 'openFiles', content: openFiles, hash: hashObject(openFiles) },
	]
	if (sources.skills) {
		const skills = sources.skills.getCatalog()
		contexts.push({ key: 'skills', content: skills, hash: hashObject(skills) })
	}
	const entries = sources.memory?.getEntries() ?? []
	for (const entry of new Map(
		entries.map((entry) => [entry.id, entry]),
	).values()) {
		contexts.push({ key: `memory:${entry.id}`, content: entry, hash: entry.id })
	}
	return contexts
}

export function computeChangedContexts(
	prevMessages: AppUIMessage[],
	current: WorkspaceContextDelta[],
): WorkspaceContextDelta[] {
	const lastHashByKey = new Map<string, string>()
	const currentKeys = new Set(current.map((entry) => entry.key))
	// Only records still visible to the model can suppress new disclosures.
	// Recalled/regenerated messages and discarded compaction history are not state.
	const visibleMessages = selectContextTimeline(prevMessages)
	for (let i = visibleMessages.length - 1; i >= 0; i--) {
		const ctx = getWorkspaceContextDeltas(visibleMessages[i])
		if (!ctx.length) continue
		for (const entry of ctx) {
			if (currentKeys.has(entry.key) && !lastHashByKey.has(entry.key)) {
				lastHashByKey.set(entry.key, entry.hash)
			}
		}
		if (lastHashByKey.size === currentKeys.size) break
	}
	let memoryCharacters = 0
	return current.filter((entry) => {
		if (lastHashByKey.get(entry.key) === entry.hash) return false
		if (!entry.key.startsWith('memory:')) return true
		// Bound complete additions after deduplication, including JSON/ID overhead.
		// Omitted lines remain unseen and can be disclosed by a later message.
		const size = countMemoryCharacters(
			JSON.stringify({ [entry.key]: entry.content }),
		)
		if (memoryCharacters + size > MEMORY_NOTE_CHARACTER_LIMIT) return false
		memoryCharacters += size
		return true
	})
}
