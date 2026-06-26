import { APICallError } from 'ai'

export function extractErrorMessage(error: unknown, fallback: string): string {
	if (APICallError.isInstance(error) && error.responseBody != null) {
		return typeof error.responseBody === 'string'
			? error.responseBody
			: JSON.stringify(error.responseBody)
	}
	return error instanceof Error ? error.message : fallback
}
