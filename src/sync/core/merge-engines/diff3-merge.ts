import { mergeDiff3 } from './line-diff3'
import type {
	IntelligentMergeParams,
	IntelligentMergeResult,
	MergeEngine,
} from './types'

export const diff3MergeEngine: MergeEngine = {
	id: 'diff3',
	match: () => true,
	merge({
		localContentText,
		remoteContentText,
		baseContentText,
	}: IntelligentMergeParams): IntelligentMergeResult {
		const { result } = mergeDiff3(
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
	},
}
