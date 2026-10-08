/**
 * Memory is a single plugin-owned Markdown file. It is the only source of truth:
 * the agent reads its full content from workspace context and changes it only
 * through `editMemoryNote`; the user can inspect it through the plugin.
 *
 * An entry is a top-level list item (`- `, `* ` or `+ ` at column 0). Every
 * other line — headings, prose, nested items — belongs to the user and is
 * preserved verbatim, so hand-written structure survives agent edits.
 */

export const DEFAULT_MEMORY_NOTE_PATH = '.agents/nutstore-sync/MEMORY.md'

export interface MemorySettings {
	/** Gives the agent the memory note in context and the memory tool. */
	enabled: boolean
	/** Vault-relative path of the memory note; see normalizeMemoryNotePath. */
	path: string
}

/** Bounds both what one agent edit may grow to and what is disclosed per turn. */
export const MEMORY_NOTE_CHARACTER_LIMIT = 8000
export const MEMORY_ENTRY_CHARACTER_LIMIT = 300

const ENTRY_LINE = /^[-*+][ \t]+(.*)$/

export interface MemoryEdit {
	/** New entries; each becomes one top-level list item. */
	remember: readonly string[]
	/** Existing entries to remove, quoted exactly as they appear in the note. */
	forget: readonly string[]
}

export interface MemoryEditResult {
	content: string
	remembered: string[]
	forgotten: string[]
	/** Requested entries that were already remembered. */
	unchanged: string[]
	entryCount: number
	characterCount: number
}

export class MemoryEditError extends Error {
	override name = 'MemoryEditError'
}

/** Counts user-perceived code points, so CJK and emoji are not over-counted. */
export function countMemoryCharacters(text: string) {
	return Array.from(text).length
}

/** One plain line: entries are compared and stored in this form. */
export function normalizeMemoryEntry(text: string) {
	return text.replace(/\s+/g, ' ').trim()
}

function entryText(line: string) {
	const match = ENTRY_LINE.exec(line)
	return match ? normalizeMemoryEntry(match[1]) : undefined
}

function entriesOf(lines: readonly string[]) {
	return lines.flatMap((line) => {
		const text = entryText(line)
		return text ? [text] : []
	})
}

export function listMemoryEntries(content: string) {
	return entriesOf(splitLines(content).lines)
}

function splitLines(content: string) {
	const newline = content.includes('\r\n') ? '\r\n' : '\n'
	const normalized = content.replace(/\r\n/g, '\n')
	const lines = normalized === '' ? [] : normalized.split('\n')
	if (lines.at(-1) === '') lines.pop()
	return { lines, newline }
}

/**
 * Applies forgetting before remembering, so a correction is one atomic edit
 * that forgets the stale entry and remembers its replacement. Nothing changes
 * unless the whole edit is valid.
 */
