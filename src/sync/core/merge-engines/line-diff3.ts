/**
 * Linear-space Patience + bidirectional Myers line diff and three-way merge.
 *
 * Replaces `node-diff3` (whose naive Hunt-Szymanski LCS degrades to O(N^3) on
 * files with repeated blank lines and whose `push(...arr)` spreads overflow
 * the call stack on large files in mobile WebViews).
 */

const MAX_MYERS_D = 2048
const MAX_PATIENCE_DEPTH = 64
const MAX_MYERS_FALLBACKS = 16

export type DiffCommRegion =
	| { common: string[]; buffer1?: never; buffer2?: never }
	| { common?: never; buffer1: string[]; buffer2: string[] }

export interface DiffCommOptions {
	/** Predicate controlling which unique lines may act as Patience anchors. */
	canAnchor?: (line: string) => boolean
}

const defaultCanAnchor = (line: string): boolean => line.trim() !== ''

export interface MergeDiff3Options {
	excludeFalseConflicts?: boolean
	stringSeparator?: string | RegExp
	label?: {
		a?: string
		o?: string
		b?: string
	}
}

interface DiffHunk {
	ab: 'a' | 'b'
	oStart: number
	oLength: number
	abStart: number
	abLength: number
}

interface MatchCollector {
	a: number[]
	b: number[]
}

function appendRange(
	target: string[],
	source: readonly string[],
	start: number,
	end: number,
): void {
	for (let i = start; i < end; i += 1) {
		target.push(source[i])
	}
}

function rangesEqual(
	left: readonly string[],
	leftStart: number,
	leftEnd: number,
	right: readonly string[],
	rightStart: number,
	rightEnd: number,
): boolean {
	const len = leftEnd - leftStart
	if (len !== rightEnd - rightStart) return false
	for (let i = 0; i < len; i += 1) {
		if (left[leftStart + i] !== right[rightStart + i]) return false
	}
	return true
}

type DiffTask =
	| {
			kind: 'slice'
			aStart: number
			aEnd: number
			bStart: number
			bEnd: number
			patienceDepth: number
	  }
	| { kind: 'match'; aStart: number; bStart: number; length: number }

type MyersSplit =
	| {
			kind: 'snake'
			leftAEnd: number
			leftBEnd: number
			snakeA: number
			snakeB: number
			snakeLen: number
			rightAStart: number
			rightBStart: number
	  }
	| { kind: 'fallback'; splitA: number; splitB: number }

/**
 * Finds unique lines present in both slices and computes their Longest
 * Increasing Subsequence (Patience anchors) in O(U log U).
 */
function findPatienceAnchors(
	a: readonly string[],
	aStart: number,
	aEnd: number,
	b: readonly string[],
	bStart: number,
	bEnd: number,
	canAnchor: (line: string) => boolean,
): Array<{ aIndex: number; bIndex: number }> {
	const aUnique = new Map<string, number>()
	for (let i = aStart; i < aEnd; i += 1) {
		const line = a[i]
		if (!canAnchor(line)) continue
		aUnique.set(line, aUnique.has(line) ? -1 : i)
	}

	const bUnique = new Map<string, number>()
	for (let j = bStart; j < bEnd; j += 1) {
		const line = b[j]
		if (aUnique.has(line)) {
			bUnique.set(line, bUnique.has(line) ? -1 : j)
		}
	}

	const pairs: Array<{ aIndex: number; bIndex: number }> = []
	for (let i = aStart; i < aEnd; i += 1) {
		const line = a[i]
		if (aUnique.get(line) !== i) continue
		const j = bUnique.get(line)
		if (j !== undefined && j !== -1) {
			pairs.push({ aIndex: i, bIndex: j })
		}
	}

	if (pairs.length <= 1) return pairs

	// Standard O(U log U) patience LIS over bIndex
	const tailPairIdx: number[] = []
	const tailBValues: number[] = []
	const prevPairIdx = new Int32Array(pairs.length).fill(-1)

	for (let idx = 0; idx < pairs.length; idx += 1) {
		const bVal = pairs[idx].bIndex
		let lo = 0
		let hi = tailBValues.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (tailBValues[mid] < bVal) lo = mid + 1
			else hi = mid
		}
		if (lo > 0) prevPairIdx[idx] = tailPairIdx[lo - 1]
		tailPairIdx[lo] = idx
		tailBValues[lo] = bVal
	}

	const anchors: Array<{ aIndex: number; bIndex: number }> = []
	for (
		let cur = tailPairIdx[tailPairIdx.length - 1];
		cur !== -1;
		cur = prevPairIdx[cur]
	) {
		anchors.push(pairs[cur])
	}
	anchors.reverse()
	return anchors
}

