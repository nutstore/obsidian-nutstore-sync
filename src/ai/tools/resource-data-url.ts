import { fromUint8Array } from 'js-base64'
import type { App } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'

import {
	BUILTIN_SKILLS_MOUNT_POINT,
	SETTINGS_MOUNT_POINT,
} from './bash/mount-points'

export async function resolveResourceDataUrl(
	app: App,
	path: string,
	mediaType: string,
) {
	const normalizedPath = pathPosix.normalize(path)
	if (
		!normalizedPath.startsWith('/') ||
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
	return `data:${mediaType};base64,${fromUint8Array(new Uint8Array(data), false)}`
}
