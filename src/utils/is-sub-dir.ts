import { relative, resolve } from 'path'

export function isSubDir(parent: string, sub: string): boolean {
	const absParent = resolve(parent)
	const absSub = resolve(sub)
	return (
		relative(absParent, absSub).startsWith('..') === false &&
		absSub !== absParent
	)
}
