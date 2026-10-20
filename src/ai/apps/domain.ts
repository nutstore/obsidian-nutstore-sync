import { z } from 'zod/mini'

export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type AppKV = Record<string, JsonValue>
export const MAX_KV_BYTES = 1_048_576
export const MAX_VALUE_BYTES = 262_144
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
export const APP_DEFAULT_ICON =
	'<svg viewBox="0 0 100 100"><rect x="12" y="12" width="76" height="76" rx="12" fill="none" stroke="currentColor" stroke-width="8"/></svg>'
/** App identity is a stable lowercase reverse-domain name, independent of revisions. */
export const appIdSchema = z
	.string()
	.check(z.maxLength(100), z.regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/))
export const appManifestSchema = z.object({
	schemaVersion: z.literal(1),
	title: z.string().check(z.minLength(1)),
	iconSvg: z.string().check(z.minLength(1)),
	/** V1 keeps a stable JSON data contract across code upgrades. */
	dataVersion: z.literal(1),
})
export type AppManifest = z.infer<typeof appManifestSchema>
export const appStateSchema = z.object({
	schemaVersion: z.literal(1),
	pinned: z.boolean(),
	createdAt: z.number(),
	updatedAt: z.number(),
})
export type AppState = z.infer<typeof appStateSchema>
export const appDataFileSchema = z.object({
	schemaVersion: z.literal(1),
	kv: z.record(z.string(), z.unknown()),
})
export interface SavedApp {
	id: string
	manifest: AppManifest
	state: AppState
}
/** The assembled, sandbox-ready source of one App. */
export interface AppContent {
	html: string
	css: string
	javascript: string
}
export interface LoadedApp extends SavedApp {
	content: AppContent
}
export function emptyAppManifest(title: string): AppManifest {
	return {
		schemaVersion: 1,
		title,
		iconSvg: APP_DEFAULT_ICON,
		dataVersion: 1,
	}
}
export function newAppState(now = Date.now()): AppState {
	return { schemaVersion: 1, pinned: false, createdAt: now, updatedAt: now }
}
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
/** Reject lossy JSON values, cycles and prototype keys at every storage/bridge boundary. */
export function jsonValue(value: unknown, depth = 0): JsonValue {
	if (depth > 24) throw new Error('App data nesting limit exceeded')
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value))
		return value.map((item) => jsonValue(item, depth + 1))
	if (
		value &&
		typeof value === 'object' &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => {
				validateKey(key)
				return [key, jsonValue(entry, depth + 1)]
			}),
		)
	}
	throw new Error('App data must be JSON')
}
export function validateKey(key: unknown): asserts key is string {
	if (
		typeof key !== 'string' ||
		!key.length ||
		key.length > 200 ||
		['__proto__', 'constructor', 'prototype'].includes(key)
	)
		throw new Error('Invalid App data key')
}
export function jsonBytes(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
export function validateKV(value: unknown): AppKV {
	const kv = jsonValue(value)
	if (!kv || typeof kv !== 'object' || Array.isArray(kv))
		throw new Error('App data must be a JSON object')
	if (jsonBytes(kv) > MAX_KV_BYTES)
		throw new Error('App data capacity exceeded')
	for (const entry of Object.values(kv))
		if (jsonBytes(entry) > MAX_VALUE_BYTES)
			throw new Error('App data value exceeds its limit')
	return kv
}
export interface KVChange {
	key: string
	value?: JsonValue
	delete?: boolean
}
export function changeKV(previous: AppKV, changes: KVChange[]): AppKV {
	if (!changes.length || changes.length > 100)
		throw new Error('Invalid App data transaction')
	const next = { ...previous }
	for (const change of changes) {
		validateKey(change.key)
		if (change.delete) delete next[change.key]
		else {
			const value = jsonValue(change.value)
			if (jsonBytes(value) > MAX_VALUE_BYTES)
				throw new Error('App data value exceeds its limit')
			next[change.key] = value
		}
	}
	if (jsonBytes(next) > MAX_KV_BYTES)
		throw new Error('App data capacity exceeded')
	return next
}
