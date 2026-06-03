import { dirname, join, normalize } from 'path-browserify'

export const REMOTE_SYNC_CACHE_FILENAME = 'ObsidianNutstoreSync.SyncCache.v1'
export const REMOTE_SYNC_CACHE_DIR = 'plugins/nutstore-sync/cache'

export function getRemoteSyncCacheFilePath(
	remoteBaseDir: string,
	configDir: string,
) {
	return normalizeAbsolutePath(
		join(
			remoteBaseDir,
			configDir,
			REMOTE_SYNC_CACHE_DIR,
			REMOTE_SYNC_CACHE_FILENAME,
		),
	)
}

export function getRemoteSyncCacheDirPath(
	remoteBaseDir: string,
	configDir: string,
) {
	return normalizeAbsolutePath(
		dirname(getRemoteSyncCacheFilePath(remoteBaseDir, configDir)),
	)
}

export function getSyncCacheLocalPath(configDir: string) {
	return normalize(
		join(configDir, REMOTE_SYNC_CACHE_DIR, REMOTE_SYNC_CACHE_FILENAME),
	)
}

export function isSyncCacheLocalPath(path: string, configDir: string) {
	return normalize(path) === getSyncCacheLocalPath(configDir)
}

function normalizeAbsolutePath(path: string) {
	const normalized = normalize(path)
	return normalized.startsWith('/') ? normalized : `/${normalized}`
}
