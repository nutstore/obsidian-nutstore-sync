const ERROR_MESSAGE = 'Invalid response: 503 Service Unavailable'

export function is503Error(err: Error | string) {
	if (err instanceof Error) {
		return err.message === ERROR_MESSAGE
	}
	return err === ERROR_MESSAGE
}
