import { describe, expect, it } from 'vitest'
import i18n from '~/i18n'
import type { SyncRecord } from '~/storage/sync-record'
import { resolveLocalFileMoves } from '~/sync/core/detect-local-moves'
import { extractHttpStatus } from '~/utils/nutstore-dav-error'
import { computeContentEtag, MemoryWebDAV } from '@test/harness/memory-webdav'
import { createMemoryClock, MemoryVault } from '@test/harness/memory-vault'
import MoveRemoteTask from './move-remote.task'

const REMOTE_BASE_DIR = '/Vault'
const FROM_PATH = 'notes/旧名 🌱.md'
const TO_PATH = 'notes/新名 📘.md'
const CONTENT = '同一份内容 shared bytes 📘\n'

const logger = { info() {}, debug() {}, warn() {}, error() {} }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function createWorld() {
	const clock = createMemoryClock()
	const vault = new MemoryVault({ clock })
	const remote = new MemoryWebDAV({ clock })
	remote.seedDir(REMOTE_BASE_DIR)
	remote.seedDir(`${REMOTE_BASE_DIR}/notes`)
	return { clock, vault, remote }
}

function seedRename(
	world: ReturnType<typeof createWorld>,
	expectedRemoteEtag: string,
) {
	world.remote.seedFile(`${REMOTE_BASE_DIR}/${FROM_PATH}`, CONTENT)
	world.vault.seedFile(TO_PATH, CONTENT)
	const task = new MoveRemoteTask({
		vault: world.vault.vault,
		webdav: world.remote.client,
		syncRecord: {} as SyncRecord,
		logger,
		remoteBaseDir: REMOTE_BASE_DIR,
		localPath: TO_PATH,
		remotePath: TO_PATH,
		fromLocalPath: FROM_PATH,
		fromRemotePath: FROM_PATH,
		expectedRemoteEtag,
	})
	world.remote.clearOps()
	return task
}

const readRemote = (world: ReturnType<typeof createWorld>, path: string) => {
	const bytes = world.remote.readBytesDirect(path)
	return bytes ? decoder.decode(bytes) : undefined
}

