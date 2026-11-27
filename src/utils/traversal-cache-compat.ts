import { isAbsolute } from 'path-browserify'
import type { TraverseWebDAVCache } from '~/storage'
import { TRAVERSAL_CACHE_SCHEMA } from './get-db-key'
import { stdRemotePath } from './std-remote-path'

function normalizeAbsolutePrefix(path: string): string {
	return stdRemotePath(path).slice(0, -1)
}

function belongsToRemoteBaseDir(path: string, remoteBaseDir: string): boolean {
	if (!isAbsolute(path)) {
		return true
	}

	const normalizedPath = normalizeAbsolutePrefix(path)
	const normalizedBaseDir = normalizeAbsolutePrefix(remoteBaseDir)
	return (
		normalizedPath === normalizedBaseDir ||
		normalizedPath.startsWith(`${normalizedBaseDir}/`)
	)
}

export function isTraversalCacheCompatible(
	cache: TraverseWebDAVCache,
	remoteBaseDir: string,
): boolean {
	if (cache.schemaVersion !== TRAVERSAL_CACHE_SCHEMA) {
		return false
	}

	for (const path of [
		...(cache.queue ?? []),
		...(cache.pendingVerification ?? []),
		...(cache.unreadablePaths ?? []).map((entry) => entry.path),
	]) {
		if (!belongsToRemoteBaseDir(path, remoteBaseDir)) {
			return false
		}
	}

	for (const [dirPath, stats] of Object.entries(cache.nodes ?? {})) {
		if (!belongsToRemoteBaseDir(dirPath, remoteBaseDir)) {
			return false
		}

		for (const stat of stats) {
			if (!belongsToRemoteBaseDir(stat.path, remoteBaseDir)) {
				return false
			}
		}
	}

	return true
}
