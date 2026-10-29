import { diff_match_patch } from 'diff-match-patch'
import { isEqual } from 'es-toolkit/compat'
import { diffComm, mergeDiff3 as nodeMergeDiff3 } from 'node-diff3'
import { BufferLike } from 'webdav'
import * as Y from 'yjs'

// --- Logic for Latest Timestamp Resolution ---

export enum LatestTimestampResolution {
	NoChange,
	UseRemote,
	UseLocal,
}

export interface LatestTimestampParams {
	localMtime: number
	remoteMtime: number
	localContent: BufferLike
	remoteContent: BufferLike
}

export type LatestTimestampResult =
	| { status: LatestTimestampResolution.NoChange }
	| { status: LatestTimestampResolution.UseRemote; content: BufferLike }
	| { status: LatestTimestampResolution.UseLocal; content: BufferLike }

export function resolveByLatestTimestamp(
	params: LatestTimestampParams,
): LatestTimestampResult {
	const { localMtime, remoteMtime, localContent, remoteContent } = params

	if (remoteMtime === localMtime) {
		return { status: LatestTimestampResolution.NoChange }
	}

	const useRemote = remoteMtime > localMtime

	if (useRemote) {
		// Only return UseRemote if content is actually different
		if (!isEqual(localContent, remoteContent)) {
			return {
				status: LatestTimestampResolution.UseRemote,
				content: remoteContent,
			}
		}
		return { status: LatestTimestampResolution.NoChange }
	} else {
		// Local is newer (or same age but remote wasn't newer)
		// Only return UseLocal if content is actually different
		if (!isEqual(localContent, remoteContent)) {
			return {
				status: LatestTimestampResolution.UseLocal,
				content: localContent,
			}
		}
		return { status: LatestTimestampResolution.NoChange }
	}
}

// --- Logic for Intelligent Merge Resolution ---

export interface IntelligentMergeParams {
	localContentText: string
	remoteContentText: string
	baseContentText: string
	filePath?: string
	hasBase?: boolean
}

export interface IntelligentMergeResult {
	success: boolean
	mergedText?: string
	error?: string // Generic error message
	isIdentical?: boolean // Flag if contents were already identical
}

export interface Diff3MergeParams {
	localContentText: string
	remoteContentText: string
	baseContentText: string
}

export function resolveByDiff3Merge({
	localContentText,
	remoteContentText,
	baseContentText,
}: Diff3MergeParams): IntelligentMergeResult {
	if (localContentText === remoteContentText) {
		return { success: true, isIdentical: true }
	}

	const { result } = nodeMergeDiff3(
		localContentText,
		baseContentText,
		remoteContentText,
		{
			excludeFalseConflicts: true,
			stringSeparator: '\n',
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		},
	)

	return { success: true, mergedText: result.join('\n') }
}

const MISSING_JSON_VALUE = Symbol('missing-json-value')

type MissingJsonValue = typeof MISSING_JSON_VALUE
type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isPlainJsonObject(
	value: JsonValue | MissingJsonValue,
): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonValuesEqual(
	left: JsonValue | MissingJsonValue,
	right: JsonValue | MissingJsonValue,
): boolean {
	if (left === MISSING_JSON_VALUE || right === MISSING_JSON_VALUE) {
		return left === right
	}
	return isEqual(left, right)
}

function mergeJsonValue(
	base: JsonValue | MissingJsonValue,
	local: JsonValue | MissingJsonValue,
	remote: JsonValue | MissingJsonValue,
): JsonValue | MissingJsonValue {
	if (jsonValuesEqual(local, remote)) {
		return local
	}
	if (jsonValuesEqual(local, base)) {
		return remote
	}
	if (jsonValuesEqual(remote, base)) {
		return local
	}

	if (
		isPlainJsonObject(local) &&
		isPlainJsonObject(remote) &&
		(isPlainJsonObject(base) || base === MISSING_JSON_VALUE)
	) {
		const baseObject = base === MISSING_JSON_VALUE ? ({} as const) : base
		const keys = new Set([
			...Object.keys(local),
			...Object.keys(remote),
			...Object.keys(baseObject),
		])
		const merged = Object.create(null) as { [key: string]: JsonValue }

		for (const key of keys) {
			const mergedValue = mergeJsonValue(
				Object.hasOwn(baseObject, key) ? baseObject[key] : MISSING_JSON_VALUE,
				Object.hasOwn(local, key) ? local[key] : MISSING_JSON_VALUE,
				Object.hasOwn(remote, key) ? remote[key] : MISSING_JSON_VALUE,
			)
			if (mergedValue !== MISSING_JSON_VALUE) {
				merged[key] = mergedValue
			}
		}

		return merged
	}

	// Concurrent changes use the existing local-priority product rule.
	return local
}

