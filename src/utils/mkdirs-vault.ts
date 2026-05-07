import { Vault } from 'obsidian'
import { dirname, normalize } from 'path-browserify'
import { existsLocalPath, isAdapterPath } from './local-vault-io'

export async function mkdirsVault(vault: Vault, path: string) {
	const stack: string[] = []
	let currentPath = normalize(path)
	if (currentPath === '/' || currentPath === '.') {
		return
	}
	if (await existsLocalPath(vault, currentPath)) {
		return
	}
	while (
		currentPath !== '' &&
		currentPath !== '/' &&
		currentPath !== '.' &&
		!(await existsLocalPath(vault, currentPath))
	) {
		stack.push(currentPath)
		currentPath = dirname(currentPath)
	}
	while (stack.length) {
		const pop = stack.pop()
		if (!pop) {
			continue
		}
		if (await existsLocalPath(vault, pop)) {
			continue
		}
		if (isAdapterPath(vault, pop)) {
			await vault.adapter.mkdir(pop)
		} else {
			await vault.createFolder(pop)
		}
	}
}
