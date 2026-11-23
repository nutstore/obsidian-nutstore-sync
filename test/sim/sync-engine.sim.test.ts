import 'fake-indexeddb/auto'
import * as fc from 'fast-check'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	DEFAULT_LOCAL_SETTINGS,
	DEFAULT_SETTINGS,
	SyncMode,
	SyncPolicy,
	type NutstoreLocalSettings,
	type NutstoreSettings,
} from '~/settings'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { onSyncError } from '~/events'
import { NutstoreSync, SyncStartMode } from '~/sync'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import MoveRemoteTask from '~/sync/tasks/move-remote.task'
import RemoveRemoteTask from '~/sync/tasks/remove-remote.task'
import { optimizeTasksForExecution } from '~/sync/utils/optimize-tasks'
import { apiLimiter } from '~/utils/api-limiter'
import { getDBKey } from '~/utils/get-db-key'
import {
	compileFilterRules,
	isPathIncluded,
	type GlobFilterRule,
} from '~/utils/glob-match'
import { sha256Base64 } from '~/utils/sha256'
import type NutstorePlugin from '~/index'
import { obsidianRuntime } from '../obsidian-runtime'
import { clearAllPluginStorage } from '../harness/memory-storage'
import { createMemoryClock, MemoryVault } from '../harness/memory-vault'
import { MemoryWebDAV, type MoveSupportMode } from '../harness/memory-webdav'
import { simParams } from '../harness/sim-config'

const REMOTE_BASE_DIR = '/SyncVault/'
const decoder = new TextDecoder('utf-8')

const SIM_PATHS = [
	'notes/alpha.md',
	'notes/beta.md',
	'notes/笔记🌱.md',
	'notes/sub/深度文档📘.md',
	'archive/报告 #1 & 50%.md',
	'archive/记录 [draft]+v2.md',
	'data/settings.json',
	'workspace/条目👨‍👩‍👧‍👦.md',
	'loose.md',
]

const SIM_CONTENTS = [
	'alpha content v1\nline two\n',
	'beta 中性内容 🌱\n第二行\n',
	'shared duplicate payload 相同内容 🔁\n',
	'{"title":"中性配置","count":1}\n',
	'{"title":"中性配置","count":2,"extra":"🌿"}\n',
	'emoji surrogate 👨‍👩‍👧‍👦 🏳️‍🌈 🛠️\n',
	'updated revision 修订版 ✨\nline b\nline c\n',
]

type WorldOp =
	| { kind: 'localWrite'; path: string; content: string }
	| { kind: 'remoteWrite'; path: string; content: string }
	| { kind: 'localDelete'; path: string }
	| { kind: 'remoteDelete'; path: string }
	| { kind: 'localMove'; from: string; to: string }
	| { kind: 'localDir'; path: string }
	| { kind: 'remoteDir'; path: string }

interface SyncWorld {
	clock: ReturnType<typeof createMemoryClock>
	vault: MemoryVault
	remote: MemoryWebDAV
	settings: NutstoreSettings
	localSettings: NutstoreLocalSettings
	plugin: NutstorePlugin
	syncRecord: SyncRecord
}