function detectJsonIndent(text: string): string | number | undefined {
	if (!text.includes('\n')) {
		return undefined
	}
	const match = text.match(/\n([\t ]+)\S/)
	if (!match) {
		return 2
	}
	return match[1].startsWith('\t') ? '\t' : match[1].length
}

function mergeJsonStrings(
	baseText: string,
	localText: string,
	remoteText: string,
	hasBase: boolean,
): string | undefined {
	try {
		const local = JSON.parse(localText) as JsonValue
		const remote = JSON.parse(remoteText) as JsonValue
		const base = hasBase
			? (JSON.parse(baseText) as JsonValue)
			: MISSING_JSON_VALUE
		const merged = mergeJsonValue(base, local, remote)

		if (merged === MISSING_JSON_VALUE) {
			return undefined
		}

		const trailingNewline = localText.endsWith('\n') ? '\n' : ''
		return (
			JSON.stringify(merged, null, detectJsonIndent(localText)) +
			trailingNewline
		)
	} catch {
		return undefined
	}
}

type TextDiff = ReturnType<
	InstanceType<typeof diff_match_patch>['diff_main']
>[number]

/** DMP can leave half a surrogate pair in an equality. Expand those boundaries
 * into both edits before Y.Text sees them: splitting an item inside a pair
 * replaces its halves with U+FFFD, even for otherwise independent edits.
 * Offsets remain UTF-16; only edit boundaries move to whole code points.
 */
function diffText(base: string, next: string): TextDiff[] {
	const diffs = new diff_match_patch().diff_main(base, next)
	const result: TextDiff[] = []
	let deleted = ''
	let inserted = ''
	const flush = () => {
		if (deleted) result.push([diff_match_patch.DIFF_DELETE, deleted])
		if (inserted) result.push([diff_match_patch.DIFF_INSERT, inserted])
		deleted = ''
		inserted = ''
	}
	for (const [operation, value] of diffs) {
		if (operation === diff_match_patch.DIFF_DELETE) {
			deleted += value
		} else if (operation === diff_match_patch.DIFF_INSERT) {
			inserted += value
		} else {
			const first = value.charCodeAt(0)
			const last = value.charCodeAt(value.length - 1)
			const start = first >= 0xdc00 && first <= 0xdfff ? 1 : 0
			const end =
				last >= 0xd800 && last <= 0xdbff ? value.length - 1 : value.length
			deleted += value.slice(0, start)
			inserted += value.slice(0, start)
			if (end > start) {
				flush()
				result.push([diff_match_patch.DIFF_EQUAL, value.slice(start, end)])
			}
			deleted += value.slice(end)
			inserted += value.slice(end)
		}
	}
	flush()
	return result
}

