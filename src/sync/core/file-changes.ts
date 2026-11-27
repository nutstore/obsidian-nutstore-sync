import type { StatModel } from '~/model/stat.model'
import { isSameTime } from '~/utils/is-same-time'
import type {
	SyncDecisionInput,
	SyncRecordItem,
} from '../decision/sync-decision.interface'

export type RemoteChangeStatus = 'unchanged' | 'changed' | 'unverified'

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

/**
 * Single authoritative evaluation of remote file state against a recorded baseline.
 * - Both sides carry `etag` → compares `etag` verbatim (ignores `mtime`).
 * - Missing `etag` (legacy record) → returns `'changed'` if `size`/`mtime` differ,
 *   otherwise `'unverified'` (never `'unchanged'`, never authorizes remote overwrite/deletion).
 */
export function evaluateRemoteFileChange(
	current: Extract<StatModel, { isDir: false }>,
	recorded: StatModel,
): RemoteChangeStatus {
	if (recorded.isDir) {
		return 'changed'
	}
	if (current.etag && recorded.etag) {
		return current.etag === recorded.etag ? 'unchanged' : 'changed'
	}
	if (hasFileMetadataChanged(current, recorded)) {
		return 'changed'
	}
	return 'unverified'
}

/**
 * All policies use the same evidence: local snapshots can disprove mtime changes;
 * remote changes rely on verbatim ETags (with three-state legacy fallback).
 */
export async function getFileChanges(
	input: SyncDecisionInput,
	local: Extract<StatModel, { isDir: false }>,
	remote: Extract<StatModel, { isDir: false }>,
	record: SyncRecordItem,
): Promise<{
	localChanged: boolean
	remoteStatus: RemoteChangeStatus
	remoteChanged: boolean
}> {
	const localMtimeChanged = !isSameTime(local.mtime, record.local.mtime)
	const localSizeChanged =
		!record.local.isDir && local.size !== record.local.size
	const remoteStatus = evaluateRemoteFileChange(remote, record.remote)
	const remoteChanged = remoteStatus === 'changed'
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
	if (localMtimeChanged || localSizeChanged || remoteStatus !== 'unchanged') {
		input.logger.debug({
			reason: 'recorded file change evaluation',
			localPath: local.path,
			local: { mtime: local.mtime, size: local.size },
			remote: { mtime: remote.mtime, size: remote.size, etag: remote.etag },
			recordedLocal: {
				mtime: record.local.mtime,
				size: record.local.isDir ? undefined : record.local.size,
			},
			recordedRemote: {
				mtime: record.remote.mtime,
				size: record.remote.isDir ? undefined : record.remote.size,
				etag: record.remote.isDir ? undefined : record.remote.etag,
			},
			localMtimeChanged,
			contentCheck,
			localChanged,
			remoteStatus,
			remoteChanged,
		})
	}
	return { localChanged, remoteStatus, remoteChanged }
}
