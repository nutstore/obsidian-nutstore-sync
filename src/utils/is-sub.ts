import { normalize } from 'path'

export function isSub(parent: string, sub: string) {
	parent = normalize(parent)
	sub = normalize(sub)
	if (!parent.endsWith('/')) {
		parent += '/'
	}
	if (!sub.endsWith('/')) {
		sub += '/'
	}
	if (sub === parent) {
		return false
	}
	return sub.startsWith(parent)
}
