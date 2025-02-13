import { createFsFromVolume, Volume } from 'memfs'
import { StatModel } from '~/model/stat.model'

export function statsToMemfs(stats: StatModel[]) {
	const json: Record<string, string | null> = {}
	stats.forEach((stat) => {
		if (stat.isDeleted) {
			return
		}
		json[stat.path] = stat.isDir ? null : ''
	})
	const vol = Volume.fromJSON(json)
	return createFsFromVolume(vol)
}
