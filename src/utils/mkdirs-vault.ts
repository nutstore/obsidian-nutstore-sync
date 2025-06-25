import { isNil } from 'lodash-es'
import { Vault } from 'obsidian'
import { dirname, normalize } from 'path'

export async function mkdirsVault(vault: Vault, path: string) {
	const stack: string[] = []
	let currentPath = normalize(path)
	if (currentPath === '/' || currentPath === '.') {
		return
	}
	if (vault.getAbstractFileByPath(currentPath)) {
		return
	}
	while (
		currentPath !== '' &&
		currentPath !== '/' &&
		currentPath !== '.' &&
		isNil(vault.getAbstractFileByPath(currentPath))
	) {
		stack.push(currentPath)
		currentPath = dirname(currentPath)
	}
	while (stack.length) {
		const pop = stack.pop()
		if (!pop) {
			continue
		}
		await vault.createFolder(pop)
	}
}
