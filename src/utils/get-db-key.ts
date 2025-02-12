import { objectHash } from 'ohash'

export function getDBKey(vaultName: string, remoteBaseDir: string) {
	return objectHash({
		vaultName,
		remoteBaseDir,
	})
}
