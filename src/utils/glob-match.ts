import GlobToRegExp from 'glob-to-regexp'
import { cloneDeep } from 'lodash-es'
import { basename } from 'path'

export interface GlobMatchUserOptions {
	caseSensitive: boolean
}

export type GlobMatchOptions =
	| {
			expr: string
			options: GlobMatchUserOptions
	  }
	| string

const DEFAULT_USER_OPTIONS: GlobMatchUserOptions = {
	caseSensitive: false,
}

export function isVoidGlobMatchOptions(options: GlobMatchOptions): boolean {
	if (typeof options === 'string') {
		return options.trim() === ''
	}
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
	private re: RegExp
	private expr: string

	constructor(options: GlobMatchOptions) {
		this.expr = getExpr(options)
		const userOpt = getUserOptions(options)
		this.re = GlobToRegExp(this.expr, {
			flags: generateFlags(userOpt),
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

export function getExpr(opt: GlobMatchOptions) {
	if (typeof opt === 'string') {
		return opt
	}
	return opt.expr
}

export function getUserOptions(opt: GlobMatchOptions): GlobMatchUserOptions {
	if (typeof opt === 'string') {
		return cloneDeep(DEFAULT_USER_OPTIONS)
	}
	return opt.options ?? cloneDeep(DEFAULT_USER_OPTIONS)
}
