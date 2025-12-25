import types from './types'

export function lookupMimeByExtname(ext: string) {
	ext = ext.trim()
	if (ext.startsWith('.')) {
		ext = ext.substring(1)
	}
	for (const k in types) {
		const mime = k as keyof typeof types
		const v = types[mime]
		if (v.indexOf(ext) !== -1) {
			return mime
		}
	}
	return null
}