/**
 * Linear-space bidirectional Myers (Hirschberg) split on unstripped slices.
 * Caps half-edit-distance search at `MAX_MYERS_D` so completely rewritten large
 * segments fail fast in bounded memory/time instead of hanging the main thread.
 * When capped without meeting, optionally splits at the frontier point that
 * matched the most lines so distant edits do not discard valid repeated matches.
 */
function findMyersSplit(
	a: readonly string[],
	aStart: number,
	aEnd: number,
	b: readonly string[],
	bStart: number,
	bEnd: number,
	allowFallback: boolean,
): MyersSplit | null {
	const n = aEnd - aStart
	const m = bEnd - bStart
	if (n <= 0 || m <= 0) return null
	if (n === 1 && m === 1) {
		if (a[aStart] === b[bStart]) {
			return {
				kind: 'snake',
				leftAEnd: aStart,
				leftBEnd: bStart,
				snakeA: aStart,
				snakeB: bStart,
				snakeLen: 1,
				rightAStart: aEnd,
				rightBStart: bEnd,
			}
		}
		return null
	}

	const maxD = Math.ceil((n + m) / 2)
	const limit = Math.min(maxD, MAX_MYERS_D)
	const delta = n - m
	const odd = (delta & 1) !== 0
	const offset = limit + 1
	const size = 2 * limit + 3
	const vf = new Int32Array(size).fill(-1)
	const vb = new Int32Array(size).fill(-1)
	vf[offset] = 0
	vb[offset] = 0

	for (let d = 1; d <= limit; d += 1) {
		// Forward pass
		for (let k = -d; k <= d; k += 2) {
			const topX = k < d ? vf[offset + k + 1] : -1
			const leftX = k > -d ? vf[offset + k - 1] : -1
			const topOk = topX >= 0 && topX <= n && topX - k >= 0 && topX - k <= m
			const leftOk =
				leftX >= 0 && leftX + 1 <= n && leftX + 1 - k >= 0 && leftX + 1 - k <= m

			if (!topOk && !leftOk) {
				vf[offset + k] = -1
				continue
			}

			let prevX: number
			let prevY: number
			let x0: number
			let y0: number
			if (topOk && (!leftOk || leftX < topX)) {
				prevX = topX
				prevY = topX - (k + 1)
				x0 = topX
				y0 = x0 - k
			} else {
				prevX = leftX
				prevY = leftX - (k - 1)
				x0 = leftX + 1
				y0 = x0 - k
			}

			let x = x0
			let y = y0
			while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
				x += 1
				y += 1
			}
			vf[offset + k] = x

			if (odd) {
				const c = delta - k
				if (c >= -(d - 1) && c <= d - 1) {
					const u = vb[offset + c]
					if (u >= 0 && x + u >= n) {
						return {
							kind: 'snake',
							leftAEnd: aStart + prevX,
							leftBEnd: bStart + prevY,
							snakeA: aStart + x0,
							snakeB: bStart + y0,
							snakeLen: x - x0,
							rightAStart: aStart + x,
							rightBStart: bStart + y,
						}
					}
				}
			}
		}

		// Backward pass
		for (let c = -d; c <= d; c += 2) {
			const topU = c < d ? vb[offset + c + 1] : -1
			const leftU = c > -d ? vb[offset + c - 1] : -1
			const topOk = topU >= 0 && topU <= n && topU - c >= 0 && topU - c <= m
			const leftOk =
				leftU >= 0 && leftU + 1 <= n && leftU + 1 - c >= 0 && leftU + 1 - c <= m

			if (!topOk && !leftOk) {
				vb[offset + c] = -1
				continue
			}

			let prevU: number
			let prevV: number
			let u0: number
			let v0: number
			if (topOk && (!leftOk || leftU < topU)) {
				prevU = topU
				prevV = topU - (c + 1)
				u0 = topU
				v0 = u0 - c
			} else {
				prevU = leftU
				prevV = leftU - (c - 1)
				u0 = leftU + 1
				v0 = u0 - c
			}

			let u = u0
			let v = v0
			while (u < n && v < m && a[aEnd - 1 - u] === b[bEnd - 1 - v]) {
				u += 1
				v += 1
			}
			vb[offset + c] = u

			if (!odd) {
				const k = delta - c
				if (k >= -d && k <= d) {
					const x = vf[offset + k]
					if (x >= 0 && x + u >= n) {
						return {
							kind: 'snake',
							leftAEnd: aStart + n - u,
							leftBEnd: bStart + m - v,
							snakeA: aStart + n - u,
							snakeB: bStart + m - v,
							snakeLen: u - u0,
							rightAStart: aStart + n - prevU,
							rightBStart: bStart + m - prevV,
						}
					}
				}
			}
		}
	}

	if (!allowFallback) return null

	let bestForwardScore = 0
	let bestX = 0
	let bestY = 0
	for (let k = -limit; k <= limit; k += 2) {
		const x = vf[offset + k]
		const y = x - k
		if (x >= 0 && x <= n && y >= 0 && y <= m && (x < n || y < m)) {
			const score = x + y - limit
			if (score > bestForwardScore) {
				bestForwardScore = score
				bestX = x
				bestY = y
			}
		}
	}

	let bestBackwardScore = 0
	let bestU = 0
	let bestV = 0
	for (let c = -limit; c <= limit; c += 2) {
		const u = vb[offset + c]
		const v = u - c
		if (u >= 0 && u <= n && v >= 0 && v <= m && (u < n || v < m)) {
			const score = u + v - limit
			if (score > bestBackwardScore) {
				bestBackwardScore = score
				bestU = u
				bestV = v
			}
		}
	}

	if (bestForwardScore === 0 && bestBackwardScore === 0) return null
	if (bestForwardScore >= bestBackwardScore) {
		return {
			kind: 'fallback',
			splitA: aStart + bestX,
			splitB: bStart + bestY,
		}
	}
	return { kind: 'fallback', splitA: aEnd - bestU, splitB: bEnd - bestV }
}

