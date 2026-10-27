import type { App } from 'obsidian'
import { bytesToDataUrl } from '~/utils/data-url'

import {
	BUILTIN_SKILLS_MOUNT_POINT,
	SETTINGS_MOUNT_POINT,
} from './bash/mount-points'
import { normalizeVirtualPath } from './bash/virtual-path'

export async function resolveResourceDataUrl(
	app: App,
	path: string,
	mediaType: string,
) {
	const normalizedPath = normalizeVirtualPath(path)
	if (
		normalizedPath === '/' ||
		normalizedPath === SETTINGS_MOUNT_POINT ||
		normalizedPath.startsWith(`${SETTINGS_MOUNT_POINT}/`) ||
		normalizedPath === BUILTIN_SKILLS_MOUNT_POINT ||
		normalizedPath.startsWith(`${BUILTIN_SKILLS_MOUNT_POINT}/`)
	) {
		return undefined
	}
	const adapterPath = normalizedPath.slice(1)
	const data = await app.vault.adapter.readBinary(adapterPath)
	return bytesToDataUrl(mediaType, data)
}
