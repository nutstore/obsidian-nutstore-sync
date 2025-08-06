import { isAbsolute, join } from 'path-browserify'

export default function remotePathToAbsolute(
	remoteBaseDir: string,
	remotePath: string,
): string {
	return isAbsolute(remotePath) ? remotePath : join(remoteBaseDir, remotePath)
}
