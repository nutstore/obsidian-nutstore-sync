import { MountableFs } from 'just-bash/browser'
import type { IFileSystem } from 'just-bash/browser'
import type { App } from 'obsidian'
import { createBuiltinSkillsFs } from '~/ai/skills/builtin'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { ObsidianAdapterFs } from './bash/adapter-fs'
import { BASH_TMP_MOUNT_POINT, createBashTmpFs } from './bash/tmp-fs'
import {
	BUILTIN_SKILLS_MOUNT_POINT,
	listVaultPaths,
	ObsidianVaultFs,
	ReversibleOpRecorder,
	VAULT_MOUNT_POINT,
} from './bash/fs'

export interface CreateVaultFileSystemOptions {
	permissionGuard?: PermissionGuard
	recorder?: ReversibleOpRecorder
	onRead?: (vaultPath: string) => void
	scratch?: IFileSystem
}

export async function createVaultFileSystem(
	app: App,
	options: CreateVaultFileSystemOptions = {},
) {
	const initialPaths = await listVaultPaths(app)
	const vaultFs = new ObsidianVaultFs(
		app.vault,
		initialPaths,
		options.permissionGuard,
		options.recorder,
		options.onRead,
	)
	const agentsFs = await ObsidianAdapterFs.create(
		app.vault.adapter,
		'.agents',
		options.permissionGuard,
		options.recorder,
		options.onRead,
	)
	const vaultNamespace = new MountableFs({
		base: vaultFs,
		mounts: [{ mountPoint: '/.agents', filesystem: agentsFs }],
	})
	return new MountableFs({
		base: options.scratch,
		mounts: [
			{
				mountPoint: BASH_TMP_MOUNT_POINT,
				filesystem: await createBashTmpFs(app),
			},
			{ mountPoint: VAULT_MOUNT_POINT, filesystem: vaultNamespace },
			{
				mountPoint: BUILTIN_SKILLS_MOUNT_POINT,
				filesystem: await createBuiltinSkillsFs(),
			},
		],
	})
}

export { BUILTIN_SKILLS_MOUNT_POINT, VAULT_MOUNT_POINT }