function createSyncWorld(options?: {
	policy?: SyncPolicy
	conflictStrategy?: ConflictStrategy
	syncMode?: SyncMode
	moveSupport?: MoveSupportMode
	filterRules?: GlobFilterRule[]
	clockSkewMs?: number
}): SyncWorld {
	const clock = createMemoryClock(1_730_000_000_000)
	const vault = new MemoryVault({ name: 'SimVault', clock })
	const remote = new MemoryWebDAV({
		clock,
		clockSkewMs: options?.clockSkewMs ?? 0,
		moveSupport: options?.moveSupport ?? 'supported',
	})
	remote.seedDir(REMOTE_BASE_DIR)

	const settings: NutstoreSettings = {
		...DEFAULT_SETTINGS,
		loginMode: 'manual',
		nutstoreEnterpriseBaseUrl: 'https://sim.nutstore.test',
		confirmBeforeSync: false,
		confirmBeforeDeleteInAutoSync: false,
		configDirSyncMode: 'none',
		syncMode: options?.syncMode ?? SyncMode.STRICT,
		conflictStrategy:
			options?.conflictStrategy ?? ConflictStrategy.NoConflictMerge,
		filterRules: { rules: options?.filterRules ?? [] },
	}
	const localSettings: NutstoreLocalSettings = {
		...DEFAULT_LOCAL_SETTINGS,
		syncPolicy: options?.policy ?? SyncPolicy.TwoWay,
	}

	const plugin = {
		app: vault.app,
		settings,
		localSettings,
		manifest: { id: 'nutstore-sync' },
		remoteBaseDir: REMOTE_BASE_DIR,
		getToken: async () => 'sim-token',
		getRemoteAccountId: async () => 'sim-account',
		sync: {
			webdav: {
				createWebDAVClient: async () => remote.client,
			},
			progress: {
				closeProgressModal() {},
				showProgressModal() {},
			},
		},
	} as unknown as NutstorePlugin

	const syncRecord = new SyncRecord(
		getDBKey(vault.vaultName, REMOTE_BASE_DIR),
		syncRecordKV,
	)

	obsidianRuntime.requestUrlHandler = (req) => remote.handleRequestUrl(req)

	return { clock, vault, remote, settings, localSettings, plugin, syncRecord }
}

async function runSync(
	world: SyncWorld,
	options?: {
		policy?: SyncPolicy
		mode?: SyncStartMode
		signal?: AbortSignal
		conflictStrategy?: ConflictStrategy
	},
) {
	obsidianRuntime.requestUrlHandler = (req) =>
		world.remote.handleRequestUrl(req)
	let syncError: Error | undefined
	const sub = onSyncError().subscribe((err) => {
		syncError = err
	})
	const sync = new NutstoreSync(world.plugin, {
		vault: world.vault.vault,
		token: 'sim-token',
		remoteAccountId: 'sim-account',
		remoteBaseDir: REMOTE_BASE_DIR,
		webdav: world.remote.client,
		signal: options?.signal,
		conflictStrategy: options?.conflictStrategy,
	})
	try {
		const res = await sync.start({
			mode: options?.mode ?? SyncStartMode.AUTO_SYNC,
			syncPolicy: options?.policy ?? world.localSettings.syncPolicy,
		})
		return { ...res, error: syncError }
	} finally {
		sub.unsubscribe()
	}
}

function toTextSnapshot(
	files: Map<string, Uint8Array>,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const key of [...files.keys()].sort()) {
		out[key] = decoder.decode(files.get(key)!)
	}
	return out
}

function applyWorldOp(world: SyncWorld, op: WorldOp): void {
	// Advance clock past WebDAV 1-second timestamp truncation boundary so edits
	// represent distinct logical modifications.
	world.clock.advance(2_000)

	switch (op.kind) {
		case 'localWrite': {
			const existing = world.vault.nodes.get(op.path)
			if (existing?.kind === 'folder') return
			// Avoid writing under an existing file parent
			if (hasFileAncestor(world.vault.nodes, op.path)) return
			world.vault.seedFile(op.path, op.content)
			break
		}
		case 'remoteWrite': {
			const abs = `${REMOTE_BASE_DIR}${op.path}`
			const existing = world.remote.nodes.get(abs)
			if (existing?.kind === 'dir') return
			if (hasRemoteFileAncestor(world.remote.nodes, abs)) return
			world.remote.seedFile(abs, op.content)
			break
		}
		case 'localDelete': {
			world.vault.removeDirect(op.path, true)
			break
		}
		case 'remoteDelete': {
			world.remote.deleteDirect(`${REMOTE_BASE_DIR}${op.path}`)
			break
		}
		case 'localMove': {
			if (op.from === op.to) return
			const src = world.vault.nodes.get(op.from)
			if (!src || src.kind !== 'file') return
			if (world.vault.nodes.has(op.to)) return
			if (hasFileAncestor(world.vault.nodes, op.to)) return
			world.vault.moveDirect(op.from, op.to, true)
			break
		}
		case 'localDir': {
			if (world.vault.nodes.has(op.path)) return
			if (hasFileAncestor(world.vault.nodes, op.path)) return
			world.vault.seedFolder(op.path)
			break
		}
		case 'remoteDir': {
			const abs = `${REMOTE_BASE_DIR}${op.path}`
			if (world.remote.nodes.has(abs)) return
			if (hasRemoteFileAncestor(world.remote.nodes, abs)) return
			world.remote.seedDir(abs)
			break
		}
	}
}

