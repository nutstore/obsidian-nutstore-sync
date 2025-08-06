export function isSameTime(
	timestamp1: Date | number | undefined,
	timestamp2: Date | number | undefined,
): boolean {
	// If either timestamp is undefined, they are not the same
	if (timestamp1 === undefined || timestamp2 === undefined) {
		return false
	}

	const time1 =
		typeof timestamp1 === 'number' ? timestamp1 : timestamp1.getTime()
	const time2 =
		typeof timestamp2 === 'number' ? timestamp2 : timestamp2.getTime()

	return time1 === time2
}
