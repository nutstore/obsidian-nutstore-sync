import type { Plugin } from 'obsidian'

/**
 * Removing the element alone leaves Obsidian's ribbon action registered: the
 * host recreates it on layout changes. Own the cleanup that addRibbonIcon
 * registers through Component.register, while retaining plugin-unload cleanup.
 * A synchronous registration owner avoids modifying the live Plugin instance.
 * App keys also isolate Apps with identical human titles in the native registry.
 */
export function createScopedRibbonIcon(
	plugin: Plugin,
	icon: string,
	title: string,
	callback: (event: MouseEvent) => void,
	key = '',
) {
	const cleanups: Array<() => void> = []
	const owner = Object.create(plugin) as Plugin
	Object.defineProperties(owner, {
		manifest: {
			value: {
				...plugin.manifest,
				id: key ? `${plugin.manifest.id}-${key}` : plugin.manifest.id,
			},
		},
		register: {
			value: (cleanup: () => void) => {
				let action: (() => void) | undefined = cleanup
				const once = () => {
					const current = action
					action = undefined
					current?.()
				}
				cleanups.push(once)
				plugin.register(once)
			},
		},
	})
	const element = plugin.addRibbonIcon.call(owner, icon, title, callback)
	return {
		element,
		dispose: () => {
			for (const cleanup of cleanups.splice(0).reverse()) cleanup()
			element.remove()
		},
	}
}