const decimalNumber = /[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/g

/** Project base number boundaries through branch edits. Boundaries inside a
 * larger replacement are ambiguous and deliberately have no projection.
 */
function projectNumbers(
	text: string,
	diffs: readonly TextDiff[],
	numbers: readonly RegExpExecArray[],
) {
	const edits: { start: number; end: number; inserted: string }[] = []
	let offset = 0
	let pending: (typeof edits)[number] | undefined
	for (const [operation, value] of diffs) {
		if (operation === diff_match_patch.DIFF_EQUAL) {
			if (pending) edits.push(pending)
			pending = undefined
			offset += value.length
		} else {
			pending ??= { start: offset, end: offset, inserted: '' }
			if (operation === diff_match_patch.DIFF_DELETE) {
				offset += value.length
				pending.end = offset
			} else {
				pending.inserted += value
			}
		}
	}
	if (pending) edits.push(pending)
	let editIndex = 0
	let delta = 0
	const project = (position: number, includeInsertion: boolean) => {
		while (editIndex < edits.length && edits[editIndex].end < position) {
			const edit = edits[editIndex++]
			delta += edit.inserted.length - (edit.end - edit.start)
		}
		const edit = edits[editIndex]
		if (!edit || edit.start > position) return position + delta
		if (edit.start === position) {
			return (
				position +
				delta +
				(includeInsertion && edit.start === edit.end ? edit.inserted.length : 0)
			)
		}
		return edit.end === position
			? edit.start + delta + edit.inserted.length
			: undefined
	}
	return numbers.map((number) => {
		const start = project(number.index, false)
		const end = project(number.index + number[0].length, true)
		if (start === undefined || end === undefined) return undefined
		const value = text.slice(start, end)
		const match = [...value.matchAll(decimalNumber)]
		return match.length === 1 && match[0][0] === value
			? { start, end, value }
			: undefined
	})
}

/** Competing edits of the same base number keep the complete local value, as
 * JSON scalar conflicts do. Reset only that remote span to base before Yjs;
 * other remote edits remain intact. No ancestry is inferred from equal digits.
 */
function resolveNumericConflicts(
	base: string,
	local: string,
	remote: string,
	localDiffs: readonly TextDiff[],
	remoteDiffs: readonly TextDiff[],
): string {
	const numbers = [...base.matchAll(decimalNumber)]
	if (!numbers.length) return remote
	const localNumbers = projectNumbers(local, localDiffs, numbers)
	const remoteNumbers = projectNumbers(remote, remoteDiffs, numbers)
	const parts: string[] = []
	let end = remote.length
	for (let index = numbers.length - 1; index >= 0; index--) {
		const localNumber = localNumbers[index]
		const remoteNumber = remoteNumbers[index]
		const original = numbers[index][0]
		if (
			localNumber &&
			remoteNumber &&
			localNumber.value !== original &&
			remoteNumber.value !== original
		) {
			parts.push(remote.slice(remoteNumber.end, end), original)
			end = remoteNumber.start
		}
	}
	parts.push(remote.slice(0, end))
	return parts.reverse().join('')
}

/** Insertion keys are UTF-16 offsets in the original baseline, as used by DMP
 * and Y.Text. Identical words at different offsets remain independent edits.
 */
function getInsertions(diffs: readonly TextDiff[]) {
	const insertions = new Map<number, string>()
	let offset = 0
	for (const [operation, value] of diffs) {
		if (operation === diff_match_patch.DIFF_INSERT) {
			insertions.set(offset, value)
		} else {
			offset += value.length
		}
	}
	return insertions
}

const listLine = /^\s*(?:[-+*]|\d+[.)])\s+/

/** Keep fenced blocks and consecutive list lines atomic: their common markers
 * cannot turn two independent examples into a single block.
 */
function insertionUnits(text: string): string[] {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const units: string[] = []
	for (let index = 0; index < lines.length; index++) {
		const first = lines[index]
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(first)
		let unit = first
		if (opening) {
			while (++index < lines.length) {
				const line = lines[index]
				unit += line
				const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
				if (
					closing &&
					closing[1][0] === opening[1][0] &&
					closing[1].length >= opening[1].length
				)
					break
			}
		} else if (listLine.test(first)) {
			while (
				index + 1 < lines.length &&
				(listLine.test(lines[index + 1]) || /^\s+\S/.test(lines[index + 1]))
			) {
				unit += lines[++index]
			}
		}
		units.push(unit)
	}
	return units
}

/** Headings scope identity so independent sections cannot share scaffolding.
 */
