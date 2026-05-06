import { normalizePath, TFile, Vault } from 'obsidian'

function isAdapterPathNormalized(vault: Vault, normalizedPath: string) {
	const pathForCheck = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '')
	const configDir = normalizePath(vault.configDir)
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
	if (
		configDir &&
		(pathForCheck === configDir || pathForCheck.startsWith(`${configDir}/`))
	) {
		return true
	}
	return pathForCheck
		.split('/')
		.some(
			(segment) =>
				segment !== '.' && segment !== '..' && segment.startsWith('.'),
		)
}

export function isAdapterPath(vault: Vault, path: string) {
	return isAdapterPathNormalized(vault, normalizePath(path))
}

export async function existsLocalPath(vault: Vault, path: string) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		return await vault.adapter.exists(normalizedPath)
	}
	return vault.getAbstractFileByPath(normalizedPath) !== null
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
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (file instanceof TFile) {
		await vault.modifyBinary(file, data)
		return
	}
	await vault.createBinary(normalizedPath, data)
}

export async function writeLocalText(vault: Vault, path: string, data: string) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		await vault.adapter.write(normalizedPath, data)
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (file instanceof TFile) {
		await vault.modify(file, data)
		return
	}
	await vault.create(normalizedPath, data)
}

export async function removeLocalPath(
	vault: Vault,
	path: string,
	recursive = false,
) {
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		const stat = await vault.adapter.stat(normalizedPath)
		if (!stat) {
			return
		}
		if (stat.type === 'folder') {
			await vault.adapter.rmdir(normalizedPath, recursive)
			return
		}
		await vault.adapter.remove(normalizedPath)
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		return
	}
	await vault.trash(file, false)
}
