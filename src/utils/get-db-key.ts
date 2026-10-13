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

/**
 * Version of the persisted `TraverseWebDAVCache` shape. It is part of the key,
 * so builds that do not understand a newer shape never see it: a reader that
 * ignores `pendingVerification` would treat a suspended traversal as complete
 * and infer remote deletions. Bump on any incompatible cache change.
 *
 * - 2: `pendingVerification` makes an empty `queue` insufficient for completeness.
 */
export const TRAVERSAL_CACHE_SCHEMA = 2

export async function getTraversalWebDAVDBKey(
	remoteAccountId: string,
	remoteEndpoint: string,
	remoteBaseDir: string,
) {
	return objectHash({
		remoteEndpoint,
		accountHash: await sha256Hex(new TextEncoder().encode(remoteAccountId)),
		remoteBaseDir: normalizeVaultPath(remoteBaseDir),
		schema: TRAVERSAL_CACHE_SCHEMA,
	})
}