describe('MoveRemoteTask source drift gate', () => {
	it('refuses to move a source whose ETag drifted since planning and touches neither side', async () => {
		const world = createWorld()
		const task = seedRename(world, 'etag-observed-during-planning')

		const result = await task.exec()

		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected the move to be refused')
		expect(result.error.message).toBe(i18n.t('sync.error.moveSourceChanged'))
		expect(world.remote.ops.some((op) => op.op === 'move')).toBe(false)
		expect(
			world.remote.ops.some(
				(op) =>
					op.op === 'propfind' && op.path === `${REMOTE_BASE_DIR}/${FROM_PATH}`,
			),
		).toBe(true)
		expect(readRemote(world, `${REMOTE_BASE_DIR}/${FROM_PATH}`)).toBe(CONTENT)
		expect(
			world.remote.readBytesDirect(`${REMOTE_BASE_DIR}/${TO_PATH}`),
		).toBeUndefined()
	})

	it('treats a missing source (404) or directory replacement as drift without issuing MOVE', async () => {
		const expectedEtag = computeContentEtag(encoder.encode(CONTENT))

		const missingWorld = createWorld()
		const missingTask = seedRename(missingWorld, expectedEtag)
		missingWorld.remote.deleteDirect(`${REMOTE_BASE_DIR}/${FROM_PATH}`)
		const missingResult = await missingTask.exec()

		expect(missingResult.success).toBe(false)
		if (missingResult.success)
			throw new Error('expected missing source to fail')
		expect(missingResult.error.message).toBe(
			i18n.t('sync.error.moveSourceChanged'),
		)
		expect(missingWorld.remote.ops.some((op) => op.op === 'move')).toBe(false)

		const dirWorld = createWorld()
		const dirTask = seedRename(dirWorld, expectedEtag)
		dirWorld.remote.deleteDirect(`${REMOTE_BASE_DIR}/${FROM_PATH}`)
		dirWorld.remote.seedDir(`${REMOTE_BASE_DIR}/${FROM_PATH}`)
		const dirResult = await dirTask.exec()

		expect(dirResult.success).toBe(false)
		if (dirResult.success) {
			throw new Error('expected directory replacement to fail')
		}
		expect(dirResult.error.message).toBe(i18n.t('sync.error.moveSourceChanged'))
		expect(dirWorld.remote.ops.some((op) => op.op === 'move')).toBe(false)
	})

	it('propagates transient 503 errors from pre-MOVE stat instead of masking them as drift', async () => {
		const world = createWorld()
		const task = seedRename(world, computeContentEtag(encoder.encode(CONTENT)))
		world.remote.addFault({
			op: 'propfind',
			error: { status: 503, message: 'Service Unavailable' },
		})

		const result = await task.exec()

		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected 503 to fail the task')
		expect(extractHttpStatus(result.error)).toBe(503)
		expect(result.error.message).not.toBe(
			i18n.t('sync.error.moveSourceChanged'),
		)
		expect(world.remote.ops.some((op) => op.op === 'move')).toBe(false)
	})

	it('moves the planned version and records the witnessed destination ETag', async () => {
		const world = createWorld()
		const expectedEtag = computeContentEtag(encoder.encode(CONTENT))
		const task = seedRename(world, expectedEtag)

		const result = await task.exec()

		expect(result.success).toBe(true)
		if (!result.success) throw new Error('expected the move to succeed')
		expect(result.receipt?.kind).toBe('synced')
		if (result.receipt?.kind === 'synced' && !result.receipt.remote.isDir) {
			expect(result.receipt.remote.etag).toBe(expectedEtag)
		}
		expect(world.remote.ops.some((op) => op.op === 'move')).toBe(true)
		expect(
			world.remote.readBytesDirect(`${REMOTE_BASE_DIR}/${FROM_PATH}`),
		).toBeUndefined()
		expect(readRemote(world, `${REMOTE_BASE_DIR}/${TO_PATH}`)).toBe(CONTENT)
	})

	it('fails with 409 without overwriting when the destination appeared on the remote', async () => {
		const world = createWorld()
		const task = seedRename(world, computeContentEtag(encoder.encode(CONTENT)))
		const concurrent = '其他设备 concurrent bytes ✨'
		world.remote.seedFile(`${REMOTE_BASE_DIR}/${TO_PATH}`, concurrent)

		const result = await task.exec()

		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected 409 conflict on destination')
		expect(extractHttpStatus(result.error)).toBe(409)
		expect(world.remote.ops.some((op) => op.op === 'move')).toBe(true)
		expect(
			world.remote.ops.some((op) => op.op === 'put' || op.op === 'delete'),
		).toBe(false)
		expect(readRemote(world, `${REMOTE_BASE_DIR}/${TO_PATH}`)).toBe(concurrent)
		expect(readRemote(world, `${REMOTE_BASE_DIR}/${FROM_PATH}`)).toBe(CONTENT)
	})

	it('refuses to pair a move candidate lacking a verbatim remote ETag', async () => {
		const size = encoder.encode(CONTENT).byteLength
		const digest = 'sha256-neutral-digest'
		const baseStat = {
			path: FROM_PATH,
			basename: '旧名 🌱.md',
			isDir: false as const,
			isDeleted: false,
			mtime: 1_700_000_000_000,
			size,
		}
		const added = [
			{
				path: TO_PATH,
				local: {
					...baseStat,
					path: TO_PATH,
					basename: '新名 📘.md',
				},
			},
		]
		const input = {
			logger,
			getLocalContentHash: async () => digest,
		}

		const withoutEtag = await resolveLocalFileMoves(
			input,
			[
				{
					path: FROM_PATH,
					remote: { ...baseStat, etag: null },
					record: {
						local: baseStat,
						remote: baseStat,
						contentHash: digest,
					},
				},
			],
			added,
		)
		expect(withoutEtag.moves).toHaveLength(0)
		expect(withoutEtag.remainingRemoved).toHaveLength(1)
		expect(withoutEtag.remainingAdded).toHaveLength(1)

		const withEtag = await resolveLocalFileMoves(
			input,
			[
				{
					path: FROM_PATH,
					remote: { ...baseStat, etag: 'etag-v1' },
					record: {
						local: baseStat,
						remote: { ...baseStat, etag: 'etag-v1' },
						contentHash: digest,
					},
				},
			],
			added,
		)
		expect(withEtag.moves).toHaveLength(1)
		expect(withEtag.moves[0].expectedRemoteEtag).toBe('etag-v1')
	})
})
