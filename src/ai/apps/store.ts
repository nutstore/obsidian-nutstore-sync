import { z } from 'zod/mini'
import type { App } from 'obsidian'
import { dirname } from 'path-browserify'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import {
	onLocalPathChanged,
	readLocalText,
	removeLocalPath,
	writeLocalTextAtomic,
} from '~/utils/local-vault-io'
import {
	APP_DATA_FILE,
	APP_LOG_FILE,
	APP_MANIFEST_FILE,
	APP_ROOT_DIR,
	APP_STATE_FILE,
	appDirectoryPath,
	appIdFromPath,
} from './paths'
import {
	appManifestSchema,
	emptyAppManifest,
	type AppManifest,
} from './manifest'
import {
	appDataFileSchema,
	changeKV,
	validateKV,
	type AppKV,
	type KVChange,
} from './capabilities/kv'

export const appStateSchema = z.object({
	schemaVersion: z.literal(1),
	pinned: z.boolean(),
	createdAt: z.number(),
	updatedAt: z.number(),
})
export type AppState = z.infer<typeof appStateSchema>
export interface SavedApp {
	id: string
	manifest: AppManifest
	state: AppState
}
export function newAppState(now = Date.now()): AppState {
	return { schemaVersion: 1, pinned: false, createdAt: now, updatedAt: now }
}

async function readJson(vault: App['vault'], path: string): Promise<unknown> {
	return JSON.parse(await readLocalText(vault, path))
}

async function writeJson(vault: App['vault'], path: string, value: unknown) {
	await mkdirsVault(vault, dirname(path))
	await writeLocalTextAtomic(vault, path, JSON.stringify(value, null, 2))
}

/**
 * Apps are plain vault directories. The store owns host state (`state.json`),
 * App data (`data.json`) and validation; source files are read and assembled by
 * `AppWorkspaces`. One queue per App serializes host-state read-modify-write.
 */
export class AppStore {
	private readonly queues = new Map<string, Promise<unknown>>()
	private readonly listeners = new Set<(appId?: string) => void>()
	private unsubscribeLocalPaths?: () => void

	constructor(private readonly app: Pick<App, 'vault' | 'fileManager'>) {}

	/** Notify on source/state changes; host data writes never cause a reload. */
	subscribe(listener: (appId?: string) => void) {
		if (!this.unsubscribeLocalPaths) {
			this.unsubscribeLocalPaths = onLocalPathChanged((path) => {
				const appId = appIdFromPath(path)
				if (!appId) return
				const normalized = path.replace(/^\/+/, '')
				const relative = normalized.slice(`${APP_ROOT_DIR}/${appId}/`.length)
				// Only the App-root host files are silent; a nested source file
				// that happens to share a host file name still reloads.
				if (relative === APP_DATA_FILE || relative === APP_LOG_FILE) return
				this.notify(appId)
			})
		}
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
			if (!this.listeners.size) {
				this.unsubscribeLocalPaths?.()
				this.unsubscribeLocalPaths = undefined
			}
		}
	}

	private notify(appId?: string) {
		for (const listener of this.listeners) listener(appId)
	}

	private directory(id: string) {
		return appDirectoryPath(id)
	}

	private file(id: string, name: string) {
		return `${this.directory(id)}/${name}`
	}

	private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
		const next = (this.queues.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(action)
		this.queues.set(id, next)
		void next
			.finally(() => {
				if (this.queues.get(id) === next) this.queues.delete(id)
			})
			.catch(() => {})
		return next
	}

	async exists(id: string) {
		return this.app.vault.adapter.exists(this.file(id, APP_MANIFEST_FILE))
	}

	async readManifest(id: string): Promise<AppManifest> {
		const path = this.file(id, APP_MANIFEST_FILE)
		try {
			return appManifestSchema.parse(await readJson(this.app.vault, path))
		} catch (error) {
			throw new Error(`Invalid App manifest: ${path}`, { cause: error })
		}
	}

	async readState(id: string): Promise<AppState> {
		const path = this.file(id, APP_STATE_FILE)
		if (!(await this.app.vault.adapter.exists(path))) {
			// Authoring agents may create an App directory from files; first use
			// materializes the host-owned state instead of failing the App.
			const state = newAppState()
			await writeJson(this.app.vault, path, state)
			return state
		}
		try {
			return appStateSchema.parse(await readJson(this.app.vault, path))
		} catch (error) {
			throw new Error(`Invalid App state: ${path}`, { cause: error })
		}
	}

	async read(id: string): Promise<SavedApp> {
		const [manifest, state] = await Promise.all([
			this.readManifest(id),
			this.readState(id),
		])
		return { id, manifest, state }
	}

	async list(): Promise<Array<{ id: string; app?: SavedApp; error?: string }>> {
		if (!(await this.app.vault.adapter.exists(APP_ROOT_DIR))) return []
		const { folders } = await this.app.vault.adapter.list(APP_ROOT_DIR)
		const apps = await Promise.all(
			folders.map(
				async (
					folder,
				): Promise<
					{ id: string; app?: SavedApp; error?: string } | undefined
				> => {
					const id = folder.split('/').pop() ?? ''
					try {
						if (!(await this.exists(id))) return undefined
						return { id, app: await this.read(id) }
					} catch (error) {
						return {
							id,
							error: error instanceof Error ? error.message : String(error),
						}
					}
				},
			),
		)
		return apps.filter(
			(item): item is { id: string; app?: SavedApp; error?: string } =>
				item !== undefined,
		)
	}

	async create(id: string, title: string): Promise<SavedApp> {
		return this.serial(id, async () => {
			if (await this.exists(id)) throw new Error(`App already exists: ${id}`)
			const manifest = emptyAppManifest(title)
			const state = newAppState()
			// The manifest is the commit point; write host state first so a
			// partially created App never appears in listings.
			await writeJson(this.app.vault, this.file(id, APP_STATE_FILE), state)
			await writeJson(
				this.app.vault,
				this.file(id, APP_MANIFEST_FILE),
				manifest,
			)
			return { id, manifest, state }
		})
	}

	async setPinned(id: string, pinned: boolean) {
		return this.serial(id, async () => {
			const state = await this.readState(id)
			await writeJson(this.app.vault, this.file(id, APP_STATE_FILE), {
				...state,
				pinned,
				updatedAt: Date.now(),
			})
		})
	}

	async readKV(id: string): Promise<AppKV> {
		const path = this.file(id, APP_DATA_FILE)
		if (!(await this.app.vault.adapter.exists(path))) return {}
		try {
			const data = appDataFileSchema.parse(await readJson(this.app.vault, path))
			return validateKV(data.kv)
		} catch (error) {
			throw new Error(`Invalid App data: ${path}`, { cause: error })
		}
	}

	async transact(id: string, changes: KVChange[]) {
		return this.serial(id, async () => {
			const kv = changeKV(await this.readKV(id), changes)
			await writeJson(this.app.vault, this.file(id, APP_DATA_FILE), {
				schemaVersion: 1,
				kv,
			})
		})
	}

	async remove(id: string) {
		return this.serial(id, async () => {
			await removeLocalPath(this.app, this.directory(id), true)
		})
	}

	async settle() {
		while (this.queues.size) await Promise.allSettled([...this.queues.values()])
	}
}
