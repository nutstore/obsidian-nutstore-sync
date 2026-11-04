import { type App, normalizePath, TFile, Vault } from 'obsidian'

type LocalPathListener = (path: string) => void

const localPathListeners = new Set<LocalPathListener>()

/**
 * Subscribe to normalized vault-relative paths written, moved, or removed
 * through the local vault I/O boundary (including hidden `.agents/...` files
 * that Obsidian's indexed Vault events do not emit).
 */
export function onLocalPathChanged(listener: LocalPathListener) {
	localPathListeners.add(listener)
	return () => {
		localPathListeners.delete(listener)
	}
}

export function emitLocalPathChanged(path: string) {
	const normalizedPath = normalizePath(path).replace(/^\/+/, '')
	for (const listener of localPathListeners) {
		listener(normalizedPath)
	}
}

function isAdapterPathNormalized(vault: Vault, normalizedPath: string) {
	const pathForCheck = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '')
	// Hidden paths are outside the indexed Vault regardless of which directory
	// the host uses for settings. Only ordinary paths need that host fact.
	if (
		pathForCheck
			.split('/')
			.some(
				(segment) =>
					segment !== '.' && segment !== '..' && segment.startsWith('.'),
			)
	)
		return true
	const configDir = normalizePath(vault.configDir)
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
	return (
		!!configDir &&
		(pathForCheck === configDir || pathForCheck.startsWith(`${configDir}/`))
	)
}

export function isAdapterPath(vault: Vault, path: string) {
	return isAdapterPathNormalized(vault, normalizePath(path))
}

export async function existsLocalPath(vault: Vault, path: string) {
	const normalizedPath = normalizePath(path)
	return await vault.adapter.exists(normalizedPath)
}

export async function readLocalBinary(vault: Vault, path: string) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		return await vault.adapter.readBinary(normalizedPath)
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		throw new Error('cannot find file in local fs: ' + normalizedPath)
	}
	if (!(file instanceof TFile)) {
		throw new Error('local path is not a file: ' + normalizedPath)
	}
	return await vault.readBinary(file)
}

export async function writeLocalBinary(
	vault: Vault,
	path: string,
	data: ArrayBuffer,
) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		await vault.adapter.writeBinary(normalizedPath, data)
	} else {
		const file = vault.getAbstractFileByPath(normalizedPath)
		if (file instanceof TFile) {
			await vault.modifyBinary(file, data)
		} else if (await vault.adapter.exists(normalizedPath)) {
			await vault.adapter.writeBinary(normalizedPath, data)
		} else {
			await vault.createBinary(normalizedPath, data)
		}
	}
	emitLocalPathChanged(normalizedPath)
}

export async function writeLocalText(vault: Vault, path: string, data: string) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		await vault.adapter.write(normalizedPath, data)
	} else {
		const file = vault.getAbstractFileByPath(normalizedPath)
		if (file instanceof TFile) {
			await vault.modify(file, data)
		} else if (await vault.adapter.exists(normalizedPath)) {
			await vault.adapter.write(normalizedPath, data)
		} else {
			await vault.create(normalizedPath, data)
		}
	}
	emitLocalPathChanged(normalizedPath)
}

export async function readLocalText(vault: Vault, path: string) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		return await vault.adapter.read(normalizedPath)
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		throw new Error('cannot find file in local fs: ' + normalizedPath)
	}
	if (!(file instanceof TFile)) {
		throw new Error('local path is not a file: ' + normalizedPath)
	}
	return await vault.read(file)
}

/**
 * Atomic write for whole-file JSON payloads (e.g. chat sessions).
 *
 * Obsidian's DataAdapter.rename refuses to overwrite an existing destination
 * ("Destination file already exists!"), so a tmp-file + rename dance is NOT a
 * valid strategy here. Instead we rely on `adapter.write`, which on
 * FileSystemAdapter (desktop) is already atomic internally (writes a temp
 * sibling then renames over the target) and auto-creates parent folders.
 * Visible vault files fall through to the standard vault write path.
 */
export async function writeLocalTextAtomic(
	vault: Vault,
	path: string,
	data: string,
) {
	await writeLocalText(vault, normalizePath(path), data)
}

// Visible files follow the host's deletion preference; hidden internal paths
// are not indexed by FileManager and must be removed through the adapter.
export async function removeLocalPath(
	app: Pick<App, 'vault' | 'fileManager'>,
	path: string,
	recursive = false,
) {
	const { vault, fileManager } = app
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		const stat = await vault.adapter.stat(normalizedPath)
		if (!stat) {
			return
		}
		if (stat.type === 'folder') {
			await vault.adapter.rmdir(normalizedPath, recursive)
			emitLocalPathChanged(normalizedPath)
			return
		}
		await vault.adapter.remove(normalizedPath)
		emitLocalPathChanged(normalizedPath)
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		return
	}
	await fileManager.trashFile(file)
	emitLocalPathChanged(normalizedPath)
}
