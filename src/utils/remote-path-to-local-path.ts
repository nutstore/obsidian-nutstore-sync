import { isAbsolute, normalize } from 'path-browserify'

export function remotePathToLocalPath(
	remoteBaseDir: string,
	remotePath: string,
) {
	remoteBaseDir = normalize(remoteBaseDir)
	remotePath = normalize(remotePath)
	remotePath =
		isAbsolute(remotePath) && remotePath.startsWith(remoteBaseDir)
			? remotePath.replace(remoteBaseDir, '')
			: remotePath
	return normalize(remotePath)
}
