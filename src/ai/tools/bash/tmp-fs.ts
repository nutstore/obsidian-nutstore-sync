import { normalizePath, type App } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'

import { mkdirsVault } from '~/utils/mkdirs-vault'
import { ObsidianAdapterFs } from '~/ai/tools/bash/adapter-fs'

export const BASH_TMP_MOUNT_POINT = '/tmp'

function getBashTmpAdapterRoot(app: App) {
	return normalizePath(
		`${app.vault.configDir}/plugins/nutstore-sync/cache/fs/tmp`,
	)
}

export async function createBashTmpFs(app: App) {
	await mkdirsVault(app.vault, getBashTmpAdapterRoot(app))
	return ObsidianAdapterFs.create(app.vault.adapter, getBashTmpAdapterRoot(app))
}

function resolveBashTmpAdapterPath(app: App, absolutePath: string) {
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
			? `${getBashTmpAdapterRoot(app)}/${relativePath}`
			: getBashTmpAdapterRoot(app),
	)
}

export async function writeBashTmpText(
	app: App,
	absolutePath: string,
	content: string,
) {
	const adapterPath = resolveBashTmpAdapterPath(app, absolutePath)
	await mkdirsVault(app.vault, pathPosix.dirname(adapterPath))
	await app.vault.adapter.write(adapterPath, content)
}
