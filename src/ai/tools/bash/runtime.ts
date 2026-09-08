import { Bash } from 'just-bash/browser'
import type { App } from 'obsidian'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { ReversibleOpRecorder } from './fs'
import { archiveCommands } from './zip'
import {
	createVaultFileSystem,
	VAULT_MOUNT_POINT,
	type VaultFileSystemManager,
} from '../vault-filesystem'
import type { SettingsSnapshotFn, SettingsUpdater } from '../tool-context'

export interface VaultBashExecOptions {
	cwd?: string
	stdin?: string
	rawScript?: boolean
	permissionGuard?: PermissionGuard
	onRead?: (vaultPath: string) => void
	getSettingsSnapshot?: SettingsSnapshotFn
	updateSettings?: SettingsUpdater
	fileSystemManager?: VaultFileSystemManager
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
	const fs = await createVaultFileSystem(app, {
		permissionGuard,
		recorder,
		onRead,
		getSettingsSnapshot: settingsIo?.getSettingsSnapshot,
		updateSettings: settingsIo?.updateSettings,
		fileSystemManager,
	})
	return new Bash({
		fs,
		cwd: VAULT_MOUNT_POINT,
		customCommands: archiveCommands,
	})
}

export async function execVaultBash(
	app: App,
	script: string,
	options: VaultBashExecOptions = {},
) {
	const recorder = new ReversibleOpRecorder()
	const bash = await createVaultBash(
		app,
		options.permissionGuard,
		recorder,
		options.onRead,
		{
			getSettingsSnapshot: options.getSettingsSnapshot,
			updateSettings: options.updateSettings,
		},
		options.fileSystemManager,
	)
	const result = await bash.exec(script, {
		cwd: options.cwd ?? VAULT_MOUNT_POINT,
		stdin: options.stdin,
		rawScript: options.rawScript,
	})
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
