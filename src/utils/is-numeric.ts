export function isNumeric(value: unknown): boolean {
	if (typeof value !== 'number' && typeof value !== 'string') return false
	return (
		!Number.isNaN(Number.parseFloat(String(value))) &&
		Number.isFinite(Number(value))
	)
}
