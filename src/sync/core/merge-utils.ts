import { diff_match_patch } from 'diff-match-patch'
import { isEqual } from 'lodash-es'
import {
	diff3Merge as nodeDiff3Merge,
	mergeDiff3 as nodeMergeDiff3,
} from 'node-diff3'
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

// Helper for diff3Merge logic, adapted from the original class method
function diff3MergeStrings(
	base: string | string[],
	local: string | string[],
	remote: string | string[],
): string | false {
	const regions = nodeDiff3Merge(local, base, remote, {
		excludeFalseConflicts: true,
		stringSeparator: '\n',
	})

	if (regions.some((region) => !region.ok)) {
		return false
	}
	const result: string[][] = []
	for (const region of regions) {
		if (region.ok) {
			result.push(region.ok)
		}
	}
	return result.flat().join('\n')
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
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }

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

function applyTextDiff(text: Y.Text, base: string, target: string): void {
	const dmp = new diff_match_patch()
	const diffs = dmp.diff_main(base, target)
	let index = 0

	text.doc!.transact(() => {
		for (const [operation, value] of diffs) {
			switch (operation) {
				case diff_match_patch.DIFF_EQUAL:
					index += value.length
					break
				case diff_match_patch.DIFF_DELETE:
					text.delete(index, value.length)
					break
				case diff_match_patch.DIFF_INSERT:
					text.insert(index, value)
					index += value.length
			}
		}
	})
}

function mergeTextWithYjs(base: string, local: string, remote: string): string {
	const baseDoc = new Y.Doc()
	baseDoc.getText('content').insert(0, base)
	const baseUpdate = Y.encodeStateAsUpdate(baseDoc)
	const baseStateVector = Y.encodeStateVector(baseDoc)

	const createBranchUpdate = (content: string) => {
		const branchDoc = new Y.Doc()
		Y.applyUpdate(branchDoc, baseUpdate)
		applyTextDiff(branchDoc.getText('content'), base, content)
		return Y.encodeStateAsUpdate(branchDoc, baseStateVector)
	}

	const mergedDoc = new Y.Doc()
	Y.applyUpdate(mergedDoc, baseUpdate)
	Y.applyUpdate(mergedDoc, createBranchUpdate(local))
	Y.applyUpdate(mergedDoc, createBranchUpdate(remote))

	const mergedText = mergedDoc.getText('content')
	return mergedText.toJSON()
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

	const diff3MergedText = diff3MergeStrings(
		baseContentText,
		localContentText,
		remoteContentText,
	)

	if (diff3MergedText !== false) {
		return { success: true, mergedText: diff3MergedText }
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