export function editMemoryNote(
	content: string,
	edit: MemoryEdit,
): MemoryEditResult {
	const forget = [...new Set(edit.forget.map(normalizeMemoryEntry))].filter(
		Boolean,
	)
	const remember = [...new Set(edit.remember.map(normalizeMemoryEntry))].filter(
		Boolean,
	)
	if (!forget.length && !remember.length) {
		throw new MemoryEditError(
			'Provide at least one non-empty entry to remember or forget.',
		)
	}
	const tooLong = remember.find(
		(entry) => countMemoryCharacters(entry) > MEMORY_ENTRY_CHARACTER_LIMIT,
	)
	if (tooLong) {
		throw new MemoryEditError(
			`Each memory entry must be at most ${MEMORY_ENTRY_CHARACTER_LIMIT} characters; split or shorten: "${tooLong}"`,
		)
	}

	const { lines, newline } = splitLines(content)
	const existing = new Set(entriesOf(lines))
	const missing = forget.filter((entry) => !existing.has(entry))
	if (missing.length) {
		throw new MemoryEditError(
			`Not in memory, nothing was changed. Quote entries exactly as they appear in the memory note: ${missing.map((entry) => `"${entry}"`).join(', ')}`,
		)
	}

	const forgetting = new Set(forget)
	const kept = lines.filter((line) => {
		const text = entryText(line)
		return !text || !forgetting.has(text)
	})
	const keptEntries = new Set(entriesOf(kept))
	const remembered = remember.filter((entry) => !keptEntries.has(entry))
	const unchanged = remember.filter((entry) => keptEntries.has(entry))

	// New entries follow the last entry so they stay inside the user's list.
	let insertAt = kept.length
	for (let index = kept.length - 1; index >= 0; index--) {
		if (entryText(kept[index])) {
			insertAt = index + 1
			while (insertAt < kept.length && /^[ \t]+\S/.test(kept[insertAt])) {
				insertAt++
			}
			break
		}
	}
	const next = [
		...kept.slice(0, insertAt),
		...remembered.map((entry) => `- ${entry}`),
		...kept.slice(insertAt),
	]
	const nextContent = next.length ? `${next.join(newline)}${newline}` : ''
	const characterCount = countMemoryCharacters(nextContent)
	if (
		characterCount > MEMORY_NOTE_CHARACTER_LIMIT &&
		characterCount > countMemoryCharacters(content)
	) {
		throw new MemoryEditError(
			`Memory is full (${characterCount}/${MEMORY_NOTE_CHARACTER_LIMIT} characters after this edit). Forget outdated entries or merge related ones in the same edit, then retry.`,
		)
	}
	return {
		content: nextContent,
		remembered,
		forgotten: forget,
		unchanged,
		entryCount: listMemoryEntries(nextContent).length,
		characterCount,
	}
}

/**
 * One plain line naming exactly what an edit remembers and forgets, so the
 * chat tool card shows every memory change at a glance.
 */
export function describeMemoryEdit(
	edit: Partial<MemoryEdit>,
	label: (action: keyof MemoryEdit) => string,
) {
	return (['remember', 'forget'] as const)
		.flatMap((action) => {
			const entries = (edit[action] ?? [])
				.map(normalizeMemoryEntry)
				.filter(Boolean)
			return entries.length ? [`${label(action)}: ${entries.join('; ')}`] : []
		})
		.join(' · ')
}

export interface MemoryDisclosure {
	path: string
	content: string
	/** The note exceeds the limit, so only its beginning is disclosed. */
	truncated?: true
}

/** The bounded view of the note that the agent sees in workspace context. */
export function discloseMemoryNote(
	path: string,
	content: string,
): MemoryDisclosure {
	const trimmed = content.trim()
	const characters = Array.from(trimmed)
	if (characters.length <= MEMORY_NOTE_CHARACTER_LIMIT) {
		return { path, content: trimmed }
	}
	return {
		path,
		content: characters.slice(0, MEMORY_NOTE_CHARACTER_LIMIT).join(''),
		truncated: true,
	}
}

/**
 * Memory files stay inside the plugin-owned .agents/nutstore-sync directory. Returns the
 * canonical vault-relative path, or undefined when the input is not one.
 */
export function normalizeMemoryNotePath(input: string) {
	const path = input
		.normalize('NFC')
		.replace(/\u00a0|\u202f/g, ' ')
		.trim()
		.replace(/[\\/]+/g, '/')
		.replace(/^\/+|\/+$/g, '')
	const segments = path.split('/')
	const valid =
		path.startsWith('.agents/nutstore-sync/') &&
		/\.md$/i.test(path) &&
		segments.every(
			(segment, index) =>
				segment.trim() !== '' &&
				(!segment.startsWith('.') ||
					(index === 0 &&
						segment === '.agents' &&
						segments[1] === 'nutstore-sync')),
		) &&
		segments.at(-1)!.length > '.md'.length
	return valid ? path : undefined
}
