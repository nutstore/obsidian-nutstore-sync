import { Vault } from 'obsidian'
import { dirname, normalize } from 'path'

export async function mkdirsVault(vault: Vault, path: string) {
	const stack: string[] = []
	let currentPath = normalize(path)
	if (currentPath === '/' || currentPath === '.') {
		return
	}
	if (await vault.adapter.exists(currentPath)) {
		return
	}
	while (true) {
		if (await vault.adapter.exists(currentPath)) {
			break
		}
		stack.push(currentPath)
		currentPath = dirname(currentPath)
	}
	while (stack.length) {
		await vault.adapter.mkdir(stack.pop()!)
	}
}
