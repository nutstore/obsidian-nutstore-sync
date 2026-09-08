// This module initializes the plugin's WebView realm. Tests provide a window
// explicitly instead of making the production runtime depend on Node globals.
interface ProcessLike {
	cwd: () => string
	env?: Record<string, string | undefined>
}

type RuntimeWindow = Window & {
	process?: ProcessLike
}

const runtimeGlobal = window as RuntimeWindow

const processLike: ProcessLike = runtimeGlobal.process ?? {
	cwd() {
		return '/'
	},
	env: {},
}

if (typeof processLike.cwd !== 'function') {
	processLike.cwd = () => '/'
}

if (!processLike.env || typeof processLike.env !== 'object') {
	processLike.env = {}
}

runtimeGlobal.process = processLike

if (typeof runtimeGlobal.queueMicrotask !== 'function') {
	const resolvedPromise = Promise.resolve()
	runtimeGlobal.queueMicrotask = (callback: VoidFunction): void => {
		if (typeof callback !== 'function') {
			throw new TypeError('queueMicrotask callback must be a function')
		}

		void resolvedPromise.then(callback).catch((error: unknown) => {
			const reportedError =
				error instanceof Error ? error : new Error(String(error))
			runtimeGlobal.setTimeout(() => {
				throw reportedError
			}, 0)
		})
	}
}

export {}
