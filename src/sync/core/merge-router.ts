import { chatMetaMergeEngine, chatSessionMergeEngine } from './chat-merge'
import type {
	IntelligentMergeParams,
	IntelligentMergeResult,
	MergeEngine,
} from './merge-types'

export const DEFAULT_MERGE_ENGINES: readonly MergeEngine[] = [
	chatSessionMergeEngine,
	chatMetaMergeEngine,
]

export function matchMergeEngine(
	filePath: string | undefined,
	engines: readonly MergeEngine[] = DEFAULT_MERGE_ENGINES,
): MergeEngine | undefined {
	if (!filePath) {
		return undefined
	}
	return engines.find((engine) => engine.match(filePath))
}

export function resolveWithMergeRouter(
	params: IntelligentMergeParams,
	engines: readonly MergeEngine[] = DEFAULT_MERGE_ENGINES,
): IntelligentMergeResult | undefined {
	const engine = matchMergeEngine(params.filePath, engines)
	if (!engine) {
		return undefined
	}
	return engine.merge(params)
}
