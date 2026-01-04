const INVALID_CHARS = ':*?"<>|'
const INVALID_CHARS_LIST = INVALID_CHARS.split('')

export function hasInvalidChar(str: string) {
	return INVALID_CHARS_LIST.some((c) => str.includes(c))
}

export function getInvalidChars(str: string): string[] {
	return INVALID_CHARS_LIST.filter((c) => str.includes(c))
}
