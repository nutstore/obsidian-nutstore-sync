import { StatModel } from '~/model/stat.model'
import { SyncMode } from '~/settings'

export function areLooseEqualFiles(
	syncMode: SyncMode,
	local: StatModel | undefined,
	remote: StatModel | undefined,
): boolean {
	return (
		syncMode === SyncMode.LOOSE &&
		!!local &&
		!!remote &&
		!local.isDeleted &&
		!remote.isDeleted &&
		!local.isDir &&
		!remote.isDir &&
		local.size === remote.size
	)
}
