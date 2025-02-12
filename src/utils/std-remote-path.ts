import path from 'path'

export function stdRemotePath(remoteBaseDir: string) {
	if (remoteBaseDir.startsWith('/')) {
		return path.resolve(remoteBaseDir)
	}
	return `/${remoteBaseDir}`
}
