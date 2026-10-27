import type { App } from 'obsidian'
import type { RmOptions } from 'just-bash/browser'
import { ObsidianVaultFs } from '~/ai/tools/bash/fs'
import { normalizeVirtualPath } from '~/ai/tools/bash/virtual-path'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import type { AppWorkspaceBinding } from './workspaces'
import type { AppLifecycle } from './lifecycle'
import {
	APP_ROOT_DIR,
	appIdFromPath,
	isAppDirectoryPath,
	isReservedAppPath,
} from './paths'

interface AppFsOptions {
	permissionGuard?: PermissionGuard
	appWorkspaceBinding?: AppWorkspaceBinding
	appLifecycle?: AppLifecycle
	readonlyApps?: boolean
}

/** Mounted App files: directory deletion is uninstall, independent of the caller. */
export class AppFs extends ObsidianVaultFs {
	constructor(
		host: Pick<App, 'vault' | 'fileManager'>,
		private readonly policy: AppFsOptions,
		onRead?: (path: string) => void,
	) {
		const touch = (path: string) => {
			const id = appIdFromPath(path)
			if (id) void policy.appWorkspaceBinding?.access(id).catch(() => {})
		}
		super(
			host,
			[],
			policy.permissionGuard,
			(path) => {
				touch(path)
				onRead?.(path)
			},
			{
				rootPath: APP_ROOT_DIR,
				readOnlyPath: (path) =>
					isReservedAppPath(path) ||
					isAppDirectoryPath(path) ||
					policy.readonlyApps === true,
				creatablePath: (path) =>
					!policy.readonlyApps && isAppDirectoryPath(path),
				autoApprovePermission: (path) => appIdFromPath(path) !== undefined,
				onWrite: touch,
			},
		)
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const normalized = normalizeVirtualPath(path)
		const vaultPath = `${APP_ROOT_DIR}${normalized === '/' ? '' : normalized}`
		const id = appIdFromPath(vaultPath)
		if (!id || !isAppDirectoryPath(vaultPath)) return super.rm(path, options)
		if (!(await this.exists(normalized))) {
			if (options?.force) return
			throw new Error(`ENOENT: no such file or directory, remove '${path}'`)
		}
		if (!options?.recursive)
			throw new Error(`EISDIR: recursive removal required for '${path}'`)
		if (!this.policy.appLifecycle)
			throw new Error(`ENOTSUP: App lifecycle is unavailable, remove '${path}'`)
		await this.policy.permissionGuard?.({
			type: 'fs',
			fs: { kind: 'delete', path: `/${vaultPath}` },
		})
		await this.policy.appLifecycle.remove(id, { force: options.force })
	}
}
