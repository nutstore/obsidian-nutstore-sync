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
	remoteAccountId: string,
	remoteEndpoint: string,
	remoteBaseDir: string,
) {
	return objectHash({
		remoteEndpoint,
		accountHash: await sha256(remoteAccountId),
		remoteBaseDir: normalizePath(remoteBaseDir),
	})
}
