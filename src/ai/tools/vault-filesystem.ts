import type { IFileSystem } from 'just-bash/browser'
import { normalizePath, type App } from 'obsidian'
import { AppFs } from '~/ai/apps/fs'
import type { AppLifecycle } from '~/ai/apps/lifecycle'
import type { AppOpenFn, AppWorkspaceBinding } from '~/ai/apps/workspaces'
import { createBuiltinSkillsFs } from '~/ai/skills/builtin'
import { listAvailableAdapterEntries } from '~/ai/tools/available-adapter-entries'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { createAppCommands } from './bash/app'
import {
	NOOP_VAULT_PATH_INDEX,
	ObsidianVaultFs,
	ReversibleOpRecorder,
} from './bash/fs'
import { MountableFs } from './bash/mountable-fs'
import {
	APPS_MOUNT_POINT,
	AGENTS_MOUNT_POINT,
	AGENTS_VAULT_PATH,
	BUILTIN_SKILLS_MOUNT_POINT,
	getConfigDirMountPoint,
	SETTINGS_MOUNT_POINT,
} from './bash/mount-points'
import { ReversibleFs } from './bash/reversible-fs'
import { SettingsFs } from './settings-fs'
import type { SettingsSnapshotFn, SettingsUpdater } from './tool-context'

export interface CreateVaultFileSystemOptions {
	permissionGuard?: PermissionGuard
	recorder?: ReversibleOpRecorder
	onRead?: (vaultPath: string) => void
	getSettingsSnapshot?: SettingsSnapshotFn
	updateSettings?: SettingsUpdater
	fileSystemManager?: VaultFileSystemManager
	appWorkspaceBinding?: AppWorkspaceBinding
	appLifecycle?: AppLifecycle
	openApp?: AppOpenFn
	readonlyApps?: boolean
	/**
	 * Seed the synchronous `getAllPaths()` index from the Vault and `.agents/`.
	 * Defaults to `true` for callers that inspect `getAllPaths()`; direct-path
	 * tools (`apply_patch`, `bash`, `view_image`, `memory`, etc.) pass `false`
	 * because they never query `getAllPaths()` (Bash globs use live
	 * `readdirWithFileTypes`).
	 */
	includePathIndex?: boolean
}

interface SharedVaultFileSystem {
	builtinSkillsFs: IFileSystem
}

/**
 * Seed the synchronous path snapshot from Obsidian's loaded vault files and
 * the hidden agent domain. Other hidden paths stay out of this snapshot.
 * Bash globs enumerate directories through readdirWithFileTypes instead.
 */
async function getInitialVaultPaths(app: App) {
	const paths = app.vault.getAllLoadedFiles().map((file) => file.path)
	const agents = await listAgentDomainPaths(app)
	return [...new Set([...paths, ...agents])]
}

async function listAgentDomainPaths(app: App) {
	const paths: string[] = []
	let frontier = [AGENTS_VAULT_PATH]
	while (frontier.length > 0) {
		const results = await Promise.all(
			frontier.map(async (directory) => {
				try {
					return await listAvailableAdapterEntries(app.vault.adapter, directory)
				} catch {
					// A missing agent domain directory simply contributes nothing.
					return undefined
				}
			}),
		)
		const nextFrontier: string[] = []
		for (const listed of results) {
			if (!listed) continue
			for (const path of listed.files) {
				paths.push(normalizePath(path))
			}
			for (const path of listed.folders) {
				const normalized = normalizePath(path)
				paths.push(normalized)
				nextFrontier.push(normalized)
			}
		}
		frontier = nextFrontier
	}
	return paths
}

/**
 * Shares immutable built-in Skills for one plugin instance. Vault access,
 * permissions, read tracking, settings IO, and reversible operation recording
 * remain scoped to each tool invocation.
 */
export class VaultFileSystemManager {
	private sharedPromise?: Promise<SharedVaultFileSystem>

