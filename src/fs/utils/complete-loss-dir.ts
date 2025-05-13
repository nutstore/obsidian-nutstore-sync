import { dirname } from 'path'
import { StatModel } from '~/model/stat.model'
import isRoot from './is-root'

/**
 * 经过 inclusion 和 exclusion 之后，
 * 有些符合规则的文件保留了下来，
 * 但是他们的父文件夹可能丢失了，需要补全
 */
export default function completeLossDir(
	stats: StatModel[],
	_filteredStats: StatModel[],
) {
	const filteredStats = new Set(_filteredStats)
	const statsMap = new Map(stats.map((d) => [d.path, d]))
	const filteredFolderMap = new Map(
		[...filteredStats].filter((d) => d.isDir).map((d) => [d.path, d]),
	)
	for (let { path } of _filteredStats) {
		while (true) {
			path = dirname(path)
			if (isRoot(path)) {
				break
			}
			if (filteredFolderMap.has(path)) {
				continue
			}
			const dirStat = statsMap.get(path)
			if (!dirStat) {
				continue
			}
			filteredFolderMap.set(path, dirStat)
			filteredStats.add(dirStat)
		}
	}
	return [...filteredStats]
}
