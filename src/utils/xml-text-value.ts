/** Extracts primitive XML text content safely without stringifying object nodes. */
export function xmlTextValue(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value)
	return fallback
}
