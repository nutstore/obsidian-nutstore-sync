import { limitAsync } from 'es-toolkit'

export interface AdapterDirectoryEntries {
	files: string[]
	folders: string[]
}

export interface DirectoryEntriesAdapter {
	list(directory: string): Promise<AdapterDirectoryEntries>
	stat(path: string): Promise<unknown>
}

/** Caps in-flight `adapter.stat` calls so large folders do not saturate mobile bridges. */
const MAX_CONCURRENT_ADAPTER_STATS = 24

/**
 * Returns only entries that remain addressable after a directory listing.
 * Adapters backed by synchronizing storage can briefly disagree between
 * list() and stat(); a filesystem must not expose those stale entries.
 */
export async function listAvailableAdapterEntries(
	adapter: DirectoryEntriesAdapter,
	directory: string,
): Promise<AdapterDirectoryEntries> {
	const listed = await adapter.list(directory)
	const probeEntry = limitAsync(async (path: string) => {
		try {
			return (await adapter.stat(path)) ? path : undefined
		} catch {
			return undefined
		}
	}, MAX_CONCURRENT_ADAPTER_STATS)
	const [files, folders] = await Promise.all([
		Promise.all(listed.files.map(probeEntry)),
		Promise.all(listed.folders.map(probeEntry)),
	])
	return {
		files: files.filter((path): path is string => Boolean(path)),
		folders: folders.filter((path): path is string => Boolean(path)),
	}
}
