import { throwIfAborted } from '~/utils/abort'
import { Bash } from 'just-bash/browser'
import type { App } from 'obsidian'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { ReversibleOpRecorder } from './fs'
import { archiveCommands } from './zip'
import { VAULT_MOUNT_POINT, VaultFileSystemManager } from '../vault-filesystem'
import type { SettingsSnapshotFn, SettingsUpdater } from '../tool-context'

export interface VaultBashExecOptions {
	signal?: AbortSignal
	cwd?: string
	stdin?: string
	rawScript?: boolean
	permissionGuard?: PermissionGuard
	onRead?: (vaultPath: string) => void
	getSettingsSnapshot?: SettingsSnapshotFn
	updateSettings?: SettingsUpdater
	fileSystemManager?: VaultFileSystemManager
}

function createBash({
	fs,
	customCommands,
}: Awaited<ReturnType<VaultFileSystemManager['createBashEnvironment']>>) {
	return new Bash({
		fs,
		cwd: VAULT_MOUNT_POINT,
		customCommands: [...archiveCommands, ...customCommands],
	})
}

export async function createVaultBash(
	app: App,
	permissionGuard?: PermissionGuard,
	recorder?: ReversibleOpRecorder,
	onRead?: (vaultPath: string) => void,
	settingsIo?: {
		getSettingsSnapshot?: SettingsSnapshotFn
		updateSettings?: SettingsUpdater
	},
	fileSystemManager?: VaultFileSystemManager,
) {
	const manager = fileSystemManager ?? new VaultFileSystemManager(app)
	const environment = await manager.createBashEnvironment({
		permissionGuard,
		recorder,
		onRead,
		getSettingsSnapshot: settingsIo?.getSettingsSnapshot,
		updateSettings: settingsIo?.updateSettings,
	})
	return createBash(environment)
}

export async function execVaultBash(
	app: App,
	script: string,
	options: VaultBashExecOptions = {},
) {
	throwIfAborted(options.signal)
	const recorder = new ReversibleOpRecorder()
	const manager = options.fileSystemManager ?? new VaultFileSystemManager(app)
	const environment = await manager.createBashEnvironment({
		permissionGuard: options.permissionGuard,
		recorder,
		onRead: options.onRead,
		getSettingsSnapshot: options.getSettingsSnapshot,
		updateSettings: options.updateSettings,
	})
	const bash = createBash(environment)
	const result = await bash.exec(script, {
		cwd: options.cwd ?? VAULT_MOUNT_POINT,
		stdin: options.stdin,
		rawScript: options.rawScript,
		signal: options.signal,
	})
	throwIfAborted(options.signal)
	return {
		...result,
		reversibleOps: await recorder.getNetOperations(),
	}
}

export {
	AGENTS_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	SETTINGS_MOUNT_POINT,
	VAULT_MOUNT_POINT,
} from '../vault-filesystem'
