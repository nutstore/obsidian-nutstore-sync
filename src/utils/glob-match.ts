import GlobToRegExp from 'glob-to-regexp'
import { cloneDeep } from 'lodash-es'
import path from 'path-browserify'

export interface GlobMatchUserOptions {
	caseSensitive: boolean
}

export interface GlobMatchOptions {
	expr: string
	options: GlobMatchUserOptions
}

const DEFAULT_USER_OPTIONS: GlobMatchUserOptions = {
	caseSensitive: false,
}

export function isVoidGlobMatchOptions(options: GlobMatchOptions): boolean {
	return options.expr.trim() === ''
}

function generateFlags(options: GlobMatchUserOptions) {
	let flags = ''
	if (!options.caseSensitive) {
		flags += 'i'
	}
	return flags
}

function normalizePath(rawPath: string) {
	const normalized = path.normalize(rawPath)
	const trimmed = normalized.replace(/^\.+\//, '').replace(/^\/+/, '')
	const isDirPath = trimmed.endsWith('/')
	const withoutTrailing = isDirPath ? trimmed.slice(0, -1) : trimmed
	const segments = withoutTrailing
		? withoutTrailing.split('/').filter(Boolean)
		: []
	return {
		normalized: segments.join('/'),
		segments,
		isDirPath,
	}
}

function buildRegExp(expr: string, options: GlobMatchUserOptions) {
	return GlobToRegExp(expr, {
		flags: generateFlags(options),
		extended: true,
		globstar: true,
	})
}

export default class GlobMatch {
	re: RegExp
	private readonly isRooted: boolean
	private readonly isDirOnly: boolean
	private readonly hasSlash: boolean
	private readonly patternBody: string
	private readonly pathRegex?: RegExp
	private readonly segmentRegex?: RegExp

	constructor(
		public expr: string,
		public options: GlobMatchUserOptions,
	) {
		const trimmed = expr.trim()
		this.isRooted = trimmed.startsWith('/')
		this.isDirOnly = trimmed.endsWith('/')
		this.patternBody = trimmed.slice(
			this.isRooted ? 1 : 0,
			this.isDirOnly ? -1 : undefined,
		)
		this.hasSlash = this.patternBody.includes('/')
		if (this.patternBody !== '') {
			if (this.isRooted || this.hasSlash) {
				this.pathRegex = buildRegExp(this.patternBody, options)
				this.re = this.pathRegex
			} else {
				this.segmentRegex = buildRegExp(this.patternBody, options)
				this.re = this.segmentRegex
			}
		} else {
			this.re = /^$/
		}
	}

	private matchDirectoryBySegments(segments: string[], isDirPath: boolean) {
		for (let i = 0; i < segments.length; i += 1) {
			const isSegmentDir = i < segments.length - 1 || isDirPath
			if (!isSegmentDir) {
				continue
			}
			if (this.segmentRegex?.test(segments[i])) {
				return true
			}
		}
		return false
	}

	private matchDirectoryByPrefix(segments: string[], isDirPath: boolean) {
		for (let i = 1; i <= segments.length; i += 1) {
			const isSegmentDir = i < segments.length || isDirPath
			if (!isSegmentDir) {
				continue
			}
			const prefix = segments.slice(0, i).join('/')
			if (this.pathRegex?.test(prefix)) {
				return true
			}
		}
		return false
	}

	test(path: string) {
		if (this.patternBody === '') {
			return false
		}
		const { normalized, segments, isDirPath } = normalizePath(path)
		if (this.isDirOnly) {
			if (this.isRooted || this.hasSlash) {
				return this.matchDirectoryByPrefix(segments, isDirPath)
			}
			return this.matchDirectoryBySegments(segments, isDirPath)
		}
		if (this.isRooted || this.hasSlash) {
			return this.pathRegex?.test(normalized) ?? false
		}
		return segments.some((segment) => this.segmentRegex?.test(segment))
	}
}

export function getUserOptions(
	opt: GlobMatchOptions | string,
): GlobMatchUserOptions {
	if (typeof opt === 'string') {
		return cloneDeep(DEFAULT_USER_OPTIONS)
	}
	return opt.options ?? cloneDeep(DEFAULT_USER_OPTIONS)
}

export function needIncludeFromGlobRules(
	path: string,
	inclusion: GlobMatch[],
	exclusion: GlobMatch[],
) {
	for (const rule of inclusion) {
		if (rule.test(path)) {
			return true
		}
	}
	for (const rule of exclusion) {
		if (rule.test(path)) {
			return false
		}
	}
	const { segments } = normalizePath(path)
	const parentCount = Math.max(segments.length - 1, 0)
	for (let i = 1; i <= parentCount; i += 1) {
		const parentPath = `${segments.slice(0, i).join('/')}/`
		for (const rule of exclusion) {
			if (rule.test(parentPath)) {
				return false
			}
		}
	}
	return true
}
