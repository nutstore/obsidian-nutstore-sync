import { dirname } from 'path-browserify'
import type { StatModel } from '~/model/stat.model'
import { getRecordContentHash } from '~/model/sync-record.model'
import { isSameTime } from '~/utils/is-same-time'
import type {
	SyncDecisionInput,
	SyncRecordItem,
} from '../decision/sync-decision.interface'
import type { BaseTask } from '../tasks/task.interface'

export interface RemovedRemoteFileCandidate {
	path: string
	remote: Extract<StatModel, { isDir: false }>
	record: SyncRecordItem
}

export interface AddedLocalFileCandidate {
	path: string
	local: Extract<StatModel, { isDir: false }>
}

export interface MatchedLocalFileMove {
	fromPath: string
	toPath: string
	/** Verified local snapshot matching the moved remote bytes at decision time. */
	expectedLocal: Extract<StatModel, { isDir: false }>
	/**
	 * Verbatim remote ETag observed during planning; gates and verifies the MOVE.
	 * Always present: a move source must have been observed unchanged against a
	 * recorded ETag, which is what makes the pre-MOVE check meaningful.
	 */
	expectedRemoteEtag: string
}

interface IndexedRemovedCandidate {
	candidate: RemovedRemoteFileCandidate
	hash: string
	etag: string
}

function getDirSegments(filePath: string): string[] {
	const dir = dirname(filePath)
	return dir === '.' || dir === '' ? [] : dir.split('/')
}

