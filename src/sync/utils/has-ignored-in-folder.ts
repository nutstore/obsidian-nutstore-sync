import { FsWalkResult } from '~/fs/fs.interface'
import { isSub } from '../../utils/is-sub'

/**
 * Check if there are any ignored files/folders within a directory
 * @param dirPath directory path to check
 * @param stats FsWalkResult array from walk operation
 * @returns true if any ignored items exist in the directory, false otherwise
 */
export function hasIgnoredInFolder(
	dirPath: string,
	stats: FsWalkResult[],
): boolean {
	for (const item of stats) {
		if (isSub(dirPath, item.stat.path) || item.stat.path === dirPath) {
			if (item.ignored) {
				return true
			}
		}
	}

	return false
}

/**
 * Get all ignored file/folder paths within a directory
 * @param dirPath directory path to check
 * @param stats FsWalkResult array from walk operation
 * @returns array of ignored paths within the directory
 */
export function getIgnoredPathsInFolder(
	dirPath: string,
	stats: FsWalkResult[],
): string[] {
	const ignoredPaths: string[] = []

	for (const item of stats) {
		if (isSub(dirPath, item.stat.path) || item.stat.path === dirPath) {
			if (item.ignored) {
				ignoredPaths.push(item.stat.path)
			}
		}
	}

	return ignoredPaths
}
