import { normalize } from 'path'

export function stdRemotePath(remoteBaseDir: string): `/${string}` {
	if (remoteBaseDir.startsWith('/')) {
		return normalize(remoteBaseDir) as `/${string}`
	}
	return `/${remoteBaseDir}`
}
