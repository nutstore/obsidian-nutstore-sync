import { cloneDeep } from 'es-toolkit/compat'
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

function normalizePattern(expr: string) {
	let end = expr.length
	while (end > 0 && expr[end - 1] === ' ') {
		let precedingBackslashes = 0
		for (let index = end - 2; index >= 0 && expr[index] === '\\'; index -= 1) {
			precedingBackslashes += 1
		}
		if (precedingBackslashes % 2 === 1) break
		end -= 1
	}
	return expr.slice(0, end)
}

export function isVoidGlobMatchOptions(options: GlobMatchOptions): boolean {
	return normalizePattern(options.expr).trimEnd() === ''
}

function generateFlags(options: GlobMatchUserOptions) {
	return options.caseSensitive ? 'u' : 'ui'
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

const REGEXP_SPECIAL_CHARACTERS = /[\\^$.*+?()[\]{}|]/

const POSIX_CHARACTER_CLASSES: Record<string, string> = {
	alnum: 'A-Za-z0-9',
	alpha: 'A-Za-z',
	blank: ' \\t',
	cntrl: '\\x00-\\x1f\\x7f',
	digit: '0-9',
	graph: '\\x21-\\x7e',
	lower: 'a-z',
	print: '\\x20-\\x7e',
	punct: '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e',
	space: ' \\t-\\r',
	upper: 'A-Z',
	xdigit: 'A-Fa-f0-9',
}

function escapeRegExpCharacter(character: string) {
	return REGEXP_SPECIAL_CHARACTERS.test(character)
		? `\\${character}`
		: character
}

function findCharacterClassEnd(pattern: string, start: number) {
	let index = start + 1
	if (pattern[index] === '!' || pattern[index] === '^') index += 1
	if (pattern[index] === ']') index += 1
	for (; index < pattern.length; index += 1) {
		if (pattern[index] === '\\') {
			index += 1
		} else if (pattern[index] === '[' && pattern[index + 1] === ':') {
			const posixEnd = pattern.indexOf(':]', index + 2)
			if (posixEnd !== -1) index = posixEnd + 1
		} else if (pattern[index] === ']') {
			return index
		}
	}
	return -1
}

function compileCharacterClass(pattern: string, start: number, end: number) {
	let index = start + 1
	let negated = false
	if (pattern[index] === '!' || pattern[index] === '^') {
		negated = true
		index += 1
	}

	let body = ''
	if (pattern[index] === ']') {
		body += '\\]'
		index += 1
	}
	for (; index < end; index += 1) {
		const character = pattern[index]
		if (character === '[' && pattern[index + 1] === ':') {
			const posixEnd = pattern.indexOf(':]', index + 2)
			const className = pattern.slice(index + 2, posixEnd)
			const posixClass = POSIX_CHARACTER_CLASSES[className]
			if (posixEnd !== -1 && posixEnd < end && posixClass) {
				body += posixClass
				index = posixEnd + 1
				continue
			}
		}
		if (character === '\\' && index + 1 < end) {
			index += 1
			if (pattern[index] !== '/') body += `\\${pattern[index]}`
		} else if (character === '/') {
			continue
		} else if (character === '[' || character === '^') {
			body += `\\${character}`
		} else {
			body += character
		}
	}

	if (negated) return `[^/${body}]`
	return body === '' ? '(?!)' : `[${body}]`
}

/** Convert the wildcard subset defined by gitignore into a path-safe RegExp. */
function buildRegExp(pattern: string, options: GlobMatchUserOptions) {
	let source = ''
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]

		if (character === '\\') {
			if (index + 1 < pattern.length) {
				index += 1
				source += escapeRegExpCharacter(pattern[index])
			} else {
				source += '\\\\'
			}
			continue
		}

		if (character === '[') {
			const end = findCharacterClassEnd(pattern, index)
			if (end === -1) {
				source += '\\['
			} else {
				source += compileCharacterClass(pattern, index, end)
				index = end
			}
			continue
		}

		if (character === '?') {
			source += '[^/]'
			continue
		}

		if (character === '*') {
			let end = index
			while (pattern[end + 1] === '*') end += 1
			const isGlobstar =
				end > index &&
				(index === 0 || pattern[index - 1] === '/') &&
				(end === pattern.length - 1 || pattern[end + 1] === '/')

			if (isGlobstar) {
				if (pattern[end + 1] === '/') {
					source += '(?:[^/]+/)*'
					end += 1
				} else {
					source += '.*'
				}
			} else {
				source += '[^/]*'
			}
			index = end
			continue
		}

		source += escapeRegExpCharacter(character)
	}

	return new RegExp(`^${source}$`, generateFlags(options))
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
		const normalizedExpr = normalizePattern(expr)
		this.isRooted = normalizedExpr.startsWith('/')
		this.isDirOnly = normalizedExpr.endsWith('/')
		this.patternBody = normalizedExpr.slice(
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

	test(path: string) {
		if (this.patternBody === '') return false
		const { normalized, segments, isDirPath } = normalizePath(path)
		if (this.isDirOnly) {
			if (!isDirPath) return false
			if (this.isRooted || this.hasSlash) {
				return this.pathRegex?.test(normalized) ?? false
			}
			return segments.some((segment) => this.segmentRegex?.test(segment))
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
	if (typeof opt === 'string') return cloneDeep(DEFAULT_USER_OPTIONS)
	return opt.options ?? cloneDeep(DEFAULT_USER_OPTIONS)
}
