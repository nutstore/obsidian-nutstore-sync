import GlobMatch from '~/utils/glob-match'
import { isMarkdownPath } from '~/utils/mime/is_markdown_path'

export interface SearchPathEntry {
	path: string
	type: 'file' | 'folder'
}

function createGlobRules(patterns: string[]) {
	return patterns.map(
		(pattern) =>
			new GlobMatch(pattern, {
				caseSensitive: false,
			}),
	)
}

function matchesIncludedSearchGlob(path: string, inclusionRules: GlobMatch[]) {
	if (inclusionRules.length === 0) {
		return true
	}
	return inclusionRules.some((rule) => rule.test(path))
}

function matchesExcludedSearchGlob(path: string, exclusionRules: GlobMatch[]) {
	if (exclusionRules.some((rule) => rule.test(path))) {
		return true
	}

	const segments = path.replace(/\/+$/, '').split('/').filter(Boolean)
	const parentCount = Math.max(segments.length - 1, 0)
	for (let i = 1; i <= parentCount; i += 1) {
		const parentPath = `${segments.slice(0, i).join('/')}/`
		if (exclusionRules.some((rule) => rule.test(parentPath))) {
			return true
		}
	}

	return false
}

function normalizeExtension(extension: string) {
	const trimmed = extension.trim().toLowerCase()
	if (!trimmed) {
		return ''
	}
	return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function shouldIncludeByExtension(path: string, extensions: string[]) {
	if (extensions.length === 0) {
		return isMarkdownPath(path)
	}
	const normalized = path.toLowerCase()
	return extensions.some((extension) => normalized.endsWith(extension))
}

function isFilePathInScope(filePath: string, basePath: string) {
	if (!basePath) {
		return true
	}
	return filePath === basePath || filePath.startsWith(`${basePath}/`)
}

export function filterVaultEntries<TEntry extends SearchPathEntry>(
	entries: TEntry[],
	options: {
		basePath: string
		include: string[]
		exclude: string[]
		type: 'file' | 'folder' | 'all'
		extensions?: string[]
		defaultMarkdownOnly?: boolean
	},
) {
	const inclusionRules = createGlobRules(options.include)
	const exclusionRules = createGlobRules(options.exclude)
	const normalizedExtensions = (options.extensions ?? [])
		.map(normalizeExtension)
		.filter(Boolean)

	return entries.filter((entry) => {
		if (!isFilePathInScope(entry.path, options.basePath)) {
			return false
		}
		if (options.type !== 'all' && entry.type !== options.type) {
			return false
		}
		const candidatePath =
			entry.type === 'folder' ? `${entry.path}/` : entry.path
		if (!matchesIncludedSearchGlob(candidatePath, inclusionRules)) {
			return false
		}
		if (matchesExcludedSearchGlob(candidatePath, exclusionRules)) {
			return false
		}
		if (entry.type === 'file') {
			if (
				normalizedExtensions.length === 0 &&
				options.defaultMarkdownOnly === false
			) {
				return true
			}
			return shouldIncludeByExtension(entry.path, normalizedExtensions)
		}
		return true
	})
}
