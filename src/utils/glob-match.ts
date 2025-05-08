import GlobToRegExp from 'glob-to-regexp'
import { cloneDeep } from 'lodash-es'
import { basename } from 'path'

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

export default class GlobMatch {
	re: RegExp
	expr: string

	constructor({ expr, options }: GlobMatchOptions) {
		this.expr = expr
		this.re = GlobToRegExp(this.expr, {
			flags: generateFlags(options),
			extended: true,
		})
	}

	test(path: string) {
		if (path === this.expr) {
			return true
		}
		const name = basename(path)
		if (name === this.expr) {
			return true
		}
		if (this.re.test(path) || this.re.test(name)) {
			return true
		}
		return false
	}
}

export function getUserOptions(opt: GlobMatchOptions): GlobMatchUserOptions {
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
	return true
}
