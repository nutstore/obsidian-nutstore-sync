export function hasInvalidChar(str: string) {
	return ':*?"<>|'.split('').some((c) => str.includes(c))
}