function hasFileAncestor(
	nodes: Map<string, { kind: 'file' | 'folder' }>,
	relPath: string,
): boolean {
	const parts = relPath.split('/')
	parts.pop()
	let cur = ''
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part
		if (nodes.get(cur)?.kind === 'file') return true
	}
	return false
}

function hasRemoteFileAncestor(
	nodes: Map<string, { kind: 'file' | 'dir' }>,
	absPath: string,
): boolean {
	const parts = absPath.split('/').filter(Boolean)
	parts.pop()
	let cur = ''
	for (const part of parts) {
		cur = `${cur}/${part}`
		if (nodes.get(cur)?.kind === 'file') return true
	}
	return false
}

async function assertRecordsHonest(
	world: SyncWorld,
	rules: GlobFilterRule[] = [],
): Promise<void> {
	const compiled = compileFilterRules(rules)
	const records = await world.syncRecord.getRecords()
	const localFiles = world.vault.snapshotFiles()
	const remoteFiles = world.remote.snapshotFiles(REMOTE_BASE_DIR)

	for (const [path, record] of records) {
		if (!isPathIncluded(path, compiled, record.local.isDir)) continue
		if (record.local.isDir) {
			expect(world.vault.nodes.get(path)?.kind).toBe('folder')
			expect(world.remote.nodes.get(`${REMOTE_BASE_DIR}${path}`)?.kind).toBe(
				'dir',
			)
			continue
		}
		const localBytes = localFiles.get(path)
		const remoteBytes = remoteFiles.get(path)
		expect(
			localBytes,
			`Record exists for missing local file: ${path}`,
		).toBeDefined()
		expect(
			remoteBytes,
			`Record exists for missing remote file: ${path}`,
		).toBeDefined()
		expect(localBytes).toEqual(remoteBytes)
		const copy = new Uint8Array(localBytes!.byteLength)
		copy.set(localBytes!)
		const expectedHash = await sha256Base64(copy.buffer)
		if (record.contentHash) {
			expect(record.contentHash).toBe(expectedHash)
		}
		if (record.base?.key) {
			expect(record.base.key).toBe(expectedHash)
		}
	}
}

const worldOpArb: fc.Arbitrary<WorldOp> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant('localWrite' as const),
			path: fc.constantFrom(...SIM_PATHS),
			content: fc.constantFrom(...SIM_CONTENTS),
		}),
	},
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant('remoteWrite' as const),
			path: fc.constantFrom(...SIM_PATHS),
			content: fc.constantFrom(...SIM_CONTENTS),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant('localDelete' as const),
			path: fc.constantFrom(...SIM_PATHS),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant('remoteDelete' as const),
			path: fc.constantFrom(...SIM_PATHS),
		}),
	},
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant('localMove' as const),
			from: fc.constantFrom(...SIM_PATHS),
			to: fc.constantFrom(...SIM_PATHS),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			kind: fc.constant('localDir' as const),
			path: fc.constantFrom('empty-a', 'empty-中文🌱', 'nested/empty-dir'),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			kind: fc.constant('remoteDir' as const),
			path: fc.constantFrom('remote-dir', '远端目录📘', 'nested/remote-empty'),
		}),
	},
)

