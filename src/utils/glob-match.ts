import GlobToRegExp, { Options } from 'glob-to-regexp'
import { isArray } from 'lodash-es'
import { basename } from 'path'
import { uniq } from 'ramda'

export default class GlobMatch {
	private re: RegExp

	static from(expr: string[], options?: Options): GlobMatch[]
	static from(expr: string, options?: Options): GlobMatch
	static from(
		expr: string | string[],
		options?: Options,
	): GlobMatch[] | GlobMatch {
		if (isArray(expr)) {
			return uniq(expr.filter((f) => f.trim()) ?? []).map(
				(e) => new GlobMatch(e, options),
			)
		}
		return new GlobMatch(expr, options)
	}

	constructor(
		private expr: string,
		options?: Options,
	) {
		this.re = GlobToRegExp(expr, options)
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
