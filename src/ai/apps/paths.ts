import { z } from 'zod/mini'

/** App source trees are plain vault directories; the directory name is the identity. */
export const APP_ROOT_DIR = '.agents/nutstore-sync/apps'
export const APP_MANIFEST_FILE = 'manifest.json'
export const APP_ENTRY_FILE = 'index.html'
export const APP_DATA_FILE = 'data.json'
export const APP_LOG_FILE = 'logs.jsonl'
export const APP_STATE_FILE = 'state.json'
/** Host-owned files: App code reads them, but can never write, rename or delete. */
export const APP_HOST_FILES = [
	APP_DATA_FILE,
	APP_LOG_FILE,
	APP_STATE_FILE,
] as const
/** App identity is a stable lowercase reverse-domain name, independent of revisions. */
export const appIdSchema = z
	.string()
	.check(z.maxLength(100), z.regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/))
export function appDirectoryPath(id: string): string {
	return `${APP_ROOT_DIR}/${appIdSchema.parse(id)}`
}
/** Map a vault path to its App id; an empty string denotes the Apps root itself. */
export function appIdFromPath(vaultPath: string): string | undefined {
	const normalized = vaultPath.replace(/^\/+/, '').replace(/\/+$/, '')
	if (normalized === APP_ROOT_DIR) return ''
	const prefix = `${APP_ROOT_DIR}/`
	if (!normalized.startsWith(prefix)) return undefined
	const id = normalized.slice(prefix.length).split('/')[0] ?? ''
	return appIdSchema.safeParse(id).success ? id : undefined
}
/** True for KV, diagnostics and state files that only the host may mutate. */
export function isHostFileName(fileName: string): boolean {
	return (APP_HOST_FILES as readonly string[]).includes(fileName)
}
/** The Apps root or one App directory itself; its lifecycle belongs to the host UI. */
export function isAppDirectoryPath(vaultPath: string): boolean {
	const id = appIdFromPath(vaultPath)
	if (id === undefined) return false
	const normalized = vaultPath.replace(/^\/+/, '').replace(/\/+$/, '')
	return normalized === APP_ROOT_DIR || normalized === `${APP_ROOT_DIR}/${id}`
}
export function isReservedAppPath(vaultPath: string): boolean {
	const id = appIdFromPath(vaultPath)
	if (!id) return false
	const normalized = vaultPath.replace(/^\/+/, '').replace(/\/+$/, '')
	const rest = normalized.slice(`${APP_ROOT_DIR}/${id}/`.length)
	return isHostFileName(rest)
}
