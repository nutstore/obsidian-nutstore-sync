import { isEqual } from 'es-toolkit/compat'
import type {
	IntelligentMergeParams,
	IntelligentMergeResult,
	MergeEngine,
} from './types'
import { yjsTextMergeEngine } from './yjs-text-merge'

const MISSING_JSON_VALUE = Symbol('missing-json-value')

type MissingJsonValue = typeof MISSING_JSON_VALUE
type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function isJsonPath(filePath: string): boolean {
	return filePath.trim().toLowerCase().endsWith('.json')
}

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

export function createJsonMergeEngine(
	fallbackEngine: MergeEngine = yjsTextMergeEngine,
): MergeEngine {
	return {
		id: 'json',
		match: isJsonPath,
		merge(params: IntelligentMergeParams): IntelligentMergeResult {
			const {
				baseContentText,
				localContentText,
				remoteContentText,
				hasBase = true,
			} = params
			const mergedJson = mergeJsonStrings(
				baseContentText,
				localContentText,
				remoteContentText,
				hasBase,
			)
			if (mergedJson !== undefined) {
				return { success: true, mergedText: mergedJson }
			}
			return fallbackEngine.merge(params)
		},
	}
}

export const jsonMergeEngine: MergeEngine = createJsonMergeEngine()
