import { z } from 'zod/mini'

export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type AppKV = Record<string, JsonValue>
export const MAX_KV_BYTES = 1_048_576
export const MAX_VALUE_BYTES = 262_144

export const appDataFileSchema = z.object({
	schemaVersion: z.literal(1),
	kv: z.record(z.string(), z.unknown()),
})

/** Reject lossy JSON values, cycles and prototype keys at every storage/bridge boundary. */
export function jsonValue(value: unknown, depth = 0): JsonValue {
	if (depth > 24) throw new Error('App data nesting limit exceeded')
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value))
		return value.map((item) => jsonValue(item, depth + 1))
	if (
		value &&
		typeof value === 'object' &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => {
				validateKey(key)
				return [key, jsonValue(entry, depth + 1)]
			}),
		)
	}
	throw new Error('App data must be JSON')
}
export function validateKey(key: unknown): asserts key is string {
	if (
		typeof key !== 'string' ||
		!key.length ||
		key.length > 200 ||
		['__proto__', 'constructor', 'prototype'].includes(key)
	)
		throw new Error('Invalid App data key')
}
export function jsonBytes(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
export function validateKV(value: unknown): AppKV {
	const kv = jsonValue(value)
	if (!kv || typeof kv !== 'object' || Array.isArray(kv))
		throw new Error('App data must be a JSON object')
	if (jsonBytes(kv) > MAX_KV_BYTES)
		throw new Error('App data capacity exceeded')
	for (const entry of Object.values(kv))
		if (jsonBytes(entry) > MAX_VALUE_BYTES)
			throw new Error('App data value exceeds its limit')
	return kv
}
export interface KVChange {
	key: string
	value?: JsonValue
	delete?: boolean
}
export function changeKV(previous: AppKV, changes: KVChange[]): AppKV {
	if (!changes.length || changes.length > 100)
		throw new Error('Invalid App data transaction')
	const next = { ...previous }
	for (const change of changes) {
		validateKey(change.key)
		if (change.delete) delete next[change.key]
		else {
			const value = jsonValue(change.value)
			if (jsonBytes(value) > MAX_VALUE_BYTES)
				throw new Error('App data value exceeds its limit')
			next[change.key] = value
		}
	}
	if (jsonBytes(next) > MAX_KV_BYTES)
		throw new Error('App data capacity exceeded')
	return next
}

export interface AppKVAPI {
	get(key: string): Promise<JsonValue | null>
	list(): Promise<string[]>
	set(key: string, value: JsonValue): Promise<void>
	delete(key: string): Promise<void>
	transact(changes: KVChange[]): Promise<void>
}

export interface AppKVHost {
	readKV(): Promise<AppKV>
	transact(changes: KVChange[]): Promise<void>
}

/** Serialized into the sandbox; keep this factory self-contained and browser-only. */
export function createAppKV(
	rpc: (method: string, ...args: unknown[]) => Promise<unknown>,
): AppKVAPI {
	return {
		get: (key) => rpc('kv.get', key) as Promise<JsonValue | null>,
		list: () => rpc('kv.list') as Promise<string[]>,
		set: (key, value) => rpc('kv.transact', [{ key, value }]) as Promise<void>,
		delete: (key) =>
			rpc('kv.transact', [{ key, delete: true }]) as Promise<void>,
		transact: (changes) => rpc('kv.transact', changes) as Promise<void>,
	}
}

export async function dispatchAppKV(
	host: AppKVHost,
	method: string,
	args: unknown[],
	check: () => void,
): Promise<unknown> {
	check()
	switch (method) {
		case 'get': {
			if (args.length !== 1) throw new Error('Invalid App request')
			const key = args[0]
			validateKey(key)
			return (await host.readKV())[key] ?? null
		}
		case 'list':
			return Object.keys(await host.readKV())
		case 'transact': {
			const input = args[0]
			if (args.length !== 1 || !Array.isArray(input))
				throw new Error('Invalid App transaction')
			const changes = input.map((item: unknown) => {
				if (!item || typeof item !== 'object')
					throw new Error('Invalid App transaction')
				const change = item as Record<string, unknown>
				validateKey(change.key)
				if (change.delete === true) return { key: change.key, delete: true }
				return { key: change.key, value: jsonValue(change.value) }
			})
			changeKV({}, changes)
			check()
			await host.transact(changes)
			return null
		}
	}
	throw new Error('Unknown App operation')
}
