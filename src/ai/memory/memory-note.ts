import { sha256 } from 'ohash'

/**
 * The Markdown file is the only source of truth. Every nonblank physical line
 * is one memory, including headings, prose and indented/list lines. References
 * exist only in agent context: a short digest of the exact line text. They
 * remain stable when other lines change or the note is reordered. Identical
 * lines share a reference and forgetting it removes every copy; a reference
 * matching different text in the current file is ambiguous and cannot be used.
 */
export const DEFAULT_MEMORY_NOTE_PATH = '.agents/nutstore-sync/MEMORY.md'

export interface MemorySettings {
	/** Gives the agent the memory note in context and the memory tool. */
	enabled: boolean
	/** Vault-relative path of the memory note; see normalizeMemoryNotePath. */
	path: string
}

/** Bounds file growth and the annotated view disclosed to the agent. */
export const MEMORY_NOTE_CHARACTER_LIMIT = 8000
export const MEMORY_ENTRY_CHARACTER_LIMIT = 300

export interface MemoryEntry {
	/** Content reference, never stored in the file or dependent on line position. */
	id: string
	/** Exact line text, without its line ending; whitespace is significant. */
	text: string
}

export interface MemoryEdit {
	/** New single-line text, appended verbatim without Markdown decoration. */
	remember: readonly string[]
	/** Content IDs; forgetting one removes all lines with that exact text. */
	forget: readonly string[]
}

export interface MemoryEditResult {
	content: string
	remembered: string[]
	/** Exact text of the removed lines, for human-readable feedback and undo UI. */
	forgotten: string[]
	/** Requested lines already present verbatim after forgetting. */
	unchanged: string[]
	entryCount: number
	characterCount: number
}

export class MemoryEditError extends Error {
	override name = 'MemoryEditError'
}

/** Counts Unicode code points, not UTF-16 units or grapheme clusters. */
export function countMemoryCharacters(text: string) {
	return Array.from(text).length
}

interface PhysicalLine {
	text: string
	ending: string
}

/** Preserve untouched text, including mixed line endings and EOF. */
function splitLines(content: string): PhysicalLine[] {
	return Array.from(content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g))
		.filter((match) => match[0] !== '')
		.map((match) => ({ text: match[1], ending: match[2] }))
}

function entryOf(line: PhysicalLine): MemoryEntry | undefined {
	// Reuse the bundled pure-JS SHA-256: 48 bits keep references short without
	// adding dependencies, async hashing, or a second source of memory state.
	return line.text.trim()
		? { id: sha256(line.text).slice(0, 12), text: line.text }
		: undefined
}

export function listMemoryEntries(content: string): MemoryEntry[] {
	return splitLines(content).flatMap((line) => {
		const entry = entryOf(line)
		return entry ? [entry] : []
	})
}

export interface MemoryDisclosure {
	path: string
	/** One [id] text record per nonblank physical line; IDs are not file content. */
	content: string
	/** Some whole lines were omitted to bound context, including ID overhead. */
	truncated?: true
}

/** Preserve exact line text and never disclose a fragment as a complete memory. */
export function discloseMemoryNote(
	path: string,
	content: string,
): MemoryDisclosure {
	const records: string[] = []
	let characterCount = 0
	let truncated = false
	for (const entry of listMemoryEntries(content)) {
		const record = `[${entry.id}] ${entry.text}`
		const size = countMemoryCharacters(record) + (records.length ? 1 : 0)
		if (characterCount + size > MEMORY_NOTE_CHARACTER_LIMIT) {
			truncated = true
			break
		}
		records.push(record)
		characterCount += size
	}
	return {
		path,
		content: records.join('\n'),
		...(truncated ? { truncated: true as const } : {}),
	}
}

/**
 * Validate every reference against the same freshly read file before deleting
 * any lines. Position is irrelevant; a reference must resolve to exactly one
 * distinct text, and all its copies are removed. Corrections forget and
 * remember in one atomic edit; unchanged file text remains exact.
 */
export function editMemoryNote(
	content: string,
	edit: MemoryEdit,
): MemoryEditResult {
	const forget = [...new Set(edit.forget)]
	const remember = [...new Set(edit.remember)]
	if (!forget.length && !remember.length) {
		throw new MemoryEditError(
			'Provide at least one line to remember or ID to forget.',
		)
	}
	for (const text of remember) {
		if (!text.trim() || /[\r\n\u2028\u2029]/.test(text)) {
			throw new MemoryEditError(
				'Each remembered entry must be one nonblank line without line breaks.',
			)
		}
		if (countMemoryCharacters(text) > MEMORY_ENTRY_CHARACTER_LIMIT) {
			throw new MemoryEditError(
				`Each memory entry must be at most ${MEMORY_ENTRY_CHARACTER_LIMIT} characters; split or shorten: "${text}"`,
			)
		}
	}

	const lines = splitLines(content)
	const entries = listMemoryEntries(content)
	const existing = new Map<string, Set<string>>()
	for (const entry of entries) {
		const texts = existing.get(entry.id) ?? new Set<string>()
		texts.add(entry.text)
		existing.set(entry.id, texts)
	}
	const invalid = forget.filter((id) => existing.get(id)?.size !== 1)
	if (invalid.length) {
		const latest = discloseMemoryNote('', content)
		throw new MemoryEditError(
			[
				`Unknown, stale or ambiguous memory IDs, nothing was changed: ${invalid.join(', ')}. Each ID must identify one distinct line text. Copy unambiguous IDs from the latest memory below and retry; never guess IDs or edit the file with another tool.`,
				latest.content || '(No memory lines disclosed.)',
				...(latest.truncated
					? ['Memory context is truncated; additional lines are not shown.']
					: []),
			].join('\n'),
		)
	}

	const forgetting = new Set(forget)
	const kept = lines.filter((line) => {
		const entry = entryOf(line)
		return !entry || !forgetting.has(entry.id)
	})
	const keptTexts = new Set(kept.map((line) => line.text))
	const remembered = remember.filter((text) => !keptTexts.has(text))
	const unchanged = remember.filter((text) => keptTexts.has(text))
	let nextContent = kept.map((line) => line.text + line.ending).join('')
	if (remembered.length) {
		const newline = lines.find((line) => line.ending)?.ending ?? '\n'
		if (nextContent && !/[\r\n]$/.test(nextContent)) nextContent += newline
		nextContent += remembered.map((text) => text + newline).join('')
	}
	const characterCount = countMemoryCharacters(nextContent)
	if (
		characterCount > MEMORY_NOTE_CHARACTER_LIMIT &&
		characterCount > countMemoryCharacters(content)
	) {
		throw new MemoryEditError(
			`Memory is full (${characterCount}/${MEMORY_NOTE_CHARACTER_LIMIT} characters after this edit). Forget outdated lines or merge related ones in the same edit, then retry.`,
		)
	}
	return {
		content: nextContent,
		remembered,
		forgotten: forget.map((id) => [...existing.get(id)!][0]),
		unchanged,
		entryCount: listMemoryEntries(nextContent).length,
		characterCount,
	}
}

/** Input references while running; resolved deleted text after a successful edit. */
export function describeMemoryEdit(
	edit: Partial<MemoryEdit>,
	label: (action: keyof MemoryEdit) => string,
) {
	return (['remember', 'forget'] as const)
		.flatMap((action) => {
			const entries = (edit[action] ?? []).filter((text) => text.trim())
			return entries.length ? [`${label(action)}: ${entries.join('; ')}`] : []
		})
		.join(' · ')
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