function computeLineMatches(
	buffer1: readonly string[],
	buffer2: readonly string[],
	canAnchor: (line: string) => boolean = defaultCanAnchor,
): MatchCollector {
	const matches: MatchCollector = { a: [], b: [] }
	const stack: DiffTask[] = [
		{
			kind: 'slice',
			aStart: 0,
			aEnd: buffer1.length,
			bStart: 0,
			bEnd: buffer2.length,
			patienceDepth: 0,
		},
	]
	let fallbacksRemaining = MAX_MYERS_FALLBACKS

	while (stack.length > 0) {
		const task = stack.pop()!
		if (task.kind === 'match') {
			for (let s = 0; s < task.length; s += 1) {
				matches.a.push(task.aStart + s)
				matches.b.push(task.bStart + s)
			}
			continue
		}

		let { aStart, aEnd, bStart, bEnd } = task
		const { patienceDepth } = task

		while (
			aStart < aEnd &&
			bStart < bEnd &&
			buffer1[aStart] === buffer2[bStart]
		) {
			matches.a.push(aStart)
			matches.b.push(bStart)
			aStart += 1
			bStart += 1
		}

		let suffixLen = 0
		while (
			aEnd > aStart &&
			bEnd > bStart &&
			buffer1[aEnd - 1] === buffer2[bEnd - 1]
		) {
			aEnd -= 1
			bEnd -= 1
			suffixLen += 1
		}

		if (suffixLen > 0) {
			stack.push({
				kind: 'match',
				aStart: aEnd,
				bStart: bEnd,
				length: suffixLen,
			})
		}

		if (aStart >= aEnd || bStart >= bEnd) continue
		if (aEnd - aStart === 1 && bEnd - bStart === 1) continue

		if (patienceDepth < MAX_PATIENCE_DEPTH) {
			const anchors = findPatienceAnchors(
				buffer1,
				aStart,
				aEnd,
				buffer2,
				bStart,
				bEnd,
				canAnchor,
			)
			if (anchors.length > 0) {
				const lastAnchor = anchors[anchors.length - 1]
				if (lastAnchor.aIndex + 1 < aEnd && lastAnchor.bIndex + 1 < bEnd) {
					stack.push({
						kind: 'slice',
						aStart: lastAnchor.aIndex + 1,
						aEnd,
						bStart: lastAnchor.bIndex + 1,
						bEnd,
						patienceDepth: patienceDepth + 1,
					})
				}
				for (let idx = anchors.length - 1; idx >= 0; idx -= 1) {
					const anchor = anchors[idx]
					const prevA = idx > 0 ? anchors[idx - 1].aIndex + 1 : aStart
					const prevB = idx > 0 ? anchors[idx - 1].bIndex + 1 : bStart
					stack.push({
						kind: 'match',
						aStart: anchor.aIndex,
						bStart: anchor.bIndex,
						length: 1,
					})
					if (prevA < anchor.aIndex && prevB < anchor.bIndex) {
						stack.push({
							kind: 'slice',
							aStart: prevA,
							aEnd: anchor.aIndex,
							bStart: prevB,
							bEnd: anchor.bIndex,
							patienceDepth: patienceDepth + 1,
						})
					}
				}
				continue
			}
		}

		const split = findMyersSplit(
			buffer1,
			aStart,
			aEnd,
			buffer2,
			bStart,
			bEnd,
			fallbacksRemaining > 0,
		)
		if (!split) continue

		if (split.kind === 'snake') {
			const nextDepth = Math.min(patienceDepth + 1, MAX_PATIENCE_DEPTH)
			if (split.rightAStart < aEnd && split.rightBStart < bEnd) {
				stack.push({
					kind: 'slice',
					aStart: split.rightAStart,
					aEnd,
					bStart: split.rightBStart,
					bEnd,
					patienceDepth: nextDepth,
				})
			}
			if (split.snakeLen > 0) {
				stack.push({
					kind: 'match',
					aStart: split.snakeA,
					bStart: split.snakeB,
					length: split.snakeLen,
				})
			}
			if (aStart < split.leftAEnd && bStart < split.leftBEnd) {
				stack.push({
					kind: 'slice',
					aStart,
					aEnd: split.leftAEnd,
					bStart,
					bEnd: split.leftBEnd,
					patienceDepth: nextDepth,
				})
			}
		} else {
			fallbacksRemaining -= 1
			if (split.splitA < aEnd && split.splitB < bEnd) {
				stack.push({
					kind: 'slice',
					aStart: split.splitA,
					aEnd,
					bStart: split.splitB,
					bEnd,
					patienceDepth: MAX_PATIENCE_DEPTH,
				})
			}
			if (aStart < split.splitA && bStart < split.splitB) {
				stack.push({
					kind: 'slice',
					aStart,
					aEnd: split.splitA,
					bStart,
					bEnd: split.splitB,
					patienceDepth: MAX_PATIENCE_DEPTH,
				})
			}
		}
	}

	return matches
}