	constructor(
		private readonly app: App,
		private readonly defaults: Pick<
			CreateVaultFileSystemOptions,
			'appLifecycle' | 'appWorkspaceBinding' | 'openApp' | 'readonlyApps'
		> = {},
		sharedPromise?: Promise<SharedVaultFileSystem>,
	) {
		this.sharedPromise = sharedPromise
	}

	withDefaults(
		overrides: Pick<
			CreateVaultFileSystemOptions,
			'appLifecycle' | 'appWorkspaceBinding' | 'openApp' | 'readonlyApps'
		>,
	) {
		return new VaultFileSystemManager(
			this.app,
			{ ...this.defaults, ...overrides },
			this.getShared(),
		)
	}

	async create(options: CreateVaultFileSystemOptions = {}) {
		const shared = await this.getShared()
		return createScopedVaultFileSystem(this.app, shared, {
			...this.defaults,
			...options,
		})
	}

	/** Commands and filesystem share one invocation's defaults without wrapper identity. */
	async createBashEnvironment(options: CreateVaultFileSystemOptions = {}) {
		// Bash globs enumerate live directories via `readdirWithFileTypes`, never `getAllPaths()`.
		const scoped = { includePathIndex: false, ...this.defaults, ...options }
		const fs = await this.create(scoped)
		const { openApp, appWorkspaceBinding } = scoped
		return {
			fs,
			customCommands: createAppCommands({
				openApp,
				selectedAppId: () => appWorkspaceBinding?.selectedAppId(),
			}),
		}
	}

	private getShared() {
		if (!this.sharedPromise) {
			this.sharedPromise = createBuiltinSkillsFs()
				.then((builtinSkillsFs) => ({ builtinSkillsFs }))
				.catch((error) => {
					this.sharedPromise = undefined
					throw error
				})
		}
		return this.sharedPromise
	}
}

async function createScopedVaultFileSystem(
	app: App,
	shared: SharedVaultFileSystem,
	options: CreateVaultFileSystemOptions,
) {
	const onRead = (path: string) => {
		if (!options.recorder?.isCapturing) options.onRead?.(path)
	}
	const configDirMountPoint = getConfigDirMountPoint(
		normalizePath(app.vault.configDir),
	)
	const initialPaths =
		options.includePathIndex === false
			? NOOP_VAULT_PATH_INDEX
			: await getInitialVaultPaths(app)
	const vaultFs = new ObsidianVaultFs(
		app,
		initialPaths,
		options.permissionGuard,
		onRead,
	)
	const settingsFs =
		options.getSettingsSnapshot && options.updateSettings
			? new SettingsFs({
					getSettings: options.getSettingsSnapshot,
					updateSettings: options.updateSettings,
					permissionGuard: options.permissionGuard,
					onRead,
				})
			: undefined
	const mountable = new MountableFs({
		base: vaultFs,
		mounts: [
			{
				mountPoint: APPS_MOUNT_POINT,
				filesystem: new AppFs(app, options, onRead),
			},
			{
				mountPoint: BUILTIN_SKILLS_MOUNT_POINT,
				filesystem: shared.builtinSkillsFs,
			},
			...(settingsFs
				? [
						{
							mountPoint: SETTINGS_MOUNT_POINT,
							filesystem: settingsFs,
						},
					]
				: []),
		],
	})
	const result = options.recorder
		? new ReversibleFs(mountable, options.recorder, {
				absoluteMountPoints: [
					AGENTS_MOUNT_POINT,
					configDirMountPoint,
					SETTINGS_MOUNT_POINT,
				],
			})
		: mountable
	return result
}

export async function createVaultFileSystem(
	app: App,
	options: CreateVaultFileSystemOptions = {},
) {
	const manager = options.fileSystemManager ?? new VaultFileSystemManager(app)
	return manager.create(options)
}

export { VAULT_MOUNT_POINT } from './bash/mount-points'
