/**
 * Fuzzy subsequence matcher.
 * Matches if all characters of query appear in target in order,
 */
export function isFuzzySubsequenceMatch(
	query: string,
	target: string,
): boolean {
	const sanitizedQuery = query.replace(/\s+/g, '').toLowerCase()
	if (!sanitizedQuery) return true
	if (!target) return false

	const qChars = Array.from(sanitizedQuery)
	const tChars = Array.from(target.toLowerCase())

	let qIdx = 0
	let tIdx = 0

	while (qIdx < qChars.length && tIdx < tChars.length) {
		if (qChars[qIdx] === tChars[tIdx]) {
			qIdx++
		}
		tIdx++
	}

	return qIdx === qChars.length
}
