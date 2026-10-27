import type { App, Vault } from 'obsidian'

/**
 * Revocable access to an I/O boundary. Check both invocation and completion so
 * a late read cannot authorize a subsequent write. Already submitted writes
 * settle normally underneath; their result cannot start more work.
 */
export function guardIO<T extends object>(
	target: T,
	check: () => void,
	track?: (promise: Promise<unknown>) => void,
): T {
	return new Proxy(target, {
		get(object, key) {
			const value: unknown = Reflect.get(object, key, object)
			if (typeof value !== 'function') return value
			return (...args: unknown[]) => {
				check()
				const result: unknown = Reflect.apply(value, object, args)
				if (result instanceof Promise) {
					track?.(result)
					return result.then((value: unknown) => {
						check()
						return value
					})
				}
				check()
				return result
			}
		},
	})
}

export function guardVault(
	vault: Vault,
	check: () => void,
	track?: (promise: Promise<unknown>) => void,
): Vault {
	const adapter = guardIO(vault.adapter, check, track)
	return new Proxy(guardIO(vault, check, track), {
		get(target, key) {
			return key === 'adapter' ? adapter : (Reflect.get(target, key) as unknown)
		},
	})
}

export function guardAppIO(
	app: App,
	check: () => void,
	track?: (promise: Promise<unknown>) => void,
): App {
	const vault = guardVault(app.vault, check, track)
	const fileManager = guardIO(app.fileManager, check, track)
	return new Proxy(app, {
		get(target, key) {
			if (key === 'vault') return vault
			if (key === 'fileManager') return fileManager
			return Reflect.get(target, key) as unknown
		},
	})
}
