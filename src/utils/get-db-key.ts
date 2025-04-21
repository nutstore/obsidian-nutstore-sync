import { objectHash } from 'ohash'
import { stdRemotePath } from './std-remote-path'

export function getDBKey(vaultName: string, remoteBaseDir: string) {
	return objectHash({
		vaultName,
		remoteBaseDir: stdRemotePath(remoteBaseDir),
	})
}
