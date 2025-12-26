import GlobToRegExp from 'glob-to-regexp'
import { cloneDeep } from 'lodash-es'

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

	constructor(
		public expr: string,
		public options: GlobMatchUserOptions,
	) {
		this.re = GlobToRegExp(this.expr, {
			flags: generateFlags(options),
			extended: true,
			globstar: true,
		})
	}

	test(path: string) {
		if (path === this.expr) {
			return true
		}
		if (this.re.test(path)) {
			return true
		}
		return false
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
	return true
}

/**
 * 如果忽略/包含了某文件夹，例如：.git，那也应该忽略/包含里面的所有文件。
 *
 * 即: .git = .git + .git/*
 */
export function extendRules(rules: GlobMatch[]) {
	rules = [...rules]
	for (const { expr, options } of rules) {
		if (expr.startsWith('!') || expr.includes('*') || expr.endsWith('**')) {
			continue
		}
		const newRule = new GlobMatch(
			`${expr.endsWith('/') ? expr : expr + '/'}**`,
			options,
		)
		rules.push(newRule)
	}
	return rules
}
