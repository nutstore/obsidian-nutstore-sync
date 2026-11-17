import { isEqual } from 'es-toolkit/compat'
import { BufferLike } from 'webdav'
import {
	DIFF3_MERGE_ENGINES,
	NO_CONFLICT_MERGE_ENGINES,
	resolveWithMergeRouter,
} from './merge-engines/router'
import type {
	Diff3MergeParams,
	IntelligentMergeParams,
	IntelligentMergeResult,
} from './merge-engines/types'

export type {
	Diff3MergeParams,
	IntelligentMergeParams,
	IntelligentMergeResult,
	MergeEngine,
} from './merge-engines/types'

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

// --- Logic for Merge Strategy Resolution ---

export function resolveByDiff3Merge(
	params: Diff3MergeParams,
): IntelligentMergeResult {
	return resolveWithMergeRouter(params, DIFF3_MERGE_ENGINES)
}

export async function resolveByIntelligentMerge(
	params: IntelligentMergeParams,
): Promise<IntelligentMergeResult> {
	return resolveWithMergeRouter(params, NO_CONFLICT_MERGE_ENGINES)
}
