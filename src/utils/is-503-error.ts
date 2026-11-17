const ERROR_MESSAGE = 'Invalid response: 503 Service Unavailable'

type ServiceUnavailableError =
	(Error & { message: typeof ERROR_MESSAGE }) | typeof ERROR_MESSAGE

export function is503Error(error: unknown): error is ServiceUnavailableError {
	if (error instanceof Error) {
		return error.message === ERROR_MESSAGE
	}
	return error === ERROR_MESSAGE
}
