export interface AdapterDirectoryEntries {
	files: string[]
	folders: string[]
}

export interface DirectoryEntriesAdapter {
	list(directory: string): Promise<AdapterDirectoryEntries>
	stat(path: string): Promise<unknown>
}

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
	const available = async (path: string) => {
		try {
			return Boolean(await adapter.stat(path))
		} catch {
			return false
		}
	}
	const [files, folders] = await Promise.all([
		Promise.all(
			listed.files.map(async (path) =>
				(await available(path)) ? path : undefined,
			),
		),
		Promise.all(
			listed.folders.map(async (path) =>
				(await available(path)) ? path : undefined,
			),
		),
	])
	return {
		files: files.filter((path): path is string => Boolean(path)),
		folders: folders.filter((path): path is string => Boolean(path)),
	}
}
