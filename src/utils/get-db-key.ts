import { sha256 } from 'hash-wasm'
import { normalizePath } from 'obsidian'
import { objectHash } from 'ohash'
import { stdRemotePath } from './std-remote-path'

export function getDBKey(vaultName: string, remoteBaseDir: string) {
	return objectHash({
		vaultName,
		remoteBaseDir: stdRemotePath(remoteBaseDir),
	})
}

export async function getTraversalWebDAVDBKey(
	token: string,
	remoteBaseDir: string,
) {
	const hash = await sha256(token)
	remoteBaseDir = normalizePath(remoteBaseDir)
	return `${hash}:${remoteBaseDir}`
}
