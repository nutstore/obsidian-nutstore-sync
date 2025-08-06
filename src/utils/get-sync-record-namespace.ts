import { getDBKey } from './get-db-key'

export function getSyncRecordNamespace(
	vaultName: string,
	remoteBaseDir: string,
) {
	return getDBKey(vaultName, remoteBaseDir)
}
