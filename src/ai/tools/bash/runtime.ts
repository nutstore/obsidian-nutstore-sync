import { Bash } from 'just-bash/browser'
import type { App } from 'obsidian'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import {
	listVaultPaths,
	MountedVaultFs,
	ObsidianVaultFs,
	ReversibleOpRecorder,
	VAULT_MOUNT_POINT,
} from './fs'

export interface VaultBashExecOptions {
	cwd?: string
	stdin?: string
	rawScript?: boolean
	permissionGuard?: PermissionGuard
}

export async function createVaultBash(
	app: App,
	permissionGuard?: PermissionGuard,
	recorder?: ReversibleOpRecorder,
) {
	const initialPaths = await listVaultPaths(app)
	const vaultFs = new ObsidianVaultFs(
		app.vault,
		initialPaths,
		permissionGuard,
		recorder,
	)
	const fs = new MountedVaultFs(vaultFs)

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
	const bash = await createVaultBash(app, options.permissionGuard, recorder)
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

export { VAULT_MOUNT_POINT }
