import { normalize } from 'path'

export function isSubDir(parent: string, sub: string): boolean {
	parent = normalize(parent)
	sub = normalize(sub)
	if (!parent.endsWith('/')) {
		parent = parent + '/'
	}
	return sub.startsWith(parent)
}
