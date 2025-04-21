import { normalize } from 'path'

export function stdRemotePath(remotePath: string): `/${string}/` {
	if (!remotePath.startsWith('/')) {
		remotePath = `/${remotePath}`
	}
	if (!remotePath.endsWith('/')) {
		remotePath = `${remotePath}/`
	}
	return normalize(remotePath) as `/${string}/`
}
