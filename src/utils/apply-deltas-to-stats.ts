import { basename } from 'path-browserify'
import { DeltaEntry } from '~/api/delta'
import { StatModel } from '~/model/stat.model'

/**
 * Apply delta changes to a base file list
 */
export function applyDeltasToStats(
	stats: StatModel[],
	deltas: DeltaEntry[],
): StatModel[] {
	const filesMap = new Map<string, StatModel>(stats.map((d) => [d.path, d]))
	const deltasMap = new Map(deltas.map((d) => [d.path, d]))

	// Apply each delta
	for (const delta of deltasMap.values()) {
		if (delta.isDeleted) {
			filesMap.delete(delta.path)
			continue
		}
		filesMap.set(delta.path, {
			path: delta.path,
			basename: basename(delta.path),
			isDir: delta.isDir,
			isDeleted: delta.isDeleted,
			mtime: new Date(delta.modified).valueOf(),
			size: delta.size,
		})
	}

	return Array.from(filesMap.values())
}
