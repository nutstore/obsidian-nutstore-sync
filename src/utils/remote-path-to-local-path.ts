import { normalizePath, Vault } from 'obsidian'
import { isAbsolute, relative } from 'path'

export function remotePathToLocalPath(
	vault: Vault,
	remoteBaseDir: string,
	remotePath: string,
) {
	remotePath = isAbsolute(remotePath)
		? relative(remoteBaseDir, remotePath)
		: remotePath
	return normalizePath(remotePath)
}