/**
 * Splits two line arrays into alternating `{ common }` and `{ buffer1, buffer2 }`
 * segments, preserving exact order and content of both inputs.
 */
export function diffComm(
	buffer1: readonly string[],
	buffer2: readonly string[],
	options: DiffCommOptions = {},
): DiffCommRegion[] {
	const matches = computeLineMatches(
		buffer1,
		buffer2,
		options.canAnchor ?? defaultCanAnchor,
	)
	const regions: DiffCommRegion[] = []
	let pos1 = 0
	let pos2 = 0
	let common: string[] = []

	const flushCommon = () => {
		if (common.length > 0) {
			regions.push({ common })
			common = []
		}
	}

	for (let m = 0; m < matches.a.length; m += 1) {
		const i = matches.a[m]
		const j = matches.b[m]
		if (i > pos1 || j > pos2) {
			flushCommon()
			regions.push({
				buffer1: buffer1.slice(pos1, i),
				buffer2: buffer2.slice(pos2, j),
			})
		}
		common.push(buffer1[i])
		pos1 = i + 1
		pos2 = j + 1
	}

	if (pos1 < buffer1.length || pos2 < buffer2.length) {
		flushCommon()
		regions.push({
			buffer1: buffer1.slice(pos1),
			buffer2: buffer2.slice(pos2),
		})
	}
	flushCommon()
	return regions
}

function diffIndices(
	o: readonly string[],
	ab: readonly string[],
	side: 'a' | 'b',
): DiffHunk[] {
	const matches = computeLineMatches(o, ab)
	const hunks: DiffHunk[] = []
	let posO = 0
	let posAB = 0

	for (let m = 0; m < matches.a.length; m += 1) {
		const i = matches.a[m]
		const j = matches.b[m]
		if (i > posO || j > posAB) {
			hunks.push({
				ab: side,
				oStart: posO,
				oLength: i - posO,
				abStart: posAB,
				abLength: j - posAB,
			})
		}
		posO = i + 1
		posAB = j + 1
	}

	if (posO < o.length || posAB < ab.length) {
		hunks.push({
			ab: side,
			oStart: posO,
			oLength: o.length - posO,
			abStart: posAB,
			abLength: ab.length - posAB,
		})
	}
	return hunks
}

function splitLines(
	input: string | readonly string[],
	separator: string | RegExp,
): readonly string[] {
	return typeof input === 'string' ? input.split(separator) : input
}

/**
 * Performs a 3-way merge using `o` as the common baseline, emitting Git-style
 * diff3 conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) when
 * both sides diverge on an overlapping baseline region.
 */
