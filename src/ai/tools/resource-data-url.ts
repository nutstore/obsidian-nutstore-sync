import { fromUint8Array } from 'js-base64'
import type { App } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'

import { BASH_TMP_MOUNT_POINT, resolveBashTmpAdapterPath } from './bash/tmp-fs'
import { VAULT_MOUNT_POINT } from './vault-filesystem'

export async function resolveResourceDataUrl(
	app: App,
	path: string,
	mediaType: string,
) {
	const normalizedPath = pathPosix.normalize(path)
	let adapterPath: string
	if (normalizedPath.startsWith(`${VAULT_MOUNT_POINT}/`)) {
		adapterPath = normalizedPath.slice(VAULT_MOUNT_POINT.length + 1)
	} else if (normalizedPath.startsWith(`${BASH_TMP_MOUNT_POINT}/`)) {
		adapterPath = resolveBashTmpAdapterPath(normalizedPath)
	} else {
		return undefined
	}
	const data = await app.vault.adapter.readBinary(adapterPath)
	return `data:${mediaType};base64,${fromUint8Array(new Uint8Array(data), false)}`
}
