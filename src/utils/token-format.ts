/**
 * Parse token count string into integer number.
 * Supports:
 * - Pure numbers: 65536, "65536"
 * - Thousands separators: "1,048,576", "65_536"
 * - Suffixes:
 *   - "k" / "K" -> * 1,000 (e.g. 10k -> 10,000, 128k -> 128,000)
 *   - "ki" / "kib" -> * 1,024 (e.g. 64ki -> 65,536)
 *   - "m" / "M" -> * 1,000,000 (e.g. 1M -> 1,000,000, 1.5M -> 1,500,000)
 *   - "mi" / "mib" -> * 1,048,576 (e.g. 1mi -> 1,048,576)
 *   - "b" / "B" / "g" / "G" -> * 1,000,000,000
 * Returns undefined if invalid. Empty or whitespace returns 0.
 */
export function parseTokenCount(
	input: string | number | undefined | null,
): number | undefined {
	if (input === undefined || input === null) return undefined
	if (typeof input === 'number') {
		if (isNaN(input) || input < 0) return undefined
		return Math.round(input)
	}

	const trimmed = input.trim().replace(/,/g, '').replace(/_/g, '')
	if (!trimmed) return 0

	const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(trimmed)
	if (!match) return undefined

	const num = parseFloat(match[1])
	if (isNaN(num) || num < 0) return undefined

	const unit = match[2]?.toLowerCase()
	if (!unit) {
		return Math.round(num)
	}

	switch (unit) {
		case 'k':
			return Math.round(num * 1000)
		case 'ki':
		case 'kib':
			return Math.round(num * 1024)
		case 'm':
			return Math.round(num * 1000000)
		case 'mi':
		case 'mib':
			return Math.round(num * 1048576)
		case 'g':
		case 'b':
			return Math.round(num * 1000000000)
		default:
			return undefined
	}
}

/**
 * Format token count with commas for readability (e.g. 1048576 -> "1,048,576").
 */
export function formatTokenCount(tokens: number | undefined | null): string {
	if (tokens === undefined || tokens === null || tokens === 0) {
		return ''
	}
	return tokens.toLocaleString('en-US')
}