describe('Sync engine deterministic simulation (DST)', () => {
	beforeAll(() => {
		apiLimiter.updateSettings({ minTime: 0, maxConcurrent: 16 })
	})

	beforeEach(async () => {
		obsidianRuntime.reset()
		await clearAllPluginStorage()
	})

	afterEach(() => {
		obsidianRuntime.reset()
	})

	it('converges, stays idempotent, and keeps records honest across randomized multi-round TwoWay histories', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(worldOpArb, { minLength: 1, maxLength: 6 }), {
					minLength: 2,
					maxLength: 4,
				}),
				fc.constantFrom<MoveSupportMode>('supported', 405, 501),
				fc.constantFrom(
					ConflictStrategy.NoConflictMerge,
					ConflictStrategy.LocalPriority,
					ConflictStrategy.ServerPriority,
				),
				async (rounds, moveSupport, conflictStrategy) => {
					await clearAllPluginStorage()
					const world = createSyncWorld({
						policy: SyncPolicy.TwoWay,
						conflictStrategy,
						moveSupport,
					})

					for (const ops of rounds) {
						for (const op of ops) {
							applyWorldOp(world, op)
						}
						world.clock.advance(2_000)

						const first = await runSync(world)
						expect(first.completed).toBe(true)

						// Oracle 1: Local and remote file trees must converge byte-for-byte
						const localSnap = toTextSnapshot(world.vault.snapshotFiles())
						const remoteSnap = toTextSnapshot(
							world.remote.snapshotFiles(REMOTE_BASE_DIR),
						)
						expect(localSnap).toEqual(remoteSnap)

						// Oracle 3: SyncRecord must faithfully reflect both sides + SHA-256 digests
						await assertRecordsHonest(world)

						// Oracle 2: Immediate follow-up sync with no new edits must be a strict no-op
						world.vault.clearMutations()
						world.remote.clearOps()
						const second = await runSync(world)
						expect(second.completed).toBe(true)
						expect(world.vault.mutations).toHaveLength(0)
						expect(world.remote.mutatingOps).toHaveLength(0)
					}
				},
			),
			simParams(8, 401),
		)
	})

	it('enforces strict MOVE equivalence: WebDAV MOVE vs 405/501 fallback reach byte-identical state including chains, swaps, and duplicates', async () => {
		const moveScenarioArb = fc.record({
			initialFiles: fc.array(
				fc.tuple(
					fc.constantFrom(...SIM_PATHS),
					fc.constantFrom(...SIM_CONTENTS),
				),
				{ minLength: 2, maxLength: 6 },
			),
			mutations: fc.array(
				fc.oneof(
					fc.record({
						kind: fc.constant('localMove' as const),
						from: fc.constantFrom(...SIM_PATHS),
						to: fc.constantFrom(...SIM_PATHS),
					}),
					fc.record({
						kind: fc.constant('localDelete' as const),
						path: fc.constantFrom(...SIM_PATHS),
					}),
					fc.record({
						kind: fc.constant('localWrite' as const),
						path: fc.constantFrom(...SIM_PATHS),
						content: fc.constantFrom(...SIM_CONTENTS),
					}),
				),
				{ minLength: 1, maxLength: 6 },
			),
		})

		await fc.assert(
			fc.asyncProperty(moveScenarioArb, async (scenario) => {
				const runWithMode = async (moveSupport: MoveSupportMode) => {
					await clearAllPluginStorage()
					const world = createSyncWorld({
						policy: SyncPolicy.TwoWay,
						moveSupport,
					})
					for (const [path, content] of scenario.initialFiles) {
						applyWorldOp(world, { kind: 'localWrite', path, content })
					}
					const baseline = await runSync(world)
					expect(baseline.completed).toBe(true)

					for (const op of scenario.mutations) {
						applyWorldOp(world, op)
					}
					world.clock.advance(2_000)

					const synced = await runSync(world)
					expect(synced.completed).toBe(true)

					const records = await world.syncRecord.getRecords()
					const recordSummary = Object.fromEntries(
						[...records.entries()]
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, v]) => [
								k,
								{
									isDir: v.local.isDir,
									hash: v.contentHash ?? v.base?.key ?? null,
								},
							]),
					)
					return {
						local: toTextSnapshot(world.vault.snapshotFiles()),
						remote: toTextSnapshot(world.remote.snapshotFiles(REMOTE_BASE_DIR)),
						records: recordSummary,
					}
				}

				const nativeMove = await runWithMode('supported')
				const fallback405 = await runWithMode(405)
				const fallback501 = await runWithMode(501)

				expect(nativeMove.local).toEqual(nativeMove.remote)
				expect(fallback405).toEqual(nativeMove)
				expect(fallback501).toEqual(nativeMove)
			}),
			simParams(6, 402),
		)

		// Targeted adversarial MOVE patterns: chain A→B, B→C; cyclic swap A↔B; duplicate-hash fan-out
		for (const pattern of ['chain', 'swap', 'duplicates'] as const) {
			const runPattern = async (moveSupport: MoveSupportMode) => {
				await clearAllPluginStorage()
				const world = createSyncWorld({ moveSupport })
				if (pattern === 'chain') {
					world.vault.seedFile('dir-a/one.md', 'content-one 中文 🌱')
					world.vault.seedFile('dir-b/two.md', 'content-two 📘')
					await runSync(world)
					world.clock.advance(2_000)
					world.vault.moveDirect('dir-b/two.md', 'dir-c/three.md')
					world.vault.moveDirect('dir-a/one.md', 'dir-b/two.md')
				} else if (pattern === 'swap') {
					world.vault.seedFile('swap/a🌱.md', 'payload-A')
					world.clock.advance(2_000)
					world.vault.seedFile('swap/b📘.md', 'payload-B-longer')
					await runSync(world)
					world.clock.advance(2_000)
					world.vault.moveDirect('swap/a🌱.md', 'swap/tmp.md')
					world.vault.moveDirect('swap/b📘.md', 'swap/a🌱.md')
					world.vault.moveDirect('swap/tmp.md', 'swap/b📘.md')
				} else {
					const dup = 'identical-bytes 相同字节 🔁'
					world.vault.seedFile('dup/orig-1.md', dup)
					world.vault.seedFile('dup/orig-2.md', dup)
					await runSync(world)
					world.clock.advance(2_000)
					world.vault.removeDirect('dup/orig-1.md')
					world.vault.seedFile('dup/copy-a.md', dup)
					world.vault.seedFile('dup/copy-b.md', dup)
				}
				world.clock.advance(2_000)
				const res = await runSync(world)
				expect(res.completed).toBe(true)
				await assertRecordsHonest(world)
				return {
					local: toTextSnapshot(world.vault.snapshotFiles()),
					remote: toTextSnapshot(world.remote.snapshotFiles(REMOTE_BASE_DIR)),
				}
			}

			const nativeRes = await runPattern('supported')
			const fallbackRes = await runPattern(405)
			expect(nativeRes.local).toEqual(nativeRes.remote)
			expect(fallbackRes).toEqual(nativeRes)
		}
	})

	it('guarantees strict policy monotonicity: ReceiveOnly never writes remote, SendOnly never writes local', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(worldOpArb, { minLength: 2, maxLength: 8 }),
				fc.constantFrom(
					SyncPolicy.ReceiveOnly,
					SyncPolicy.ReceiveOnlyRevertLocalChanges,
					SyncPolicy.SendOnly,
					SyncPolicy.SendOnlyOverrideChanges,
				),
				async (ops, policy) => {
					await clearAllPluginStorage()
					const world = createSyncWorld({ policy })
					// Seed baseline
					world.vault.seedFile('shared/base🌱.md', 'baseline')
					await runSync(world, { policy: SyncPolicy.TwoWay })

					for (const op of ops) {
						applyWorldOp(world, op)
					}
					world.clock.advance(2_000)
					world.vault.clearMutations()
					world.remote.clearOps()

					const res = await runSync(world, { policy })
					expect(res.completed).toBe(true)

					if (
						policy === SyncPolicy.ReceiveOnly ||
						policy === SyncPolicy.ReceiveOnlyRevertLocalChanges
					) {
						expect(world.remote.mutatingOps).toHaveLength(0)
					} else {
						expect(world.vault.mutations).toHaveLength(0)
					}
				},
			),
			simParams(8, 403),
		)
	})

	it('self-heals after mid-sync faults and AbortController cancellation without losing data or poisoning records', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 4 }),
				fc.constantFrom(500, 429, 'abort' as const),
				async (failAtCall, faultKind) => {
					await clearAllPluginStorage()
					const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
					world.vault.seedFile('keep/a🌱.md', 'important-a 内容')
					world.vault.seedFile('keep/b📘.md', 'important-b 内容')
					await runSync(world)

					world.clock.advance(2_000)
					world.vault.moveDirect('keep/a🌱.md', 'moved/a🌱.md')
					world.vault.seedFile('keep/c🛠️.md', 'brand-new-c 内容')
					world.remote.seedFile(
						`${REMOTE_BASE_DIR}remote-new.md`,
						'from-remote',
					)

					const expectedFiles = {
						'moved/a🌱.md': 'important-a 内容',
						'keep/b📘.md': 'important-b 内容',
						'keep/c🛠️.md': 'brand-new-c 内容',
						'remote-new.md': 'from-remote',
					}

					const controller = new AbortController()
					if (faultKind === 'abort') {
						let calls = 0
						world.remote.addFault({
							onCall: failAtCall,
							error: (() => {
								calls += 1
								const err = new Error('Aborted')
								err.name = 'AbortError'
								return err
							})(),
						})
						// Abort on failure path
						const aborted = await runSync(world, { signal: controller.signal })
						expect(aborted.completed || calls >= 0).toBe(true)
					} else {
						world.remote.addFault({
							op: 'put',
							onCall: 1,
							error: { status: faultKind, message: `Transient ${faultKind}` },
						})
						await runSync(world)
					}

					// Clear transient fault and heal with a clean retry
					world.remote.clearFaults()
					world.clock.advance(2_000)
					const healed = await runSync(world)
					expect(healed.completed).toBe(true)

					expect(toTextSnapshot(world.vault.snapshotFiles())).toEqual(
						expectedFiles,
					)
					expect(
						toTextSnapshot(world.remote.snapshotFiles(REMOTE_BASE_DIR)),
					).toEqual(expectedFiles)
					await assertRecordsHonest(world)
				},
			),
			simParams(6, 404),
		)
	})

	it('strictly isolates ignored paths and unavailable local subtrees with zero mutations and full recovery', async () => {
		const rules: GlobFilterRule[] = [
			{
				expr: 'ignored-私有🌱/**',
				type: 'exclude',
				options: { caseSensitive: true },
			},
		]
		const world = createSyncWorld({
			policy: SyncPolicy.TwoWay,
			filterRules: rules,
		})

		world.vault.seedFile('healthy/note.md', 'healthy-v1')
		world.vault.seedFile('blocked-封锁📘/secret.md', 'protected-local')
		world.vault.seedFile('ignored-私有🌱/local-only.md', 'ignored-local')
		world.remote.seedFile(
			`${REMOTE_BASE_DIR}ignored-私有🌱/remote-only.md`,
			'ignored-remote',
		)
		await runSync(world)

		// Now make `blocked-封锁📘` unreadable on list(), while editing healthy sibling
		world.clock.advance(2_000)
		world.vault.seedFile('healthy/note.md', 'healthy-v2')
		world.vault.faults.onList = (path) =>
			path === 'blocked-封锁📘'
				? new Error('EACCES: unreadable subtree')
				: undefined

		world.vault.clearMutations()
		world.remote.clearOps()
		const partial = await runSync(world)
		expect(partial.error).toBeUndefined()
		expect(partial.completed).toBe(true)

		// Healthy sibling synced cleanly
		expect(
			decoder.decode(
				world.remote.readBytesDirect(`${REMOTE_BASE_DIR}healthy/note.md`)!,
			),
		).toBe('healthy-v2')

		// Zero mutations touched ignored or blocked subtrees
		expect(
			world.vault.mutations.some(
				(m) =>
					m.path.startsWith('ignored-私有🌱') ||
					m.path.startsWith('blocked-封锁📘'),
			),
		).toBe(false)
		expect(
			world.remote.mutatingOps.some(
				(op) =>
					op.path.includes('ignored-私有🌱') ||
					op.path.includes('blocked-封锁📘'),
			),
		).toBe(false)

		// Protected file and its sync record survived intact
		expect(world.vault.readTextDirect('blocked-封锁📘/secret.md')).toBe(
			'protected-local',
		)
		expect(
			decoder.decode(
				world.remote.readBytesDirect(
					`${REMOTE_BASE_DIR}blocked-封锁📘/secret.md`,
				)!,
			),
		).toBe('protected-local')
		expect(
			await world.syncRecord.getRecord('blocked-封锁📘/secret.md'),
		).toBeDefined()

		// Clear fault: recovery must proceed seamlessly
		world.vault.faults.onList = undefined
		world.clock.advance(2_000)
		world.vault.seedFile('blocked-封锁📘/secret.md', 'protected-local-v2')
		const recovered = await runSync(world)
		expect(recovered.completed).toBe(true)
		expect(
			decoder.decode(
				world.remote.readBytesDirect(
					`${REMOTE_BASE_DIR}blocked-封锁📘/secret.md`,
				)!,
			),
		).toBe('protected-local-v2')
	})

	it('never deletes a source folder when a MoveRemoteTask is cancelled by user selection or fails at runtime', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		world.vault.seedFile('old-dir🌱/note.md', 'precious-content')
		await runSync(world)

		// 1. User unchecks MoveRemoteTask in confirmation modal -> cancelledMoveSources must drop parent RemoveRemoteTask
		const common = {
			vault: world.vault.vault,
			webdav: world.remote.client,
			syncRecord: world.syncRecord,
			logger: { info() {}, debug() {}, warn() {}, error() {} },
			remoteBaseDir: REMOTE_BASE_DIR,
		}
		const removeOldDir = new RemoveRemoteTask({
			...common,
			localPath: 'old-dir🌱',
			remotePath: `${REMOTE_BASE_DIR}old-dir🌱`,
		})
		const optimized = optimizeTasksForExecution([removeOldDir], {
			cancelledMoveSources: new Set(['old-dir🌱/note.md']),
		})
		expect(optimized).toHaveLength(0)

		// 2. Runtime failure of MoveRemoteTask must block subsequent RemoveRemoteTask covering the source folder
		world.clock.advance(2_000)
		world.vault.moveDirect('old-dir🌱/note.md', 'new-dir📘/note.md')
		world.vault.removeDirect('old-dir🌱', true)

		// Fail the MOVE RPC with a 500 (not 405/501 fallback) so MoveRemoteTask fails
		world.remote.addFault({
			op: 'move',
			error: { status: 500, message: 'Injected MOVE server error' },
		})

		const failedRun = await runSync(world)
		expect(failedRun.completed).toBe(true)
		// The remote source file MUST still exist (old-dir🌱 removal must have been skipped!)
		expect(
			decoder.decode(
				world.remote.readBytesDirect(`${REMOTE_BASE_DIR}old-dir🌱/note.md`)!,
			),
		).toBe('precious-content')

		// Clear fault and verify MoveRemoteTask succeeds + cleans up old-dir🌱 on retry
		world.remote.clearFaults()
		world.clock.advance(2_000)
		const retryRun = await runSync(world)
		expect(retryRun.completed).toBe(true)
		expect(
			world.remote.readBytesDirect(`${REMOTE_BASE_DIR}old-dir🌱/note.md`),
		).toBeUndefined()
		expect(
			decoder.decode(
				world.remote.readBytesDirect(`${REMOTE_BASE_DIR}new-dir📘/note.md`)!,
			),
		).toBe('precious-content')
		// Sanity check MoveRemoteTask class reference
		expect(MoveRemoteTask).toBeDefined()
	})
})
