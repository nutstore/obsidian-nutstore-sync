import { objectHash } from 'ohash'
import { sha256Hex } from '~/utils/sha256'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'
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
		accountHash: await sha256Hex(new TextEncoder().encode(remoteAccountId)),
		remoteBaseDir: normalizeVaultPath(remoteBaseDir),
	})
}
