import type { StatModel } from '~/model/stat.model'
import { isSameTime } from '~/utils/is-same-time'
import type {
	SyncDecisionInput,
	SyncRecordItem,
} from '../decision/sync-decision.interface'

/**
 * Whether a file's stat metadata diverged from its recorded baseline.
 * Checks both mtime and byte size so same-second edits or mtime-preserving
 * moves onto an existing path are never mistaken for unchanged files.
 */
export function hasFileMetadataChanged(
	current: Extract<StatModel, { isDir: false }>,
	recorded: StatModel,
): boolean {
	return (
		!isSameTime(current.mtime, recorded.mtime) ||
		(!recorded.isDir && current.size !== recorded.size)
	)
}

/** All policies use the same evidence: local snapshots can disprove mtime changes;
 * remote changes rely on metadata because planning does not download remote content.
 */
export async function getFileChanges(
	input: SyncDecisionInput,
	local: Extract<StatModel, { isDir: false }>,
	remote: Extract<StatModel, { isDir: false }>,
	record: SyncRecordItem,
): Promise<{ localChanged: boolean; remoteChanged: boolean }> {
	const localMtimeChanged = !isSameTime(local.mtime, record.local.mtime)
	const localSizeChanged =
		!record.local.isDir && local.size !== record.local.size
	const remoteChanged = hasFileMetadataChanged(remote, record.remote)
	let localChanged = localMtimeChanged || localSizeChanged
	let contentCheck = localSizeChanged ? 'size-differs' : 'mtime-unchanged'
	if (localMtimeChanged && !localSizeChanged) {
		contentCheck = 'no-base'
		if (record.base?.key && !record.local.isDir) {
			const base = await input.getBaseContent(record.base.key)
			contentCheck = 'base-unavailable'
			if (base) {
				localChanged = !(await input.compareFileContent(local.path, base))
				contentCheck = localChanged ? 'content-differs' : 'content-equal'
			}
		}
	}
	if (localMtimeChanged || localSizeChanged || remoteChanged) {
		input.logger.debug({
			reason: 'recorded file change evaluation',
			localPath: local.path,
			local: { mtime: local.mtime, size: local.size },
			remote: { mtime: remote.mtime, size: remote.size },
			recordedLocal: {
				mtime: record.local.mtime,
				size: record.local.isDir ? undefined : record.local.size,
			},
			recordedRemote: {
				mtime: record.remote.mtime,
				size: record.remote.isDir ? undefined : record.remote.size,
			},
			localMtimeChanged,
			contentCheck,
			localChanged,
			remoteChanged,
		})
	}
	return { localChanged, remoteChanged }
}
