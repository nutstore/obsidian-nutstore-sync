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
 * - 3: atomic file `etag`/`revision`, `lastFullScanAt`, and scope-verified remote cache envelope.
 */
export const TRAVERSAL_CACHE_SCHEMA = 3

/** Stable SHA-256 hex digest identifying a Nutstore account across cache envelopes. */
export async function getAccountHash(remoteAccountId: string): Promise<string> {
	return await sha256Hex(new TextEncoder().encode(remoteAccountId))
}

export async function getTraversalWebDAVDBKey(
	remoteAccountId: string,
	remoteEndpoint: string,
	remoteBaseDir: string,
) {
	return objectHash({
		remoteEndpoint,
		accountHash: await getAccountHash(remoteAccountId),
		remoteBaseDir: normalizeVaultPath(remoteBaseDir),
		schema: TRAVERSAL_CACHE_SCHEMA,
	})
}
