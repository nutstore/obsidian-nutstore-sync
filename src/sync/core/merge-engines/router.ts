import { chatMetaMergeEngine, chatSessionMergeEngine } from './chat-merge'
import { diff3MergeEngine } from './diff3-merge'
import { jsonMergeEngine } from './json-merge'
import type {
	IntelligentMergeParams,
	IntelligentMergeResult,
	MergeEngine,
} from './types'
import { yjsTextMergeEngine } from './yjs-text-merge'

/** Priority-ordered merge engines for the Diff3 conflict strategy. */
export const DIFF3_MERGE_ENGINES: readonly MergeEngine[] = [
	chatSessionMergeEngine,
	chatMetaMergeEngine,
	diff3MergeEngine,
]

/** Priority-ordered merge engines for the NoConflictMerge strategy. */
export const NO_CONFLICT_MERGE_ENGINES: readonly MergeEngine[] = [
	chatSessionMergeEngine,
	chatMetaMergeEngine,
	jsonMergeEngine,
	yjsTextMergeEngine,
]

export function matchMergeEngine(
	filePath: string | undefined,
	engines: readonly MergeEngine[] = NO_CONFLICT_MERGE_ENGINES,
): MergeEngine | undefined {
	const path = filePath ?? ''
	return engines.find((engine) => engine.match(path))
}

export function resolveWithMergeRouter(
	params: IntelligentMergeParams,
	engines: readonly MergeEngine[] = NO_CONFLICT_MERGE_ENGINES,
): IntelligentMergeResult {
	if (params.localContentText === params.remoteContentText) {
		return { success: true, isIdentical: true }
	}

	const engine = matchMergeEngine(params.filePath, engines)
	if (!engine) {
		return {
			success: false,
			error: `No merge engine matched path: ${params.filePath ?? ''}`,
		}
	}

	return engine.merge(params)
}