export function mergeDiff3(
	aInput: string | readonly string[],
	oInput: string | readonly string[],
	bInput: string | readonly string[],
	options: MergeDiff3Options = {},
): { conflict: boolean; result: string[] } {
	const excludeFalseConflicts = options.excludeFalseConflicts ?? true
	const separator = options.stringSeparator ?? /\s+/
	const label = options.label ?? {}

	const aFull = splitLines(aInput, separator)
	const oFull = splitLines(oInput, separator)
	const bFull = splitLines(bInput, separator)

	let prefix = 0
	const minLen = Math.min(aFull.length, oFull.length, bFull.length)
	while (
		prefix < minLen &&
		aFull[prefix] === oFull[prefix] &&
		bFull[prefix] === oFull[prefix]
	) {
		prefix += 1
	}

	let aEnd = aFull.length
	let oEnd = oFull.length
	let bEnd = bFull.length
	while (
		aEnd > prefix &&
		oEnd > prefix &&
		bEnd > prefix &&
		aFull[aEnd - 1] === oFull[oEnd - 1] &&
		bFull[bEnd - 1] === oFull[oEnd - 1]
	) {
		aEnd -= 1
		oEnd -= 1
		bEnd -= 1
	}

	const result: string[] = []
	appendRange(result, aFull, 0, prefix)

	const a = aFull.slice(prefix, aEnd)
	const o = oFull.slice(prefix, oEnd)
	const b = bFull.slice(prefix, bEnd)

	const hunks = [...diffIndices(o, a, 'a'), ...diffIndices(o, b, 'b')].sort(
		(x, y) => x.oStart - y.oStart,
	)

	const aSection = '<<<<<<<' + (label.a ? ` ${label.a}` : '')
	const oSection = '|||||||' + (label.o ? ` ${label.o}` : '')
	const xSection = '======='
	const bSection = '>>>>>>>' + (label.b ? ` ${label.b}` : '')

	let conflict = false
	let currOffset = 0
	let hunkIndex = 0

	while (hunkIndex < hunks.length) {
		const first = hunks[hunkIndex++]
		const regionStart = first.oStart
		let regionEnd = first.oStart + first.oLength
		const groupEndStart = hunkIndex

		while (hunkIndex < hunks.length && hunks[hunkIndex].oStart <= regionEnd) {
			const next = hunks[hunkIndex++]
			regionEnd = Math.max(regionEnd, next.oStart + next.oLength)
		}

		if (regionStart > currOffset) {
			appendRange(result, o, currOffset, regionStart)
		}

		if (hunkIndex === groupEndStart) {
			if (first.abLength > 0) {
				const buf = first.ab === 'a' ? a : b
				appendRange(result, buf, first.abStart, first.abStart + first.abLength)
			}
		} else {
			let aMinStart = a.length
			let aMaxEnd = -1
			let aMinO = o.length
			let aMaxO = -1
			let bMinStart = b.length
			let bMaxEnd = -1
			let bMinO = o.length
			let bMaxO = -1

			for (let idx = groupEndStart - 1; idx < hunkIndex; idx += 1) {
				const h = hunks[idx]
				const oS = h.oStart
				const oE = oS + h.oLength
				const abS = h.abStart
				const abE = abS + h.abLength
				if (h.ab === 'a') {
					aMinStart = Math.min(abS, aMinStart)
					aMaxEnd = Math.max(abE, aMaxEnd)
					aMinO = Math.min(oS, aMinO)
					aMaxO = Math.max(oE, aMaxO)
				} else {
					bMinStart = Math.min(abS, bMinStart)
					bMaxEnd = Math.max(abE, bMaxEnd)
					bMinO = Math.min(oS, bMinO)
					bMaxO = Math.max(oE, bMaxO)
				}
			}

			const aS = aMinStart + (regionStart - aMinO)
			const aE = aMaxEnd + (regionEnd - aMaxO)
			const bS = bMinStart + (regionStart - bMinO)
			const bE = bMaxEnd + (regionEnd - bMaxO)

			if (excludeFalseConflicts && rangesEqual(a, aS, aE, b, bS, bE)) {
				appendRange(result, a, aS, aE)
			} else {
				conflict = true
				result.push(aSection)
				appendRange(result, a, aS, aE)
				result.push(oSection)
				appendRange(result, o, regionStart, regionEnd)
				result.push(xSection)
				appendRange(result, b, bS, bE)
				result.push(bSection)
			}
		}

		currOffset = regionEnd
	}

	if (o.length > currOffset) {
		appendRange(result, o, currOffset, o.length)
	}

	appendRange(result, aFull, aEnd, aFull.length)
	return { conflict, result }
}