function commonPrefixSegmentCount(pathA: string, pathB: string): number {
	const segsA = getDirSegments(pathA)
	const segsB = getDirSegments(pathB)
	const limit = Math.min(segsA.length, segsB.length)
	let count = 0
	for (let i = 0; i < limit; i++) {
		if (segsA[i] !== segsB[i]) break
		count++
	}
	return count
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function scoreMovePair(
	src: RemovedRemoteFileCandidate,
	dst: AddedLocalFileCandidate,
): number {
	let score = 0
	if (isSameTime(dst.local.mtime, src.record.local.mtime)) {
		score += 8
	}
	if (dst.local.basename === src.record.local.basename) {
		score += 4
	}
	if (dirname(dst.path) === dirname(src.path)) {
		score += 2
	}
	return score
}

/**
 * Pairs remote-delete + local-add file candidates that share exact byte size
 * and SHA-256 content hash so local file moves/renames execute as remote MOVE.
 * A candidate without a verbatim ETag is never paired: the MOVE is gated on it.
 */
export async function resolveLocalFileMoves(
	input: Pick<SyncDecisionInput, 'getLocalContentHash' | 'logger'>,
	removedCandidates: readonly RemovedRemoteFileCandidate[],
	addedCandidates: readonly AddedLocalFileCandidate[],
): Promise<{
	moves: MatchedLocalFileMove[]
	remainingRemoved: RemovedRemoteFileCandidate[]
	remainingAdded: AddedLocalFileCandidate[]
}> {
	if (removedCandidates.length === 0 || addedCandidates.length === 0) {
		return {
			moves: [],
			remainingRemoved: [...removedCandidates],
			remainingAdded: [...addedCandidates],
		}
	}

	const removedBySize = new Map<number, IndexedRemovedCandidate[]>()
	for (const candidate of removedCandidates) {
		if (candidate.remote.size <= 0 || candidate.record.local.isDir) {
			continue
		}
		if (candidate.record.local.size !== candidate.remote.size) {
			continue
		}
		const hash = getRecordContentHash(candidate.record)
		if (!hash) {
			continue
		}
		const etag = candidate.remote.etag
		if (!etag) {
			continue
		}
		const bucket = removedBySize.get(candidate.remote.size)
		if (bucket) {
			bucket.push({ candidate, hash, etag })
		} else {
			removedBySize.set(candidate.remote.size, [{ candidate, hash, etag }])
		}
	}

	if (removedBySize.size === 0) {
		return {
			moves: [],
			remainingRemoved: [...removedCandidates],
			remainingAdded: [...addedCandidates],
		}
	}

	const removedByHash = new Map<string, IndexedRemovedCandidate[]>()
	for (const bucket of removedBySize.values()) {
		for (const indexed of bucket) {
			const group = removedByHash.get(indexed.hash)
			if (group) {
				group.push(indexed)
			} else {
				removedByHash.set(indexed.hash, [indexed])
			}
		}
	}

	const addedByHash = new Map<string, AddedLocalFileCandidate[]>()
	for (const candidate of addedCandidates) {
		if (candidate.local.size <= 0 || !removedBySize.has(candidate.local.size)) {
			continue
		}
		let hash: string | null
		try {
			hash = await input.getLocalContentHash(
				candidate.path,
				candidate.local.size,
			)
		} catch (error) {
			input.logger.debug({
				reason: 'failed reading local file for move detection',
				localPath: candidate.path,
				error: error instanceof Error ? error.message : String(error),
			})
			continue
		}
		if (!hash || !removedByHash.has(hash)) {
			continue
		}
		const group = addedByHash.get(hash)
		if (group) {
			group.push(candidate)
		} else {
			addedByHash.set(hash, [candidate])
		}
	}

	const rawMoves: Array<{
		src: RemovedRemoteFileCandidate
		dst: AddedLocalFileCandidate
		etag: string
	}> = []

	for (const [hash, addedGroup] of addedByHash) {
		const removedGroup = removedByHash.get(hash)
		if (!removedGroup || removedGroup.length === 0) continue

		const pairs: Array<{
			src: IndexedRemovedCandidate
			dst: AddedLocalFileCandidate
			score: number
			commonDepth: number
		}> = []
		for (const src of removedGroup) {
			for (const dst of addedGroup) {
				if (src.candidate.path === dst.path) continue
				pairs.push({
					src,
					dst,
					score: scoreMovePair(src.candidate, dst),
					commonDepth: commonPrefixSegmentCount(src.candidate.path, dst.path),
				})
			}
		}

		pairs.sort(
			(a, b) =>
				b.score - a.score ||
				b.commonDepth - a.commonDepth ||
				compareStrings(a.src.candidate.path, b.src.candidate.path) ||
				compareStrings(a.dst.path, b.dst.path),
		)

		const matchedRemoved = new Set<string>()
		const matchedAdded = new Set<string>()
		for (const pair of pairs) {
			const sourcePath = pair.src.candidate.path
			if (matchedRemoved.has(sourcePath) || matchedAdded.has(pair.dst.path)) {
				continue
			}
			matchedRemoved.add(sourcePath)
			matchedAdded.add(pair.dst.path)
			rawMoves.push({
				src: pair.src.candidate,
				dst: pair.dst,
				etag: pair.src.etag,
			})
		}
	}

	// Guard against overlapping source/destination paths in synthetic or skewed snapshots.
	const fromPaths = new Set(rawMoves.map(({ src }) => src.path))
	const toPaths = new Set(rawMoves.map(({ dst }) => dst.path))
	const safeMoves = rawMoves.filter(
		({ src, dst }) => !toPaths.has(src.path) && !fromPaths.has(dst.path),
	)

	const finalRemovedSet = new Set(safeMoves.map(({ src }) => src.path))
	const finalAddedSet = new Set(safeMoves.map(({ dst }) => dst.path))

	const moves: MatchedLocalFileMove[] = safeMoves.map(({ src, dst, etag }) => {
		input.logger.debug({
			reason: 'detected local file move',
			fromPath: src.path,
			toPath: dst.path,
			size: dst.local.size,
		})
		return {
			fromPath: src.path,
			toPath: dst.path,
			expectedLocal: dst.local,
			expectedRemoteEtag: etag,
		}
	})

	return {
		moves,
		remainingRemoved: removedCandidates.filter(
			(candidate) => !finalRemovedSet.has(candidate.path),
		),
		remainingAdded: addedCandidates.filter(
			(candidate) => !finalAddedSet.has(candidate.path),
		),
	}
}

/**
 * Resolves move pairs from file delete/add candidates and appends MoveRemote,
 * fallback RemoveRemote, and fallback Push tasks into `tasks`.
 */
export async function resolveAndAppendMoveTasks(
	input: Pick<
		SyncDecisionInput,
		'getLocalContentHash' | 'logger' | 'taskFactory' | 'remoteBaseDir'
	>,
	removedCandidates: readonly RemovedRemoteFileCandidate[],
	addedCandidates: readonly AddedLocalFileCandidate[],
	tasks: BaseTask[],
): Promise<void> {
	const { moves, remainingRemoved, remainingAdded } =
		await resolveLocalFileMoves(input, removedCandidates, addedCandidates)
	const { taskFactory, remoteBaseDir } = input
	for (const move of moves) {
		tasks.push(
			taskFactory.createMoveRemoteTask({
				fromLocalPath: move.fromPath,
				fromRemotePath: move.fromPath,
				localPath: move.toPath,
				remotePath: move.toPath,
				remoteBaseDir,
				expectedLocalStat: move.expectedLocal,
				expectedRemoteEtag: move.expectedRemoteEtag,
			}),
		)
	}
	for (const candidate of remainingRemoved) {
		tasks.push(
			taskFactory.createRemoveRemoteTask({
				remotePath: candidate.path,
				localPath: candidate.path,
				remoteBaseDir,
			}),
		)
	}
	for (const candidate of remainingAdded) {
		tasks.push(
			taskFactory.createPushTask({
				remotePath: candidate.path,
				localPath: candidate.path,
				remoteBaseDir,
			}),
		)
	}
}
