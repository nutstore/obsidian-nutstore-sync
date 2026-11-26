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
import { syncRecordKV, traverseWebDAVKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { onSyncError } from '~/events'
import { NutstoreSync, SyncStartMode } from '~/sync'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import MoveRemoteTask from '~/sync/tasks/move-remote.task'
import RemoveRemoteTask from '~/sync/tasks/remove-remote.task'
import { optimizeTasksForExecution } from '~/sync/utils/optimize-tasks'
import { apiLimiter } from '~/utils/api-limiter'
import { getDBKey, getTraversalWebDAVDBKey } from '~/utils/get-db-key'
import {
	compileFilterRules,
	isPathIncluded,
	type GlobFilterRule,
} from '~/utils/glob-match'
import { getNutstoreDavEndpoint } from '~/utils/nutstore-endpoints'
import { sha256Base64 } from '~/utils/sha256'
import type NutstorePlugin from '~/index'
import { obsidianRuntime } from '../obsidian-runtime'
import { clearAllPluginStorage } from '../harness/memory-storage'
import { createMemoryClock, MemoryVault } from '../harness/memory-vault'
import {
	computeContentEtag,
	MemoryWebDAV,
	type MoveSupportMode,
} from '../harness/memory-webdav'
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
	deltaModifiedOffsetMs?: number
}): SyncWorld {
	const clock = createMemoryClock(1_730_000_000_000)
	const vault = new MemoryVault({ name: 'SimVault', clock })
	const remote = new MemoryWebDAV({
		clock,
		clockSkewMs: options?.clockSkewMs ?? 0,
		moveSupport: options?.moveSupport ?? 'supported',
		deltaModifiedOffsetMs: options?.deltaModifiedOffsetMs ?? 0,
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
		requestUrlHandler?: typeof obsidianRuntime.requestUrlHandler
	},
) {
	obsidianRuntime.requestUrlHandler =
		options?.requestUrlHandler ?? ((req) => world.remote.handleRequestUrl(req))
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
		const remoteNode = world.remote.nodes.get(`${REMOTE_BASE_DIR}${path}`)
		if (!record.remote.isDir && remoteNode?.kind === 'file') {
			expect(
				record.remote.etag,
				`Record remote.etag mismatch for ${path}`,
			).toBe(remoteNode.etag)
		}
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
						let seenOps = 0
						world.remote.onAfterOp = () => {
							seenOps += 1
							if (seenOps === failAtCall) {
								controller.abort()
							}
						}
						const aborted = await runSync(world, { signal: controller.signal })
						world.remote.onAfterOp = undefined
						expect(seenOps > 0 || aborted.completed).toBe(true)
						if (seenOps >= failAtCall) {
							expect(controller.signal.aborted).toBe(true)
						}
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

	it('counterexample #1: persists downloaded version ETag rather than post-download mutated remote ETag and pulls B on next sync', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		const relPath = 'notes/漂移 & 100% 📘.md'
		const absPath = `${REMOTE_BASE_DIR}${relPath}`
		const versionA = 'version-alpha-内容-A\n'
		const versionB = 'version-beta-修订-B 🌱\n'
		const encoder = new TextEncoder()
		const etagA = computeContentEtag(encoder.encode(versionA))
		const etagB = computeContentEtag(encoder.encode(versionB))

		world.remote.seedFile(absPath, versionA)

		let injected = false
		world.remote.onAfterOp = (op) => {
			if (
				!injected &&
				(op.op === 'get' || op.op === 'rangeGet') &&
				op.path === absPath
			) {
				injected = true
				world.clock.advance(2_000)
				world.remote.seedFile(absPath, versionB)
			}
		}

		const firstSync = await runSync(world)
		expect(firstSync.completed).toBe(true)
		expect(injected).toBe(true)

		// Local received A and SyncRecord recorded witnessed etag(A) — never etag(B)
		expect(world.vault.readTextDirect(relPath)).toBe(versionA)
		const recAfterFirst = await world.syncRecord.getRecord(relPath)
		expect(recAfterFirst).toBeDefined()
		expect(recAfterFirst!.remote.isDir).toBe(false)
		if (!recAfterFirst!.remote.isDir) {
			expect(recAfterFirst!.remote.etag).toBe(etagA)
			expect(recAfterFirst!.remote.etag).not.toBe(etagB)
		}

		// Next sync detects etag(B) != etag(A) and converges to B
		world.remote.onAfterOp = undefined
		const secondSync = await runSync(world)
		expect(secondSync.completed).toBe(true)
		expect(world.vault.readTextDirect(relPath)).toBe(versionB)
		const recAfterSecond = await world.syncRecord.getRecord(relPath)
		expect(
			recAfterSecond &&
				!recAfterSecond.remote.isDir &&
				recAfterSecond.remote.etag,
		).toBe(etagB)
		await assertRecordsHonest(world)
	})

	it('counterexample #2: treats legacy unverified baselines cautiously without ETag backfill, blind overwrite, or remote deletion', async () => {
		const world = createSyncWorld({
			policy: SyncPolicy.TwoWay,
			conflictStrategy: ConflictStrategy.NoConflictMerge,
		})
		const mergePath = 'notes/legacy-历史 & 100% 📘.md'
		const protectPath = 'notes/legacy-protect 🌱.md'
		const mergeAbs = `${REMOTE_BASE_DIR}${mergePath}`
		const protectAbs = `${REMOTE_BASE_DIR}${protectPath}`

		const baseMerge = 'line-1\nline-AAAA\n'
		const remoteSameStatB = 'line-1\nline-BBBB\n'
		const baseProtect = 'protect-AAAA-01'
		const remoteProtectB = 'protect-BBBB-01'

		expect(new TextEncoder().encode(baseMerge).byteLength).toBe(
			new TextEncoder().encode(remoteSameStatB).byteLength,
		)
		expect(new TextEncoder().encode(baseProtect).byteLength).toBe(
			new TextEncoder().encode(remoteProtectB).byteLength,
		)

		world.vault.seedFile(mergePath, baseMerge)
		world.vault.seedFile(protectPath, baseProtect)
		await runSync(world)

		// Downgrade records to legacy shape (no remote.etag) and swap remote bytes at identical mtime & size
		const records = await world.syncRecord.getRecords()
		const legacyMerge = records.get(mergePath)!
		const legacyProtect = records.get(protectPath)!
		if (legacyMerge.remote.isDir || legacyProtect.remote.isDir) {
			throw new Error('Expected file records')
		}
		const recordedMtimeMerge = legacyMerge.remote.mtime
		const recordedMtimeProtect = legacyProtect.remote.mtime
		delete legacyMerge.remote.etag
		delete legacyProtect.remote.etag
		await world.syncRecord.setRecords(records)

		world.remote.seedFile(mergeAbs, remoteSameStatB, recordedMtimeMerge)
		world.remote.seedFile(protectAbs, remoteProtectB, recordedMtimeProtect)

		// 1. Sync with local unchanged must NOT backfill remote.etag when baseline is unverified
		const idleRun = await runSync(world)
		expect(idleRun.completed).toBe(true)
		const afterIdle = await world.syncRecord.getRecord(mergePath)
		expect(
			afterIdle && !afterIdle.remote.isDir ? afterIdle.remote.etag : undefined,
		).toBeUndefined()

		// 2. Local edit against unverified remote merges instead of blindly overwriting B
		world.clock.advance(2_000)
		world.vault.seedFile(mergePath, 'line-1-local-🌿\nline-AAAA\n')

		// 3. Local delete against unverified remote restores B instead of deleting remote B
		world.vault.removeDirect(protectPath, false)

		const divergeRun = await runSync(world)
		expect(divergeRun.completed).toBe(true)

		expect(world.vault.readTextDirect(mergePath)).toBe(
			'line-1-local-🌿\nline-BBBB\n',
		)
		expect(decoder.decode(world.remote.readBytesDirect(mergeAbs)!)).toBe(
			'line-1-local-🌿\nline-BBBB\n',
		)
		expect(world.vault.readTextDirect(protectPath)).toBe(remoteProtectB)
		expect(decoder.decode(world.remote.readBytesDirect(protectAbs)!)).toBe(
			remoteProtectB,
		)
		await assertRecordsHonest(world)
	})

	it('counterexample #3: purges stale mirror children on in-place directory DELETE then ADD within one delta window', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		const dirRel = '文件夹 Dir 📁'
		const oldFileRel = `${dirRel}/旧笔记 old & 100%.md`
		const deepOldRel = `${dirRel}/sub/深层 #1.md`
		const newFileRel = `${dirRel}/新笔记 new 🌱.md`

		world.vault.seedFile(oldFileRel, 'old-content-1')
		world.vault.seedFile(deepOldRel, 'deep-old-content')
		expect((await runSync(world)).completed).toBe(true)

		// In-place directory DELETE -> ADD on remote before next sync
		world.clock.advance(2_000)
		world.remote.deleteDirect(`${REMOTE_BASE_DIR}${dirRel}`)
		world.clock.advance(2_000)
		world.remote.seedFile(`${REMOTE_BASE_DIR}${newFileRel}`, 'new-content-2 🌟')

		expect((await runSync(world)).completed).toBe(true)

		expect(world.vault.readTextDirect(oldFileRel)).toBeUndefined()
		expect(world.vault.readTextDirect(deepOldRel)).toBeUndefined()
		expect(world.vault.readTextDirect(newFileRel)).toBe('new-content-2 🌟')

		const kvKey = await getTraversalWebDAVDBKey(
			await world.plugin.getRemoteAccountId(),
			getNutstoreDavEndpoint(world.settings),
			REMOTE_BASE_DIR,
		)
		const cachedMirror = await traverseWebDAVKV.get(kvKey)
		const cachedPaths = Object.values(cachedMirror?.nodes ?? {})
			.flat()
			.map((item) => item.path)
		expect(cachedPaths).not.toContain(`${REMOTE_BASE_DIR}${oldFileRel}`)
		expect(cachedPaths).not.toContain(`${REMOTE_BASE_DIR}${deepOldRel}`)
		expect(cachedPaths).toContain(`${REMOTE_BASE_DIR}${newFileRel}`)
		await assertRecordsHonest(world)
	})

	it('rejects stale conditional PUT (412) when remote changes during ConflictResolveTask merge and recovers cleanly on retry', async () => {
		const world = createSyncWorld({
			policy: SyncPolicy.TwoWay,
			conflictStrategy: ConflictStrategy.NoConflictMerge,
		})
		const relPath = 'notes/并发合并 & 100% 📘.md'
		const absPath = `${REMOTE_BASE_DIR}${relPath}`

		world.vault.seedFile(relPath, 'head\nbody-base\ntail\n')
		expect((await runSync(world)).completed).toBe(true)

		// Concurrent divergence: local edits line 1, remote edits line 3
		world.clock.advance(2_000)
		world.vault.seedFile(relPath, 'head-local 🌿\nbody-base\ntail\n')
		world.remote.seedFile(absPath, 'head\nbody-base\ntail-remote-v1\n')

		const remoteV2 = 'head\nbody-base\ntail-remote-v2-concurrent 🔥\n'
		let concurrentMutated = false
		world.remote.onAfterOp = (op) => {
			if (
				!concurrentMutated &&
				(op.op === 'get' || op.op === 'rangeGet') &&
				op.path === absPath
			) {
				concurrentMutated = true
				world.clock.advance(2_000)
				world.remote.seedFile(absPath, remoteV2)
			}
		}

		// ConflictResolveTask reads remote-v1, then conditional PUT If-Match gets 412 -> remoteV2 preserved
		await runSync(world)
		expect(concurrentMutated).toBe(true)
		expect(decoder.decode(world.remote.readBytesDirect(absPath)!)).toBe(
			remoteV2,
		)

		// Next sync fetches remoteV2, merges cleanly with local edit, and converges
		world.remote.onAfterOp = undefined
		const recovered = await runSync(world)
		expect(recovered.completed).toBe(true)
		expect(world.vault.readTextDirect(relPath)).toBe(
			'head-local 🌿\nbody-base\ntail-remote-v2-concurrent 🔥\n',
		)
		expect(decoder.decode(world.remote.readBytesDirect(absPath)!)).toBe(
			'head-local 🌿\nbody-base\ntail-remote-v2-concurrent 🔥\n',
		)
		await assertRecordsHonest(world)
	})

	it('avoids redundant file transfers when delta.modified and PROPFIND.getlastmodified diverge while ETag matches', async () => {
		const world = createSyncWorld({
			policy: SyncPolicy.TwoWay,
			deltaModifiedOffsetMs: 3_600_000,
		})
		const relPath = 'notes/偏移 测试 100% #1 🌱.md'
		const absPath = `${REMOTE_BASE_DIR}${relPath}`
		const content = 'immutable content 内容不变 📘\n'

		world.vault.seedFile(relPath, content)
		expect((await runSync(world)).completed).toBe(true)

		// Touch remote with identical bytes at a shifted mtime + 1h delta offset: ETag stays identical
		world.clock.advance(5_000)
		world.remote.seedFile(absPath, content)
		world.remote.clearOps()

		const followUp = await runSync(world)
		expect(followUp.completed).toBe(true)
		const transferOps = world.remote.ops.filter(
			(op) =>
				op.op === 'get' ||
				op.op === 'rangeGet' ||
				op.op === 'put' ||
				op.op === 'delete',
		)
		expect(transferOps).toHaveLength(0)
		expect(world.vault.readTextDirect(relPath)).toBe(content)
		await assertRecordsHonest(world)
	})

	it('persists witnessed SyncReceipts for completed tasks when cancelled mid-chunk', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		const firstPath = 'notes/批次1 🌱.md'
		const secondPath = 'notes/批次2 📘.md'
		world.vault.seedFile(firstPath, 'payload-one-内容')
		world.vault.seedFile(secondPath, 'payload-two-内容')

		const controller = new AbortController()
		let firstCompletedPath: string | undefined
		world.remote.onAfterOp = (op) => {
			if (op.op === 'put' && !firstCompletedPath) {
				firstCompletedPath = op.path.slice(REMOTE_BASE_DIR.length)
				controller.abort()
			}
		}

		const cancelledRun = await runSync(world, { signal: controller.signal })
		world.remote.onAfterOp = undefined
		expect(cancelledRun.completed).toBe(false)
		expect(firstCompletedPath).toBeDefined()

		// The task that finished before abort MUST have its witnessed SyncRecord persisted
		const completedRecord = await world.syncRecord.getRecord(
			firstCompletedPath!,
		)
		expect(completedRecord).toBeDefined()
		const completedRemote = world.remote.nodes.get(
			`${REMOTE_BASE_DIR}${firstCompletedPath!}`,
		)
		expect(
			completedRecord &&
				!completedRecord.remote.isDir &&
				completedRemote?.kind === 'file' &&
				completedRecord.remote.etag === completedRemote.etag,
		).toBe(true)

		// Next sync uploads only the remaining file without re-uploading or conflicting on the first
		world.remote.clearOps()
		const resumed = await runSync(world)
		expect(resumed.completed).toBe(true)
		const putPaths = world.remote.ops
			.filter((op) => op.op === 'put')
			.map((op) => op.path)
		expect(putPaths).not.toContain(`${REMOTE_BASE_DIR}${firstCompletedPath!}`)
		expect(world.vault.readTextDirect(firstPath)).toBe('payload-one-内容')
		expect(world.vault.readTextDirect(secondPath)).toBe('payload-two-内容')
		await assertRecordsHonest(world)
	})

	it('does not swallow same-length local edit during ConflictResolveTask.execMerge and preserves UTF-8 BOM on remote-wins merge', async () => {
		const world = createSyncWorld({
			policy: SyncPolicy.TwoWay,
			conflictStrategy: ConflictStrategy.NoConflictMerge,
		})

		// 1. Local-winning merge (`mergedText === localText`) with concurrent same-length local edit
		const localWinsRel = 'notes/合并保留本地 & 100% 🌱.md'
		const localWinsAbs = `${REMOTE_BASE_DIR}${localWinsRel}`
		world.vault.seedFile(localWinsRel, 'line-a\n')
		expect((await runSync(world)).completed).toBe(true)

		world.clock.advance(2_000)
		world.remote.seedFile(localWinsAbs, 'line-a\nline-b\n')
		world.vault.seedFile(localWinsRel, 'line-a\nline-b\nline-c\n')

		let mutatedLocalMidMerge = false
		world.remote.onAfterOp = (op) => {
			if (
				!mutatedLocalMidMerge &&
				(op.op === 'get' || op.op === 'rangeGet') &&
				op.path === localWinsAbs
			) {
				mutatedLocalMidMerge = true
				world.clock.advance(2_000)
				// Same exact byte length as `line-a\nline-b\nline-c\n`!
				world.vault.seedFile(localWinsRel, 'line-a\nline-b\nline-d\n')
			}
		}

		expect((await runSync(world)).completed).toBe(true)
		world.remote.onAfterOp = undefined
		expect(mutatedLocalMidMerge).toBe(true)
		// Next sync MUST detect the concurrent local edit `line-d` and push it to remote
		expect((await runSync(world)).completed).toBe(true)
		expect(decoder.decode(world.remote.readBytesDirect(localWinsAbs)!)).toBe(
			'line-a\nline-b\nline-d\n',
		)
		expect(world.vault.readTextDirect(localWinsRel)).toBe(
			'line-a\nline-b\nline-d\n',
		)

		// 2. Remote-wins merge (`mergedText === remoteText`) where remote carries a UTF-8 BOM
		const bomRel = 'notes/bom-文档 📘.md'
		const bomAbs = `${REMOTE_BASE_DIR}${bomRel}`
		world.clock.advance(2_000)
		world.vault.seedFile(bomRel, 'line-a\n')
		expect((await runSync(world)).completed).toBe(true)

		world.clock.advance(2_000)
		world.vault.seedFile(bomRel, 'line-a\nline-b\n')
		const bomRemoteBytes = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode('line-a\nline-b\nline-remote\n'),
		])
		world.remote.seedFile(bomAbs, bomRemoteBytes)

		expect((await runSync(world)).completed).toBe(true)
		expect(world.vault.snapshotFiles().get(bomRel)).toEqual(bomRemoteBytes)
		await assertRecordsHonest(world)
	})

	it('protects per-item PROPFIND 403 subtrees via SyncScope across full and incremental runs without deleting local files', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		const protectedRel = 'notes/受限文档 & 权限 🔒.md'
		const healthyRel = 'notes/正常笔记 🌱.md'
		const protectedAbs = `${REMOTE_BASE_DIR}${protectedRel}`
		const healthyAbs = `${REMOTE_BASE_DIR}${healthyRel}`

		world.vault.seedFile(protectedRel, 'protected content 受限内容 🔒')
		world.vault.seedFile(healthyRel, 'healthy v1 正常内容 🌱')
		expect((await runSync(world)).completed).toBe(true)

		// Force a full rescan where the 207 Multi-Status returns a per-item 403 for `protectedRel`
		const traversalKey = await getTraversalWebDAVDBKey(
			'sim-account',
			getNutstoreDavEndpoint(world.settings),
			REMOTE_BASE_DIR,
		)
		await traverseWebDAVKV.unset(traversalKey)

		let injected403Count = 0
		const encodedProtected = encodeURIComponent('受限文档 & 权限 🔒.md')
		const propfind403Handler: typeof obsidianRuntime.requestUrlHandler = async (
			req,
		) => {
			const res = await world.remote.handleRequestUrl(req)
			const param = typeof req === 'string' ? { url: req } : req
			if (
				(param.method ?? 'GET').toUpperCase() === 'PROPFIND' &&
				res.status === 207 &&
				res.text.includes(encodedProtected)
			) {
				injected403Count++
				const replaced = res.text.replace(
					new RegExp(
						`<D:response><D:href>[^<]*${encodedProtected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</D:href>[\\s\\S]*?</D:response>`,
					),
					`<D:response><D:href>/dav${REMOTE_BASE_DIR}notes/${encodedProtected}</D:href><D:propstat><D:prop><D:getetag/></D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat></D:response>`,
				)
				return { ...res, text: replaced }
			}
			return res
		}

		// Round 1 (full scan): protected file stays intact; healthy file updates sync normally
		world.clock.advance(2_000)
		world.vault.seedFile(healthyRel, 'healthy v2 正常更新 🌱')
		expect(
			(await runSync(world, { requestUrlHandler: propfind403Handler }))
				.completed,
		).toBe(true)
		expect(injected403Count).toBe(1)
		expect(world.vault.readTextDirect(protectedRel)).toBe(
			'protected content 受限内容 🔒',
		)
		expect(decoder.decode(world.remote.readBytesDirect(healthyAbs)!)).toBe(
			'healthy v2 正常更新 🌱',
		)
		expect(await world.syncRecord.getRecord(protectedRel)).toBeDefined()
		const cachedAfterRound1 = await traverseWebDAVKV.get(traversalKey)
		expect(cachedAfterRound1?.unreadablePaths).toEqual([
			{
				path: protectedAbs,
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])

		// Round 2 (incremental delta scan): persisted unreadablePaths MUST keep protecting local file
		world.clock.advance(2_000)
		world.remote.seedFile(healthyAbs, 'healthy v3 远端更新 📘')
		expect(
			(await runSync(world, { requestUrlHandler: propfind403Handler }))
				.completed,
		).toBe(true)
		expect(world.vault.readTextDirect(protectedRel)).toBe(
			'protected content 受限内容 🔒',
		)
		expect(world.vault.readTextDirect(healthyRel)).toBe(
			'healthy v3 远端更新 📘',
		)
		expect(await world.syncRecord.getRecord(protectedRel)).toBeDefined()

		// Restore permissions on remote: next delta clears protection and converges cleanly
		world.clock.advance(2_000)
		world.remote.seedFile(protectedAbs, 'protected content 恢复可读 ✅')
		expect((await runSync(world)).completed).toBe(true)
		expect(world.vault.readTextDirect(protectedRel)).toBe(
			'protected content 恢复可读 ✅',
		)
		expect(
			(await traverseWebDAVKV.get(traversalKey))?.unreadablePaths,
		).toBeUndefined()
		await assertRecordsHonest(world)
	})

	it('aborts instead of authorizing remote deletion when /delta returns an HTTP 200 HTML error page', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		const relPath = 'notes/关键档案 100% 📘.md'
		const absPath = `${REMOTE_BASE_DIR}${relPath}`

		world.vault.seedFile(relPath, 'version A 初始版本')
		expect((await runSync(world)).completed).toBe(true)

		// Local deletes A while remote updates to B
		world.clock.advance(2_000)
		world.vault.removeDirect(relPath)
		world.remote.seedFile(absPath, 'version B 远端新版本 🌟')

		let interceptedDelta = false
		const htmlDeltaHandler: typeof obsidianRuntime.requestUrlHandler = async (
			req,
		) => {
			const param = typeof req === 'string' ? { url: req } : req
			if (param.url.endsWith('/delta')) {
				interceptedDelta = true
				return {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
					text: '<html><body>临时维护页 🚧</body></html>',
					arrayBuffer: new ArrayBuffer(0),
					json: null,
				} as never
			}
			return world.remote.handleRequestUrl(req)
		}

		// Sync MUST fail rather than falling back to stale mirror and deleting remote B
		const failedRun = await runSync(world, {
			requestUrlHandler: htmlDeltaHandler,
		})
		expect(interceptedDelta).toBe(true)
		expect(failedRun.completed).toBe(false)
		expect(failedRun.error?.message).toContain('missing <response>')
		expect(decoder.decode(world.remote.readBytesDirect(absPath)!)).toBe(
			'version B 远端新版本 🌟',
		)

		// Once delta recovers, remote B is pulled to local
		expect((await runSync(world)).completed).toBe(true)
		expect(world.vault.readTextDirect(relPath)).toBe('version B 远端新版本 🌟')
		await assertRecordsHonest(world)
	})

	it('preserves concurrent local edits during remote-wins and three-way ConflictResolveTask merges and aligns UTF-8 BOM on local-wins', async () => {
		const world = createSyncWorld({
			policy: SyncPolicy.TwoWay,
			conflictStrategy: ConflictStrategy.NoConflictMerge,
		})

		// 1. Remote-wins merge where user appends a new local paragraph during remote GET
		const remoteWinsRel = 'notes/下载期本地编辑 🌱.md'
		const remoteWinsAbs = `${REMOTE_BASE_DIR}${remoteWinsRel}`
		world.vault.seedFile(remoteWinsRel, 'line-1\nline-2\n')
		expect((await runSync(world)).completed).toBe(true)

		world.clock.advance(2_000)
		// Local adds line-3, remote supersedes with line-3 + line-4 (initially remote-wins)
		world.vault.seedFile(remoteWinsRel, 'line-1\nline-2\nline-3\n')
		world.remote.seedFile(
			remoteWinsAbs,
			'line-1\nline-2\nline-3\nline-4-remote\n',
		)

		let editedDuringGet = false
		world.remote.onAfterOp = (op) => {
			if (
				!editedDuringGet &&
				(op.op === 'get' || op.op === 'rangeGet') &&
				op.path === remoteWinsAbs
			) {
				editedDuringGet = true
				world.clock.advance(2_000)
				world.vault.seedFile(
					remoteWinsRel,
					'line-0-user-edit ✨\nline-1\nline-2\nline-3\n',
				)
			}
		}

		expect((await runSync(world)).completed).toBe(true)
		world.remote.onAfterOp = undefined
		expect(editedDuringGet).toBe(true)
		// User's concurrent edit MUST survive (either re-merged immediately or preserved for next sync)
		expect(world.vault.readTextDirect(remoteWinsRel)).toContain(
			'line-0-user-edit ✨',
		)
		expect((await runSync(world)).completed).toBe(true)
		expect(world.vault.readTextDirect(remoteWinsRel)).toBe(
			'line-0-user-edit ✨\nline-1\nline-2\nline-3\nline-4-remote\n',
		)
		expect(decoder.decode(world.remote.readBytesDirect(remoteWinsAbs)!)).toBe(
			'line-0-user-edit ✨\nline-1\nline-2\nline-3\nline-4-remote\n',
		)

		// 2. Local-wins merge where local carries UTF-8 BOM: remote must receive exact BOM bytes
		const localBomRel = 'notes/本地BOM胜出 📘.md'
		const localBomAbs = `${REMOTE_BASE_DIR}${localBomRel}`
		world.clock.advance(2_000)
		world.vault.seedFile(localBomRel, 'alpha\n')
		expect((await runSync(world)).completed).toBe(true)

		world.clock.advance(2_000)
		const bomLocalBytes = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode('alpha\nbeta\ngamma-本地 🌟\n'),
		])
		world.vault.seedFile(localBomRel, bomLocalBytes)
		world.remote.seedFile(localBomAbs, 'alpha\nbeta\n')

		expect((await runSync(world)).completed).toBe(true)
		expect(world.remote.readBytesDirect(localBomAbs)).toEqual(bomLocalBytes)
		expect(world.vault.snapshotFiles().get(localBomRel)).toEqual(bomLocalBytes)

		// 3. BOM-only divergence (`isIdentical` on decoded text, different raw bytes) aligns bytes cleanly
		const bomOnlyRel = 'notes/纯BOM差异 🌿.md'
		const bomOnlyAbs = `${REMOTE_BASE_DIR}${bomOnlyRel}`
		world.clock.advance(2_000)
		world.vault.seedFile(bomOnlyRel, 'base-text\n')
		expect((await runSync(world)).completed).toBe(true)

		world.clock.advance(2_000)
		const bomOnlyLocal = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode('same-text 同步文本\n'),
		])
		const bomOnlyRemote = new TextEncoder().encode('same-text 同步文本\n')
		world.vault.seedFile(bomOnlyRel, bomOnlyLocal)
		world.remote.seedFile(bomOnlyAbs, bomOnlyRemote)

		expect((await runSync(world)).completed).toBe(true)
		expect(world.vault.snapshotFiles().get(bomOnlyRel)).toEqual(bomOnlyRemote)
		expect(world.remote.readBytesDirect(bomOnlyAbs)).toEqual(bomOnlyRemote)
		await assertRecordsHonest(world)
	})

	it('protects a previously cached subdirectory that returns per-item PROPFIND 403 during parent reconciliation without deleting local files', async () => {
		const world = createSyncWorld({ policy: SyncPolicy.TwoWay })
		const lockedDirRel = 'notes/受限目录 🔒'
		const lockedFileRel = `${lockedDirRel}/受限子笔记 📘.md`
		const triggerRel = 'notes/触发核验 🌱.md'
		const triggerAbs = `${REMOTE_BASE_DIR}${triggerRel}`

		world.vault.seedFile(lockedFileRel, 'protected subtree content 🔒')
		world.vault.seedFile(triggerRel, 'trigger v1 🌱')
		expect((await runSync(world)).completed).toBe(true)
		// Second sync ensures `notes/` and `notes/受限目录 🔒/` are cached in the remote mirror
		expect((await runSync(world)).completed).toBe(true)

		world.clock.advance(2_000)
		world.remote.seedFile(triggerAbs, 'trigger v2 🌱')

		const encodedTrigger = encodeURIComponent('触发核验 🌱.md')
		const encodedLockedDir = encodeURIComponent('受限目录 🔒')
		let injected404 = false
		let injected403 = false

		const handler: typeof obsidianRuntime.requestUrlHandler = async (req) => {
			const param = typeof req === 'string' ? { url: req } : req
			const method = (param.method ?? 'GET').toUpperCase()
			const depth = param.headers?.Depth ?? param.headers?.depth ?? ''
			if (
				method === 'PROPFIND' &&
				depth === '0' &&
				param.url.includes(encodedTrigger) &&
				!injected404
			) {
				injected404 = true
				return {
					status: 404,
					headers: {},
					text: 'Not Found',
					arrayBuffer: new ArrayBuffer(0),
					json: null,
				} as never
			}
			const res = await world.remote.handleRequestUrl(req)
			if (
				method === 'PROPFIND' &&
				depth === '1' &&
				res.status === 207 &&
				res.text.includes(encodedLockedDir)
			) {
				injected403 = true
				const replaced = res.text.replace(
					new RegExp(
						`<D:response><D:href>[^<]*${encodedLockedDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</D:href>[\\s\\S]*?</D:response>`,
					),
					`<D:response><D:href>/dav${REMOTE_BASE_DIR}notes/${encodedLockedDir}</D:href><D:propstat><D:prop><D:getetag/></D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat></D:response>`,
				)
				return { ...res, text: replaced }
			}
			return res
		}

		expect(
			(await runSync(world, { requestUrlHandler: handler })).completed,
		).toBe(true)
		expect(injected404).toBe(true)
		expect(injected403).toBe(true)

		// Local files inside the 403 directory MUST survive and stay protected across runs
		expect(world.vault.readTextDirect(lockedFileRel)).toBe(
			'protected subtree content 🔒',
		)
		expect(world.vault.readTextDirect(triggerRel)).toBe('trigger v2 🌱')
		const kvKey = await getTraversalWebDAVDBKey(
			'sim-account',
			getNutstoreDavEndpoint(world.settings),
			REMOTE_BASE_DIR,
		)
		const cached = await traverseWebDAVKV.get(kvKey)
		expect(cached?.unreadablePaths).toEqual([
			{
				path: `${REMOTE_BASE_DIR}${lockedDirRel}`,
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])
	})
})
