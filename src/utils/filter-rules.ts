import path from 'path-browserify'
import GlobMatch, {
	type GlobMatchOptions,
	isVoidGlobMatchOptions,
} from './gitignore-pattern'

export type FilterRuleType = 'include' | 'exclude'

export interface GlobFilterRule extends GlobMatchOptions {
	type: FilterRuleType
	/**
	 * When true the rule is skipped during matching. Absent or false means the
	 * rule is active.
	 */
	disabled?: boolean
}

export interface CompiledFilterRule {
	match: GlobMatch
	type: FilterRuleType
}

export function compileFilterRules(
	rules: GlobFilterRule[] = [],
): CompiledFilterRule[] {
	return rules
		.filter((rule) => rule.disabled !== true && !isVoidGlobMatchOptions(rule))
		.map((rule) => ({
			match: new GlobMatch(rule.expr, rule.options),
			type: rule.type,
		}))
}

export interface LegacyFilterRules {
	exclusionRules?: GlobMatchOptions[]
	inclusionRules?: GlobMatchOptions[]
	rules?: GlobFilterRule[]
}

export function migrateLegacyFilterRules(
	filterRules: LegacyFilterRules | undefined,
): { rules: GlobFilterRule[]; migrated: boolean } {
	const source = filterRules ?? {}
	if (Array.isArray(source.rules)) {
		return { rules: [...source.rules], migrated: false }
	}
	const hasLegacyKeys =
		Array.isArray(source.exclusionRules) || Array.isArray(source.inclusionRules)
	const exclusions = (source.exclusionRules ?? []).map((rule) => ({
		...rule,
		type: 'exclude' as const,
	}))
	const inclusions = (source.inclusionRules ?? []).map((rule) => ({
		...rule,
		type: 'include' as const,
	}))
	return {
		rules: [...exclusions, ...inclusions],
		migrated: hasLegacyKeys,
	}
}

function hasNormalizedSegments(rawPath: string): boolean {
	return (
		rawPath !== '' &&
		rawPath !== '.' &&
		!rawPath.includes('..') &&
		!rawPath.includes('./') &&
		!rawPath.includes('//') &&
		!rawPath.endsWith('/.')
	)
}

function isCleanNormalizedPath(rawPath: string): boolean {
	return (
		hasNormalizedSegments(rawPath) &&
		rawPath[0] !== '/' &&
		rawPath[rawPath.length - 1] !== '/'
	)
}

function normalizePathSegments(rawPath: string) {
	if (hasNormalizedSegments(rawPath)) {
		const trimmed = rawPath.replace(/^\/+/, '').replace(/\/+$/, '')
		return trimmed ? trimmed.split('/').filter(Boolean) : []
	}
	const normalized = path.normalize(rawPath)
	const trimmed = normalized.replace(/^\.+\//, '').replace(/^\/+/, '')
	const withoutTrailing = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
	return withoutTrailing ? withoutTrailing.split('/').filter(Boolean) : []
}

function evaluateSegment(
	rules: CompiledFilterRule[],
	normalized: string,
	lastSegment: string,
	isDirNode: boolean,
): CompiledFilterRule | undefined {
	const target = { normalized, lastSegment, isDirPath: isDirNode }
	let last: CompiledFilterRule | undefined
	for (const rule of rules) {
		if (rule.match.testNormalized(target)) last = rule
	}
	return last
}

/** Apply ordered rules to every ancestor before deciding the leaf. */
export function isPathIncluded(
	rawPath: string,
	rules: CompiledFilterRule[],
	isDir = false,
): boolean {
	if (rules.length === 0) return true
	const segments = normalizePathSegments(rawPath)
	let prefix = ''
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]
		prefix = index === 0 ? segment : `${prefix}/${segment}`
		const isDirNode = index < segments.length - 1 || isDir
		const last =
			isDirNode && (prefix === '.' || prefix === '..')
				? undefined
				: evaluateSegment(rules, prefix, segment, isDirNode)

		if (isDirNode) {
			if (last?.type === 'exclude') return false
			continue
		}
		return last ? last.type === 'include' : true
	}
	return true
}

/**
 * Creates a memoized inclusion checker for repeated queries against one rule set
 * (e.g. a single sync run). Caches directory-prefix pruning and leaf decisions.
 */
export function createPathInclusionChecker(
	rules: CompiledFilterRule[],
): (rawPath: string, isDir?: boolean) => boolean {
	if (rules.length === 0) return () => true
	const dirCache = new Map<string, boolean>()
	const fileCache = new Map<string, boolean>()

	return (rawPath: string, isDir = false): boolean => {
		const isClean = isCleanNormalizedPath(rawPath)
		if (isClean) {
			const cached = isDir ? dirCache.get(rawPath) : fileCache.get(rawPath)
			if (cached !== undefined) return cached
		}

		const segments = normalizePathSegments(rawPath)
		if (segments.length === 0) return true

		let prefix = ''
		const lastIndex = segments.length - 1
		for (let index = 0; index < lastIndex; index += 1) {
			const segment = segments[index]
			prefix = index === 0 ? segment : `${prefix}/${segment}`
			let dirIncluded = dirCache.get(prefix)
			if (dirIncluded === undefined) {
				if (prefix === '.' || prefix === '..') {
					dirIncluded = true
				} else {
					const last = evaluateSegment(rules, prefix, segment, true)
					dirIncluded = last?.type !== 'exclude'
				}
				dirCache.set(prefix, dirIncluded)
			}
			if (!dirIncluded) {
				const fullKey = isClean ? rawPath : segments.join('/')
				if (isDir) dirCache.set(fullKey, false)
				else fileCache.set(fullKey, false)
				return false
			}
		}

		const leafSegment = segments[lastIndex]
		const fullKey = isClean
			? rawPath
			: lastIndex === 0
				? leafSegment
				: `${prefix}/${leafSegment}`

		if (isDir) {
			let dirIncluded = dirCache.get(fullKey)
			if (dirIncluded === undefined) {
				if (fullKey === '.' || fullKey === '..') {
					dirIncluded = true
				} else {
					const last = evaluateSegment(rules, fullKey, leafSegment, true)
					dirIncluded = last?.type !== 'exclude'
				}
				dirCache.set(fullKey, dirIncluded)
			}
			return dirIncluded
		}

		const cachedFile = fileCache.get(fullKey)
		if (cachedFile !== undefined) return cachedFile

		const last = evaluateSegment(rules, fullKey, leafSegment, false)
		const included = last ? last.type === 'include' : true
		fileCache.set(fullKey, included)
		return included
	}
}

export type { GlobMatchOptions }
