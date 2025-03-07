import path from 'path'

export function stdRemotePath(remoteBaseDir: string): `/${string}` {
	if (remoteBaseDir.startsWith('/')) {
		return path.resolve(remoteBaseDir) as `/${string}`
	}
	return `/${remoteBaseDir}`
}
