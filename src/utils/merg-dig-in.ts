// @ts-nocheck

import { diff3Merge, diffComm } from 'node-diff3'

/**
 * https://github.com/bhousel/node-diff3/blob/39c04c024620d3971010abf4ba3e2cbdba2f3f81/index.mjs#L464
 */
export function mergeDigIn(
	a: string[] | string,
	o: string[] | string,
	b: string[] | string,
	options: {
		excludeFalseConflicts?: boolean
		stringSeparator?: string | RegExp
	},
) {
	const defaults = {
		excludeFalseConflicts: true,
		stringSeparator: /\s+/,
		label: {},
	}
	options = Object.assign(defaults, options)

	const aSection = `<mark class="conflict ours">`
	const xSection = '</mark><mark class="conflict theirs">'
	const bSection = `</mark>`

	const regions = diff3Merge(a, o, b, options)
	let conflict = false
	let result: string[] = []

	regions.forEach((region) => {
		if (region.ok) {
			result = result.concat(region.ok)
		} else {
			const c = diffComm(region.conflict!.a, region.conflict!.b)
			for (let j = 0; j < c.length; j++) {
				let inner = c[j]
				if (inner.common) {
					result = result.concat(inner.common)
				} else {
					conflict = true
					result = result.concat(
						[aSection],
						inner.buffer1,
						[xSection],
						inner.buffer2,
						[bSection],
					)
				}
			}
		}
	})

	return {
		conflict: conflict,
		result: result,
	}
}
