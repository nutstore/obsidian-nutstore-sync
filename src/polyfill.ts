const _process = globalThis.process ?? {
	cwd() {
		return '/'
	},
}

globalThis.process = _process
