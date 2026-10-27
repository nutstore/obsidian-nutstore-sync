/** An incomplete snapshot must never authorize deletion or record updates. */
export class LocalScanError extends Error {
	constructor(path: string, options: ErrorOptions) {
		super(
			`Local scan incomplete at '${path}'; sync stopped before file changes.`,
			options,
		)
		this.name = 'LocalScanError'
	}
}
