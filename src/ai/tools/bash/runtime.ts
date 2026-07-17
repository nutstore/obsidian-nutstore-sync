import { Bash, MountableFs } from 'just-bash/browser'
import type { IFileSystem } from 'just-bash/browser'
import type { App } from 'obsidian'
import { createBuiltinSkillsFs } from '~/ai/skills/builtin'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { ObsidianAdapterFs } from './adapter-fs'
import { BASH_TMP_MOUNT_POINT, createBashTmpFs } from './tmp-fs'
import {
	BUILTIN_SKILLS_MOUNT_POINT,
	listVaultPaths,
	ObsidianVaultFs,
	ReversibleOpRecorder,
	VAULT_MOUNT_POINT,
} from './fs'

export interface VaultBashExecOptions {
	cwd?: string
	stdin?: string
	rawScript?: boolean
	permissionGuard?: PermissionGuard
	onRead?: (vaultPath: string) => void
	scratch?: IFileSystem
}

export async function createVaultBash(
	app: App,
	permissionGuard?: PermissionGuard,
	recorder?: ReversibleOpRecorder,
	onRead?: (vaultPath: string) => void,
	scratch?: IFileSystem,
) {
	const initialPaths = await listVaultPaths(app)
	const vaultFs = new ObsidianVaultFs(
		app.vault,
		initialPaths,
		permissionGuard,
		recorder,
		onRead,
	)
	const agentsFs = await ObsidianAdapterFs.create(
		app.vault.adapter,
		'.agents',
		permissionGuard,
		recorder,
		onRead,
	)
	const vaultNamespace = new MountableFs({
		base: vaultFs,
		mounts: [{ mountPoint: '/.agents', filesystem: agentsFs }],
	})
	const fs = new MountableFs({
		base: scratch,
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

	return new Bash({
		fs,
		cwd: VAULT_MOUNT_POINT,
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
		options.scratch,
	)
	const result = await bash.exec(script, {
		cwd: options.cwd ?? VAULT_MOUNT_POINT,
		stdin: options.stdin,
		rawScript: options.rawScript,
	})
	return {
		...result,
		reversibleOps: recorder.getOperations(),
	}
}

export { BUILTIN_SKILLS_MOUNT_POINT, VAULT_MOUNT_POINT }
