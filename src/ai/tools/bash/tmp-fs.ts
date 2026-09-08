import { normalizePath, type App } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'

import { mkdirsVault } from '~/utils/mkdirs-vault'
import { BASH_TMP_MOUNT_POINT, BASH_TMP_VAULT_PATH } from './mount-points'

function getBashTmpAdapterRoot() {
	return normalizePath(BASH_TMP_VAULT_PATH)
}

export { BASH_TMP_MOUNT_POINT }

export async function existsBashTmpPath(app: App, absolutePath: string) {
	return app.vault.adapter.exists(resolveBashTmpAdapterPath(absolutePath))
}

export function resolveBashTmpAdapterPath(absolutePath: string) {
	const normalized = pathPosix.normalize(absolutePath)
	if (
		normalized !== BASH_TMP_MOUNT_POINT &&
		!normalized.startsWith(`${BASH_TMP_MOUNT_POINT}/`)
	) {
		throw new Error(
			`Path must be inside ${BASH_TMP_MOUNT_POINT}: ${absolutePath}`,
		)
	}
	const relativePath = normalized.slice(BASH_TMP_MOUNT_POINT.length + 1)
	return normalizePath(
		relativePath
			? `${getBashTmpAdapterRoot()}/${relativePath}`
			: getBashTmpAdapterRoot(),
	)
}

export async function writeBashTmpText(
	app: App,
	absolutePath: string,
	content: string,
) {
	const adapterPath = resolveBashTmpAdapterPath(absolutePath)
	await mkdirsVault(app.vault, pathPosix.dirname(adapterPath))
	await app.vault.adapter.write(adapterPath, content)
}

export async function writeBashTmpBinary(
	app: App,
	absolutePath: string,
	content: Uint8Array,
) {
	const adapterPath = resolveBashTmpAdapterPath(absolutePath)
	await mkdirsVault(app.vault, pathPosix.dirname(adapterPath))
	await app.vault.adapter.writeBinary(
		adapterPath,
		Uint8Array.from(content).buffer,
	)
}
