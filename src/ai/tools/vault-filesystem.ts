import { MountableFs } from 'just-bash/browser'
import type { IFileSystem } from 'just-bash/browser'
import type { App } from 'obsidian'
import { createBuiltinSkillsFs } from '~/ai/skills/builtin'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { ObsidianAdapterFs } from './bash/adapter-fs'
import {
	BASH_TMP_MOUNT_POINT,
	createBashTmpFs,
	ensureBashTmpDirectory,
} from './bash/tmp-fs'
import {
	AGENTS_MOUNT_POINT,
	AGENTS_VAULT_PATH,
	BUILTIN_SKILLS_RELATIVE_MOUNT_POINT,
	VAULT_MOUNT_POINT,
} from './bash/mount-points'
import {
	listVaultPaths,
	ObsidianVaultFs,
	ReversibleOpRecorder,
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
	await ensureBashTmpDirectory(app)
	const agentsFs = await ObsidianAdapterFs.create(
		app.vault.adapter,
		AGENTS_VAULT_PATH,
		options.permissionGuard,
		options.recorder,
		options.onRead,
		AGENTS_MOUNT_POINT,
	)
	const tmpFs = await createBashTmpFs(
		app,
		options.permissionGuard,
		options.recorder,
		options.onRead,
	)
	const agentsNamespace = new MountableFs({
		base: agentsFs,
		mounts: [
			{
				mountPoint: BUILTIN_SKILLS_RELATIVE_MOUNT_POINT,
				filesystem: await createBuiltinSkillsFs(),
			},
		],
	})
	return new MountableFs({
		base: options.scratch,
		mounts: [
			{ mountPoint: BASH_TMP_MOUNT_POINT, filesystem: tmpFs },
			{ mountPoint: VAULT_MOUNT_POINT, filesystem: vaultFs },
			{ mountPoint: AGENTS_MOUNT_POINT, filesystem: agentsNamespace },
		],
	})
}

export {
	AGENTS_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	VAULT_MOUNT_POINT,
} from './bash/mount-points'
