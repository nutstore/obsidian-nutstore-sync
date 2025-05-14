import { diff_match_patch } from 'diff-match-patch'
import { isEqual } from 'lodash-es'
import { diff3Merge as nodeDiff3Merge } from 'node-diff3'
import { BufferLike } from 'webdav'

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
}

export interface IntelligentMergeResult {
	success: boolean
	mergedText?: string
	error?: string // Generic error message
	isIdentical?: boolean // Flag if contents were already identical
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
			result.push(region.ok as string[])
		}
	}
	return result.flat().join('\n')
}

export async function resolveByIntelligentMerge(
	params: IntelligentMergeParams,
): Promise<IntelligentMergeResult> {
	const { localContentText, remoteContentText, baseContentText } = params

	if (localContentText === remoteContentText) {
		return { success: true, isIdentical: true }
	}

	const diff3MergedText = diff3MergeStrings(
		baseContentText,
		localContentText,
		remoteContentText,
	)

	if (diff3MergedText !== false) {
		return { success: true, mergedText: diff3MergedText }
	}

	const dmp = new diff_match_patch()
	dmp.Match_Threshold = 0.2
	dmp.Patch_Margin = 2

	const diffs = dmp.diff_main(baseContentText, remoteContentText)
	const patches = dmp.patch_make(baseContentText, diffs)
	let [mergedDmpText, solveResult] = dmp.patch_apply(patches, localContentText)

	if (solveResult.includes(false)) {
		return { success: false }
	}

	return { success: true, mergedText: mergedDmpText }
}
