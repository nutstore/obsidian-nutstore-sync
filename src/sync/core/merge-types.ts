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
	filePath?: string
	hasBase?: boolean
}

export interface MergeEngine {
	/** Descriptive engine identifier for diagnostics and testing. */
	readonly id: string
	/** Pure predicate: returns true when this engine should handle the given path. */
	readonly match: (filePath: string) => boolean
	/** Performs a structured merge for a matched file. */
	readonly merge: (params: IntelligentMergeParams) => IntelligentMergeResult
}