function describeInsertion(lines: readonly string[]) {
	const headings: string[] = []
	return lines.map((raw, index) => {
		const content = raw.replaceAll('\r\n', '\n').replace(/\n$/, '')
		const inCode = /^ {0,3}(`{3,}|~{3,})/.test(content)
		const heading = !inCode && /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/.exec(content)
		const underline =
			!inCode &&
			!content.includes('\n') &&
			content.trim() !== '' &&
			/^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? '')
		if (heading) {
			headings.length = heading[1].length - 1
			headings.push(heading[2])
		} else if (underline) {
			headings.length = underline[1][0] === '=' ? 0 : 1
			headings.push(content)
		}
		const letters = content.match(/[\p{L}\p{N}]/gu)?.length ?? 0
		// Four Unicode letters/digits admit short CJK prose without counting Markdown
		// punctuation, headings, list markers or code as evidence of ancestry.
		const weight =
			!inCode &&
			!heading &&
			!underline &&
			!listLine.test(content) &&
			!/^\s*>/.test(content) &&
			letters >= 4
				? letters
				: 0
		return { key: JSON.stringify([headings, content]), weight }
	})
}

/** Match whole inserted lines in order, including repeated occurrences. Sharing
 * arbitrary matching characters could turn two unrelated sentences into one.
 * Line terminators are ignored for matching; shared bytes come from local so
 * each branch can still express its own newline changes through DMP.
 */
function alignInsertedText(local: string, remote: string) {
	const localLines = insertionUnits(local)
	const remoteLines = insertionUnits(remote)
	const localDescription = describeInsertion(localLines)
	const remoteDescription = describeInsertion(remoteLines)
	const localKeys = localDescription.map(({ key }) => key)
	const remoteKeys = remoteDescription.map(({ key }) => key)
	let prefix = 0
	while (
		prefix < Math.min(localKeys.length, remoteKeys.length) &&
		localKeys[prefix] === remoteKeys[prefix]
	)
		prefix++
	let localEnd = localKeys.length
	let remoteEnd = remoteKeys.length
	while (
		localEnd > prefix &&
		remoteEnd > prefix &&
		localKeys[localEnd - 1] === remoteKeys[remoteEnd - 1]
	) {
		localEnd--
		remoteEnd--
	}
	// Most shared articles differ in a small middle section. Strip common edges
	// before LCS so long unchanged text does not incur its quadratic search.
	const regions = diffComm(
		localKeys.slice(prefix, localEnd),
		remoteKeys.slice(prefix, remoteEnd),
	)
	if (prefix) regions.unshift({ common: localKeys.slice(0, prefix) })
	if (localEnd < localKeys.length)
		regions.push({ common: localKeys.slice(localEnd) })
	const occurrences = (keys: readonly string[]) => {
		const counts = new Map<string, number>()
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
		return counts
	}
	const localCounts = occurrences(localKeys)
	const remoteCounts = occurrences(remoteKeys)
	const weights = new Map(
		localDescription.map(({ key, weight }) => [key, weight]),
	)
	let supportedWeight = 0
	for (const region of regions) {
		if (
			region.common?.some(
				(key) =>
					(weights.get(key) ?? 0) > 0 &&
					localCounts.get(key) === 1 &&
					remoteCounts.get(key) === 1,
			)
		) {
			supportedWeight += region.common.reduce(
				(sum, key) => sum + (weights.get(key) ?? 0),
				0,
			)
		}
	}
	const shorterWeight = Math.min(
		localDescription.reduce((sum, { weight }) => sum + weight, 0),
		remoteDescription.reduce((sum, { weight }) => sum + weight, 0),
	)
	// This is a conservative similarity policy, not proof of common ancestry.
	// Ordered runs supported by unique prose anchors must cover at least half
	// the shorter insertion's prose. Exact insertions retain their shared identity.
	if (
		localKeys.join('\n') !== remoteKeys.join('\n') &&
		(supportedWeight === 0 || supportedWeight * 2 < shorterWeight)
	) {
		return {
			common: '',
			localDiffs: [] as TextDiff[],
			remoteDiffs: [] as TextDiff[],
		}
	}
	const common: string[] = []
	const localDiffs: TextDiff[] = []
	const remoteDiffs: TextDiff[] = []
	let localIndex = 0
	let remoteIndex = 0
	for (const region of regions) {
		if (region.common) {
			const localBlock = localLines
				.slice(localIndex, localIndex + region.common.length)
				.join('')
			const remoteBlock = remoteLines
				.slice(remoteIndex, remoteIndex + region.common.length)
				.join('')
			if (localBlock === remoteBlock) {
				common.push(localBlock)
				localDiffs.push([diff_match_patch.DIFF_EQUAL, localBlock])
				remoteDiffs.push([diff_match_patch.DIFF_EQUAL, remoteBlock])
				localIndex += region.common.length
				remoteIndex += region.common.length
				continue
			}
			for (let i = 0; i < region.common.length; i++) {
				const localLine = localLines[localIndex++]
				const remoteLine = remoteLines[remoteIndex++]
				common.push(localLine)
				localDiffs.push([diff_match_patch.DIFF_EQUAL, localLine])
				remoteDiffs.push(...diffText(localLine, remoteLine))
			}
		} else {
			const localText = localLines
				.slice(localIndex, localIndex + region.buffer1.length)
				.join('')
			const remoteText = remoteLines
				.slice(remoteIndex, remoteIndex + region.buffer2.length)
				.join('')
			if (localText) localDiffs.push([diff_match_patch.DIFF_INSERT, localText])
			if (remoteText)
				remoteDiffs.push([diff_match_patch.DIFF_INSERT, remoteText])
			localIndex += region.buffer1.length
			remoteIndex += region.buffer2.length
		}
	}
	// Keep the alignment's line boundaries in the branch edits. Re-diffing the
	// concatenated common text can attach both inserts to one trailing newline.
	return { common: common.join(''), localDiffs, remoteDiffs }
}

type AlignedInsertion = ReturnType<typeof alignInsertedText>
type InsertionBranch = 'localDiffs' | 'remoteDiffs'

function applyTextDiff(
	text: Y.Text,
	diffs: readonly TextDiff[],
	sharedInsertions: ReadonlyMap<number, AlignedInsertion>,
	branch: InsertionBranch,
	startIndex = 0,
): void {
	let index = startIndex
	let baseOffset = 0

	text.doc!.transact(() => {
		for (const [operation, value] of diffs) {
			switch (operation) {
				case diff_match_patch.DIFF_EQUAL:
					index += value.length
					baseOffset += value.length
					break
				case diff_match_patch.DIFF_DELETE:
					text.delete(index, value.length)
					baseOffset += value.length
					break
				case diff_match_patch.DIFF_INSERT:
					{
						const shared = sharedInsertions.get(baseOffset)
						if (shared) {
							applyTextDiff(text, shared[branch], new Map(), branch, index)
						} else {
							text.insert(index, value)
						}
					}
					index += value.length
			}
		}
	})
}

function mergeTextWithYjs(base: string, local: string, remote: string): string {
	const localDiffs = diffText(base, local)
	let remoteDiffs = diffText(base, remote)
	const resolvedRemote = resolveNumericConflicts(
		base,
		local,
		remote,
		localDiffs,
		remoteDiffs,
	)
	if (resolvedRemote !== remote) remoteDiffs = diffText(base, resolvedRemote)
	const localInsertions = getInsertions(localDiffs)
	const remoteInsertions = getInsertions(remoteDiffs)
	const sharedInsertions = new Map<number, AlignedInsertion>()
	for (const [offset, localInsertion] of localInsertions) {
		const remoteInsertion = remoteInsertions.get(offset)
		if (remoteInsertion !== undefined) {
			const aligned = alignInsertedText(localInsertion, remoteInsertion)
			if (aligned.common) {
				sharedInsertions.set(offset, aligned)
			}
		}
	}

	const baseDoc = new Y.Doc()
	const baseText = baseDoc.getText('content')
	baseText.insert(0, base)
	// Seed common insertions once so both branches inherit the same Yjs IDs.
	// Descending offsets keep every position relative to the original baseline.
	for (const [offset, aligned] of [...sharedInsertions].sort(
		([a], [b]) => b - a,
	)) {
		baseText.insert(offset, aligned.common)
	}
	const baseUpdate = Y.encodeStateAsUpdate(baseDoc)
	const baseStateVector = Y.encodeStateVector(baseDoc)

	const createBranchUpdate = (
		diffs: readonly TextDiff[],
		branch: InsertionBranch,
	) => {
		const branchDoc = new Y.Doc()
		Y.applyUpdate(branchDoc, baseUpdate)
		try {
			applyTextDiff(
				branchDoc.getText('content'),
				diffs,
				sharedInsertions,
				branch,
			)
			return Y.encodeStateAsUpdate(branchDoc, baseStateVector)
		} finally {
			branchDoc.destroy()
		}
	}

	const mergedDoc = new Y.Doc()
	try {
		Y.applyUpdate(mergedDoc, baseUpdate)
		Y.applyUpdate(mergedDoc, createBranchUpdate(localDiffs, 'localDiffs'))
		Y.applyUpdate(mergedDoc, createBranchUpdate(remoteDiffs, 'remoteDiffs'))
		return mergedDoc.getText('content').toJSON()
	} finally {
		baseDoc.destroy()
		mergedDoc.destroy()
	}
}

export async function resolveByIntelligentMerge(
	params: IntelligentMergeParams,
): Promise<IntelligentMergeResult> {
	const {
		localContentText,
		remoteContentText,
		baseContentText,
		filePath,
		hasBase = true,
	} = params

	if (localContentText === remoteContentText) {
		return { success: true, isIdentical: true }
	}

	if (filePath?.trim().toLowerCase().endsWith('.json')) {
		const mergedJson = mergeJsonStrings(
			baseContentText,
			localContentText,
			remoteContentText,
			hasBase,
		)
		if (mergedJson !== undefined) {
			return { success: true, mergedText: mergedJson }
		}
	}

	try {
		return {
			success: true,
			mergedText: mergeTextWithYjs(
				baseContentText,
				localContentText,
				remoteContentText,
			),
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
