import { isEqual } from 'es-toolkit/compat'
import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'
import type {
	ChatMetaFile,
	ChatMetaSessionInfo,
	ChatSessionFilePayload,
} from '~/ai/chat/session/session-files'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import type {
	AgentExecution,
	AppUIMessage,
	ChatAgentState,
	ChatAgentStatus,
	ToolTiming,
} from '~/ai/chat/types'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'
import type {
	IntelligentMergeParams,
	IntelligentMergeResult,
	MergeEngine,
} from './merge-types'

const CHAT_ROOT_DIR = '.agents/nutstore-sync'
const CHAT_SESSIONS_PREFIX = `${CHAT_ROOT_DIR}/sessions/`
const CHAT_META_PATH = `${CHAT_ROOT_DIR}/chat-meta.json`

const MISSING = Symbol('missing-value')
type Missing = typeof MISSING

const TERMINAL_AGENT_STATUSES = new Set<ChatAgentStatus>([
	'completed',
	'failed',
	'cancelled',
])

export function isChatSessionPath(filePath: string): boolean {
	const normalized = normalizeVaultPath(filePath.trim()).toLowerCase()
	if (!normalized.startsWith(CHAT_SESSIONS_PREFIX)) {
		return false
	}
	const fileName = normalized.slice(CHAT_SESSIONS_PREFIX.length)
	return (
		fileName.length > '.json'.length &&
		!fileName.includes('/') &&
		fileName.endsWith('.json')
	)
}

export function isChatMetaPath(filePath: string): boolean {
	return normalizeVaultPath(filePath.trim()).toLowerCase() === CHAT_META_PATH
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function setSafeProperty<T>(target: Record<string, T>, key: string, value: T) {
	if (key === '__proto__') {
		Object.defineProperty(target, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		})
	} else {
		target[key] = value
	}
}

function getOwn<T>(
	record: Record<string, T> | undefined,
	key: string,
): T | Missing {
	if (!record || !Object.hasOwn(record, key)) {
		return MISSING
	}
	return record[key]
}

function detectJsonIndent(text: string): number | string | undefined {
	const trimmed = text.trimEnd()
	if (!trimmed.includes('\n')) {
		return undefined
	}
	const match = trimmed.match(/\n([\t ]+)\S/)
	if (!match) {
		return 2
	}
	return match[1].startsWith('\t') ? '\t' : match[1].length
}

function stringifyJsonWithIndent(
	value: unknown,
	indent: number | string | undefined,
): string {
	return `${JSON.stringify(value, null, indent)}\n`
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (left === MISSING || right === MISSING) {
		return left === right
	}
	return isEqual(left, right)
}

function mergeGenericValue(
	base: unknown,
	local: unknown,
	remote: unknown,
	preferRemote: boolean,
): unknown {
	if (valuesEqual(local, remote)) {
		return local
	}
	if (valuesEqual(local, base)) {
		return remote
	}
	if (valuesEqual(remote, base)) {
		return local
	}

	if (
		isPlainObject(local) &&
		isPlainObject(remote) &&
		(isPlainObject(base) || base === MISSING)
	) {
		const baseObj = base === MISSING ? {} : base
		const keys = new Set([
			...Object.keys(local),
			...Object.keys(remote),
			...Object.keys(baseObj),
		])
		const merged = Object.create(null) as Record<string, unknown>
		for (const key of keys) {
			const mergedValue = mergeGenericValue(
				getOwn(baseObj, key),
				getOwn(local, key),
				getOwn(remote, key),
				preferRemote,
			)
			if (mergedValue !== MISSING) {
				setSafeProperty(merged, key, mergedValue)
			}
		}
		return merged
	}

	return preferRemote ? remote : local
}

function mergeStringSetArray(
	base: readonly string[] | undefined,
	local: readonly string[] | undefined,
	remote: readonly string[] | undefined,
	hasBase: boolean,
): string[] | undefined {
	if (local === undefined && remote === undefined) {
		return undefined
	}
	if (isEqual(local, remote)) {
		return local ? [...local] : undefined
	}
	if (hasBase) {
		if (isEqual(local, base)) {
			return remote ? [...remote] : undefined
		}
		if (isEqual(remote, base)) {
			return local ? [...local] : undefined
		}
	}

	const baseSet = new Set(hasBase && Array.isArray(base) ? base : [])
	const localList = Array.isArray(local) ? local : []
	const remoteList = Array.isArray(remote) ? remote : []
	const localSet = new Set(localList)
	const remoteSet = new Set(remoteList)
	const result: string[] = []
	const seen = new Set<string>()

	for (const item of [...localList, ...remoteList]) {
		if (typeof item !== 'string' || seen.has(item)) {
			continue
		}
		const inBase = hasBase && baseSet.has(item)
		const inLocal = localSet.has(item)
		const inRemote = remoteSet.has(item)
		// If item existed in base and was removed by one side, respect deletion.
		if (inBase && (!inLocal || !inRemote)) {
			continue
		}
		seen.add(item)
		result.push(item)
	}

	return result
}

const START_ANCHOR = Symbol('start-anchor')
type AnchorKey = typeof START_ANCHOR | string

interface SequenceRun<T> {
	items: T[]
	sortOrder: number | undefined
	fromRemote: boolean
}

function mergeKeyedSequence<T>(options: {
	baseItems: readonly T[] | undefined
	localItems: readonly T[]
	remoteItems: readonly T[]
	hasBase: boolean
	getKey: (item: T) => string | undefined
	getRunSortOrder: (item: T) => number | undefined
	mergeConflict: (baseItem: T | undefined, localItem: T, remoteItem: T) => T
}): T[] {
	const {
		baseItems,
		localItems,
		remoteItems,
		hasBase,
		getKey,
		getRunSortOrder,
		mergeConflict,
	} = options

	if (isEqual(localItems, remoteItems)) {
		return [...localItems]
	}
	if (hasBase && baseItems) {
		if (isEqual(localItems, baseItems)) {
			return [...remoteItems]
		}
		if (isEqual(remoteItems, baseItems)) {
			return [...localItems]
		}
	}

	const toMap = (items: readonly T[]) => {
		const map = new Map<string, T>()
		for (const item of items) {
			const key = getKey(item)
			if (key !== undefined) {
				map.set(key, item)
			}
		}
		return map
	}

	const baseMap = hasBase && baseItems ? toMap(baseItems) : undefined
	const localMap = toMap(localItems)
	const remoteMap = toMap(remoteItems)

	const surviving = new Map<string, T>()
	const allKeys = new Set<string>([
		...(baseMap?.keys() ?? []),
		...localMap.keys(),
		...remoteMap.keys(),
	])

	for (const key of allKeys) {
		const baseVal = baseMap?.get(key)
		const localVal = localMap.get(key)
		const remoteVal = remoteMap.get(key)

		if (localVal !== undefined && remoteVal !== undefined) {
			if (isEqual(localVal, remoteVal)) {
				surviving.set(key, localVal)
			} else if (baseVal !== undefined && isEqual(localVal, baseVal)) {
				surviving.set(key, remoteVal)
			} else if (baseVal !== undefined && isEqual(remoteVal, baseVal)) {
				surviving.set(key, localVal)
			} else {
				surviving.set(key, mergeConflict(baseVal, localVal, remoteVal))
			}
		} else if (localVal !== undefined) {
			if (baseVal !== undefined && isEqual(localVal, baseVal)) {
				// Deleted remotely while unchanged locally.
				continue
			}
			surviving.set(key, localVal)
		} else if (remoteVal !== undefined) {
			if (baseVal !== undefined && isEqual(remoteVal, baseVal)) {
				// Deleted locally while unchanged remotely.
				continue
			}
			surviving.set(key, remoteVal)
		}
	}

	const backboneKeys: string[] = []
	if (hasBase && baseItems) {
		const seen = new Set<string>()
		for (const item of baseItems) {
			const key = getKey(item)
			if (key !== undefined && surviving.has(key) && !seen.has(key)) {
				seen.add(key)
				backboneKeys.push(key)
			}
		}
	} else {
		const seen = new Set<string>()
		for (const item of localItems) {
			const key = getKey(item)
			if (
				key !== undefined &&
				surviving.has(key) &&
				remoteMap.has(key) &&
				!seen.has(key)
			) {
				seen.add(key)
				backboneKeys.push(key)
			}
		}
	}

	const backboneSet = new Set(backboneKeys)

	const collectRuns = (items: readonly T[], fromRemote: boolean) => {
		const runsByAnchor = new Map<AnchorKey, SequenceRun<T>[]>()
		let currentAnchor: AnchorKey = START_ANCHOR
		let currentItems: T[] = []

		const flushRun = () => {
			if (currentItems.length === 0) return
			const list = runsByAnchor.get(currentAnchor) ?? []
			list.push({
				items: currentItems,
				sortOrder: getRunSortOrder(currentItems[0]),
				fromRemote,
			})
			runsByAnchor.set(currentAnchor, list)
			currentItems = []
		}

		for (const item of items) {
			const key = getKey(item)
			if (key === undefined || !surviving.has(key)) {
				continue
			}
			if (backboneSet.has(key)) {
				flushRun()
				currentAnchor = key
			} else {
				currentItems.push(surviving.get(key)!)
			}
		}
		flushRun()
		return runsByAnchor
	}

	const localRuns = collectRuns(localItems, false)
	const remoteRuns = collectRuns(remoteItems, true)

	const result: T[] = []
	const emitted = new Set<string>()

	const emitItem = (item: T) => {
		const key = getKey(item)
		if (key === undefined || emitted.has(key)) {
			return
		}
		emitted.add(key)
		result.push(item)
	}

	const emitRunsAt = (anchor: AnchorKey) => {
		const combined = [
			...(localRuns.get(anchor) ?? []),
			...(remoteRuns.get(anchor) ?? []),
		]
		if (combined.length > 1) {
			combined.sort((a, b) => {
				if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
					if (a.sortOrder !== b.sortOrder) {
						return a.sortOrder - b.sortOrder
					}
				}
				return Number(a.fromRemote) - Number(b.fromRemote)
			})
		}
		for (const run of combined) {
			for (const item of run.items) {
				emitItem(item)
			}
		}
	}

	emitRunsAt(START_ANCHOR)
	for (const anchorKey of backboneKeys) {
		const item = surviving.get(anchorKey)
		if (item !== undefined) {
			emitItem(item)
		}
		emitRunsAt(anchorKey)
	}

	// Safety net: ensure any remaining surviving item is never dropped.
	for (const [key, item] of surviving) {
		if (!emitted.has(key)) {
			emitItem(item)
		}
	}

	return result
}

function getMessageId(message: AppUIMessage): string | undefined {
	return isPlainObject(message) && typeof message.id === 'string'
		? message.id
		: undefined
}

function getMessageTimestamp(message: AppUIMessage): number | undefined {
	const createdAt = message?.metadata?.createdAt
	return typeof createdAt === 'number' && Number.isFinite(createdAt)
		? createdAt
		: undefined
}

function mergeMessage(
	base: AppUIMessage | undefined,
	local: AppUIMessage,
	remote: AppUIMessage,
	preferRemote: boolean,
): AppUIMessage {
	const merged = mergeGenericValue(base ?? MISSING, local, remote, preferRemote)
	return isPlainObject(merged)
		? (merged as unknown as AppUIMessage)
		: preferRemote
			? remote
			: local
}

function mergeExecution(
	base: AgentExecution | undefined,
	local: AgentExecution,
	remote: AgentExecution,
	preferRemote: boolean,
): AgentExecution {
	const merged = mergeGenericValue(
		base ?? MISSING,
		local,
		remote,
		preferRemote,
	) as AgentExecution
	if (
		typeof local.finishedAt === 'number' &&
		typeof remote.finishedAt === 'number'
	) {
		merged.finishedAt = Math.max(local.finishedAt, remote.finishedAt)
	}
	return merged
}

function mergeToolTimings(
	base: Record<string, ToolTiming> | undefined,
	local: Record<string, ToolTiming> | undefined,
	remote: Record<string, ToolTiming> | undefined,
	hasBase: boolean,
	preferRemote: boolean,
): Record<string, ToolTiming> {
	const baseMap = hasBase && isPlainObject(base) ? base : {}
	const localMap = isPlainObject(local) ? local : {}
	const remoteMap = isPlainObject(remote) ? remote : {}
	const keys = new Set([
		...Object.keys(baseMap),
		...Object.keys(localMap),
		...Object.keys(remoteMap),
	])
	const merged = Object.create(null) as Record<string, ToolTiming>

	for (const key of keys) {
		const bVal = hasBase ? getOwn(baseMap, key) : MISSING
		const lVal = getOwn(localMap, key)
		const rVal = getOwn(remoteMap, key)
		if (lVal !== MISSING && rVal !== MISSING) {
			if (isEqual(lVal, rVal)) {
				setSafeProperty(merged, key, lVal)
			} else if (bVal !== MISSING && isEqual(lVal, bVal)) {
				setSafeProperty(merged, key, rVal)
			} else if (bVal !== MISSING && isEqual(rVal, bVal)) {
				setSafeProperty(merged, key, lVal)
			} else {
				const primary = preferRemote ? rVal : lVal
				const secondary = preferRemote ? lVal : rVal
				const startedAt =
					typeof lVal.startedAt === 'number' &&
					typeof rVal.startedAt === 'number'
						? Math.min(lVal.startedAt, rVal.startedAt)
						: primary.startedAt
				const finishedAt =
					typeof lVal.finishedAt === 'number' &&
					typeof rVal.finishedAt === 'number'
						? Math.max(lVal.finishedAt, rVal.finishedAt)
						: (primary.finishedAt ?? secondary.finishedAt)
				setSafeProperty(merged, key, {
					startedAt,
					...(finishedAt !== undefined ? { finishedAt } : {}),
				})
			}
		} else {
			const val = mergeGenericValue(bVal, lVal, rVal, preferRemote)
			if (val !== MISSING) {
				setSafeProperty(merged, key, val as ToolTiming)
			}
		}
	}

	return merged
}

function collectMessageIds(
	agent: ChatAgentState | undefined,
	into: Set<string>,
) {
	if (!agent) return
	if (Array.isArray(agent.timeline)) {
		for (const msg of agent.timeline) {
			const id = getMessageId(msg)
			if (id !== undefined) into.add(id)
		}
	}
	if (Array.isArray(agent.pendingInputs)) {
		for (const msg of agent.pendingInputs) {
			const id = getMessageId(msg)
			if (id !== undefined) into.add(id)
		}
	}
}

function mergeAgentState(
	base: ChatAgentState | undefined,
	local: ChatAgentState,
	remote: ChatAgentState,
	hasBase: boolean,
	preferRemote: boolean,
): ChatAgentState {
	if (isEqual(local, remote)) {
		return local
	}
	if (hasBase && base) {
		if (isEqual(local, base)) return remote
		if (isEqual(remote, base)) return local
	}

	const localTimeline = Array.isArray(local.timeline) ? local.timeline : []
	const remoteTimeline = Array.isArray(remote.timeline) ? remote.timeline : []
	const baseTimeline =
		hasBase && Array.isArray(base?.timeline) ? base.timeline : undefined

	const mergedTimeline = mergeKeyedSequence({
		baseItems: baseTimeline,
		localItems: localTimeline,
		remoteItems: remoteTimeline,
		hasBase,
		getKey: getMessageId,
		getRunSortOrder: getMessageTimestamp,
		mergeConflict: (b, l, r) => mergeMessage(b, l, r, preferRemote),
	})

	const localPending = Array.isArray(local.pendingInputs)
		? local.pendingInputs
		: []
	const remotePending = Array.isArray(remote.pendingInputs)
		? remote.pendingInputs
		: []
	const basePending =
		hasBase && Array.isArray(base?.pendingInputs)
			? base.pendingInputs
			: undefined

	const mergedPending = mergeKeyedSequence({
		baseItems: basePending,
		localItems: localPending,
		remoteItems: remotePending,
		hasBase,
		getKey: getMessageId,
		getRunSortOrder: getMessageTimestamp,
		mergeConflict: (b, l, r) => mergeMessage(b, l, r, preferRemote),
	})

	const allInputMessageIds = new Set<string>()
	collectMessageIds(hasBase ? base : undefined, allInputMessageIds)
	collectMessageIds(local, allInputMessageIds)
	collectMessageIds(remote, allInputMessageIds)

	const survivingMessageIds = new Set<string>()
	for (const msg of mergedTimeline) {
		const id = getMessageId(msg)
		if (id !== undefined) survivingMessageIds.add(id)
	}
	for (const msg of mergedPending) {
		const id = getMessageId(msg)
		if (id !== undefined) survivingMessageIds.add(id)
	}

	const baseOps =
		hasBase && isPlainObject(base?.operations) ? base.operations : {}
	const localOps = isPlainObject(local.operations) ? local.operations : {}
	const remoteOps = isPlainObject(remote.operations) ? remote.operations : {}
	const opKeys = new Set([
		...Object.keys(baseOps),
		...Object.keys(localOps),
		...Object.keys(remoteOps),
	])
	const mergedOperations = Object.create(null) as ChatAgentState['operations']
	for (const messageId of opKeys) {
		// Remove operations whose message was explicitly deleted/recalled in the merge.
		if (
			allInputMessageIds.has(messageId) &&
			!survivingMessageIds.has(messageId)
		) {
			continue
		}
		const mergedOpList = mergeGenericValue(
			hasBase ? getOwn(baseOps, messageId) : MISSING,
			getOwn(localOps, messageId),
			getOwn(remoteOps, messageId),
			preferRemote,
		)
		if (mergedOpList !== MISSING && Array.isArray(mergedOpList)) {
			setSafeProperty(mergedOperations, messageId, mergedOpList)
		}
	}

	const mergedToolTimings = mergeToolTimings(
		base?.toolTimings,
		local.toolTimings,
		remote.toolTimings,
		hasBase,
		preferRemote,
	)

	const baseSubagents =
		hasBase && isPlainObject(base?.subagents) ? base.subagents : {}
	const localSubagents = isPlainObject(local.subagents) ? local.subagents : {}
	const remoteSubagents = isPlainObject(remote.subagents)
		? remote.subagents
		: {}
	const subagentKeys = new Set([
		...Object.keys(baseSubagents),
		...Object.keys(localSubagents),
		...Object.keys(remoteSubagents),
	])
	const mergedSubagents = Object.create(null) as Record<string, ChatAgentState>
	for (const childId of subagentKeys) {
		const bChild = hasBase ? getOwn(baseSubagents, childId) : MISSING
		const lChild = getOwn(localSubagents, childId)
		const rChild = getOwn(remoteSubagents, childId)
		if (lChild !== MISSING && rChild !== MISSING) {
			setSafeProperty(
				mergedSubagents,
				childId,
				mergeAgentState(
					bChild === MISSING ? undefined : bChild,
					lChild,
					rChild,
					hasBase && bChild !== MISSING,
					preferRemote,
				),
			)
		} else {
			const val = mergeGenericValue(bChild, lChild, rChild, preferRemote)
			if (val !== MISSING && isPlainObject(val)) {
				setSafeProperty(
					mergedSubagents,
					childId,
					val as unknown as ChatAgentState,
				)
			}
		}
	}

	const mergedReadVaultPaths = mergeStringSetArray(
		base?.readVaultPaths,
		local.readVaultPaths,
		remote.readVaultPaths,
		hasBase,
	)

	const hasExecutions =
		Array.isArray(local.executions) || Array.isArray(remote.executions)
	const mergedExecutions = hasExecutions
		? mergeKeyedSequence({
				baseItems:
					hasBase && Array.isArray(base?.executions)
						? base.executions
						: undefined,
				localItems: Array.isArray(local.executions) ? local.executions : [],
				remoteItems: Array.isArray(remote.executions) ? remote.executions : [],
				hasBase,
				getKey: (item) =>
					isPlainObject(item) && typeof item.id === 'string'
						? item.id
						: undefined,
				getRunSortOrder: (item) =>
					typeof item?.createdAt === 'number' && Number.isFinite(item.createdAt)
						? item.createdAt
						: undefined,
				mergeConflict: (b, l, r) => mergeExecution(b, l, r, preferRemote),
			})
		: undefined

	const mergedAgent = Object.create(null) as Record<string, unknown>
	const handledKeys = new Set([
		'timeline',
		'pendingInputs',
		'operations',
		'toolTimings',
		'subagents',
		'readVaultPaths',
		'executions',
		'status',
		'startedAt',
		'finishedAt',
		'createdAt',
	])

	const baseObj =
		hasBase && isPlainObject(base)
			? (base as unknown as Record<string, unknown>)
			: {}
	const localObj = local as unknown as Record<string, unknown>
	const remoteObj = remote as unknown as Record<string, unknown>
	const allAgentKeys = new Set([
		...Object.keys(baseObj),
		...Object.keys(localObj),
		...Object.keys(remoteObj),
	])

	for (const key of allAgentKeys) {
		if (handledKeys.has(key)) continue
		const val = mergeGenericValue(
			hasBase ? getOwn(baseObj, key) : MISSING,
			getOwn(localObj, key),
			getOwn(remoteObj, key),
			preferRemote,
		)
		if (val !== MISSING) {
			setSafeProperty(mergedAgent, key, val)
		}
	}

	const baseStatus = hasBase ? base?.status : undefined
	let mergedStatus: ChatAgentStatus
	if (local.status === remote.status) {
		mergedStatus = local.status
	} else if (hasBase && local.status === baseStatus) {
		mergedStatus = remote.status
	} else if (hasBase && remote.status === baseStatus) {
		mergedStatus = local.status
	} else if (
		TERMINAL_AGENT_STATUSES.has(local.status) &&
		!TERMINAL_AGENT_STATUSES.has(remote.status)
	) {
		mergedStatus = local.status
	} else if (
		TERMINAL_AGENT_STATUSES.has(remote.status) &&
		!TERMINAL_AGENT_STATUSES.has(local.status)
	) {
		mergedStatus = remote.status
	} else {
		mergedStatus = preferRemote ? remote.status : local.status
	}

	mergedAgent.createdAt =
		typeof local.createdAt === 'number' && typeof remote.createdAt === 'number'
			? Math.min(local.createdAt, remote.createdAt)
			: local.createdAt || remote.createdAt
	mergedAgent.status = mergedStatus

	const startedAt = mergeGenericValue(
		hasBase && base?.startedAt !== undefined ? base.startedAt : MISSING,
		local.startedAt !== undefined ? local.startedAt : MISSING,
		remote.startedAt !== undefined ? remote.startedAt : MISSING,
		preferRemote,
	)
	if (typeof startedAt === 'number') {
		mergedAgent.startedAt =
			typeof local.startedAt === 'number' &&
			typeof remote.startedAt === 'number'
				? Math.min(local.startedAt, remote.startedAt)
				: startedAt
	}

	const finishedAt = mergeGenericValue(
		hasBase && base?.finishedAt !== undefined ? base.finishedAt : MISSING,
		local.finishedAt !== undefined ? local.finishedAt : MISSING,
		remote.finishedAt !== undefined ? remote.finishedAt : MISSING,
		preferRemote,
	)
	if (typeof finishedAt === 'number') {
		mergedAgent.finishedAt =
			typeof local.finishedAt === 'number' &&
			typeof remote.finishedAt === 'number'
				? Math.max(local.finishedAt, remote.finishedAt)
				: finishedAt
	}

	mergedAgent.timeline = mergedTimeline
	mergedAgent.pendingInputs = mergedPending
	mergedAgent.operations = mergedOperations
	mergedAgent.toolTimings = mergedToolTimings
	if (mergedReadVaultPaths !== undefined) {
		mergedAgent.readVaultPaths = mergedReadVaultPaths
	}
	if (mergedExecutions !== undefined) {
		mergedAgent.executions = mergedExecutions
	}
	mergedAgent.subagents = mergedSubagents

	return mergedAgent as unknown as ChatAgentState
}

function isV2Session(value: unknown): value is ChatSession {
	return (
		isPlainObject(value) &&
		value.schemaVersion === 2 &&
		isPlainObject(value.subagents) &&
		isPlainObject(value.subagents.master)
	)
}

function getFiniteTimestamp(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function mergeSessionObjects(
	base: PersistedChatSession | ChatSession | LegacyChatSession | undefined,
	local: PersistedChatSession | ChatSession | LegacyChatSession,
	remote: PersistedChatSession | ChatSession | LegacyChatSession,
	hasBase: boolean,
	preferRemote: boolean,
): PersistedChatSession | ChatSession | LegacyChatSession {
	if (isV2Session(local) && isV2Session(remote)) {
		const baseV2 = hasBase && isV2Session(base) ? base : undefined
		const hasV2Base = hasBase && baseV2 !== undefined

		const merged = Object.create(null) as Record<string, unknown>
		const handledKeys = new Set([
			'createdAt',
			'updatedAt',
			'disabledMcpServers',
			'subagents',
		])

		const baseObj = baseV2 ? (baseV2 as unknown as Record<string, unknown>) : {}
		const localObj = local as unknown as Record<string, unknown>
		const remoteObj = remote as unknown as Record<string, unknown>
		const allKeys = new Set([
			...Object.keys(baseObj),
			...Object.keys(localObj),
			...Object.keys(remoteObj),
		])

		for (const key of allKeys) {
			if (handledKeys.has(key)) continue
			const val = mergeGenericValue(
				hasV2Base ? getOwn(baseObj, key) : MISSING,
				getOwn(localObj, key),
				getOwn(remoteObj, key),
				preferRemote,
			)
			if (val !== MISSING) {
				setSafeProperty(merged, key, val)
			}
		}

		merged.createdAt = Math.min(
			getFiniteTimestamp(local.createdAt) || Number.MAX_SAFE_INTEGER,
			getFiniteTimestamp(remote.createdAt) || Number.MAX_SAFE_INTEGER,
		)
		if (merged.createdAt === Number.MAX_SAFE_INTEGER) {
			merged.createdAt = 0
		}

		merged.updatedAt = Math.max(
			hasV2Base ? getFiniteTimestamp(baseV2?.updatedAt) : 0,
			getFiniteTimestamp(local.updatedAt),
			getFiniteTimestamp(remote.updatedAt),
		)

		const disabledMcpServers = mergeStringSetArray(
			baseV2?.disabledMcpServers,
			local.disabledMcpServers,
			remote.disabledMcpServers,
			hasV2Base,
		)
		if (disabledMcpServers !== undefined) {
			merged.disabledMcpServers = disabledMcpServers
		}

		merged.subagents = {
			master: mergeAgentState(
				baseV2?.subagents.master,
				local.subagents.master,
				remote.subagents.master,
				hasV2Base,
				preferRemote,
			),
		}

		return merged as unknown as ChatSession
	}

	// Mixed V2/Legacy: prefer the already-migrated V2 snapshot when available.
	if (isV2Session(local) && !isV2Session(remote)) {
		return local
	}
	if (isV2Session(remote) && !isV2Session(local)) {
		return remote
	}

	const mergedLegacy = mergeGenericValue(
		hasBase && base ? base : MISSING,
		local,
		remote,
		preferRemote,
	) as Record<string, unknown>
	mergedLegacy.updatedAt = Math.max(
		hasBase && base ? getFiniteTimestamp(base.updatedAt) : 0,
		getFiniteTimestamp(local.updatedAt),
		getFiniteTimestamp(remote.updatedAt),
	)
	return mergedLegacy as unknown as LegacyChatSession
}

function parseSessionPayload(text: string): ChatSessionFilePayload | undefined {
	if (!text.trim()) return undefined
	try {
		const parsed = JSON.parse(text) as unknown
		if (!isPlainObject(parsed) || !isPlainObject(parsed.session)) {
			return undefined
		}
		return parsed as unknown as ChatSessionFilePayload
	} catch {
		return undefined
	}
}

function mergeChatSession({
	localContentText,
	remoteContentText,
	baseContentText,
	hasBase = true,
}: IntelligentMergeParams): IntelligentMergeResult {
	const localPayload = parseSessionPayload(localContentText)
	const remotePayload = parseSessionPayload(remoteContentText)

	if (!localPayload && !remotePayload) {
		return {
			success: false,
			error: 'Invalid chat session JSON on both local and remote',
		}
	}
	if (!localPayload) {
		return { success: true, mergedText: remoteContentText }
	}
	if (!remotePayload) {
		return { success: true, mergedText: localContentText }
	}

	const basePayload =
		hasBase && baseContentText
			? parseSessionPayload(baseContentText)
			: undefined
	const effectiveHasBase = hasBase && basePayload !== undefined

	const localUpdatedAt = getFiniteTimestamp(localPayload.session.updatedAt)
	const remoteUpdatedAt = getFiniteTimestamp(remotePayload.session.updatedAt)
	const preferRemote = remoteUpdatedAt > localUpdatedAt

	const mergedPayload = Object.create(null) as Record<string, unknown>
	const baseRecord = basePayload
		? (basePayload as unknown as Record<string, unknown>)
		: {}
	const localRecord = localPayload as unknown as Record<string, unknown>
	const remoteRecord = remotePayload as unknown as Record<string, unknown>

	for (const key of new Set([
		...Object.keys(baseRecord),
		...Object.keys(localRecord),
		...Object.keys(remoteRecord),
	])) {
		if (key === 'session') continue
		const val = mergeGenericValue(
			effectiveHasBase ? getOwn(baseRecord, key) : MISSING,
			getOwn(localRecord, key),
			getOwn(remoteRecord, key),
			preferRemote,
		)
		if (val !== MISSING) {
			setSafeProperty(mergedPayload, key, val)
		}
	}

	mergedPayload.session = mergeSessionObjects(
		basePayload?.session,
		localPayload.session,
		remotePayload.session,
		effectiveHasBase,
		preferRemote,
	)

	const indent = detectJsonIndent(localContentText)
	return {
		success: true,
		mergedText: stringifyJsonWithIndent(mergedPayload, indent),
	}
}

function isValidChatMeta(value: unknown): value is ChatMetaFile {
	return (
		isPlainObject(value) &&
		Array.isArray(value.orderedSessionIds) &&
		isPlainObject(value.sessions)
	)
}

function parseChatMeta(text: string): ChatMetaFile | undefined {
	if (!text.trim()) return undefined
	try {
		const parsed = JSON.parse(text) as unknown
		return isValidChatMeta(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

function mergeChatMetaSessionInfo(
	base: ChatMetaSessionInfo | undefined,
	local: ChatMetaSessionInfo,
	remote: ChatMetaSessionInfo,
): ChatMetaSessionInfo {
	const preferRemote =
		getFiniteTimestamp(remote.updatedAt) > getFiniteTimestamp(local.updatedAt)
	const merged = Object.create(null) as Record<string, unknown>

	const baseRecord = (base ?? {}) as unknown as Record<string, unknown>
	const localRecord = local as unknown as Record<string, unknown>
	const remoteRecord = remote as unknown as Record<string, unknown>

	for (const key of new Set([
		...Object.keys(baseRecord),
		...Object.keys(localRecord),
		...Object.keys(remoteRecord),
	])) {
		if (key === 'createdAt' || key === 'updatedAt') continue
		const val = mergeGenericValue(
			base ? getOwn(baseRecord, key) : MISSING,
			getOwn(localRecord, key),
			getOwn(remoteRecord, key),
			preferRemote,
		)
		if (val !== MISSING) {
			setSafeProperty(merged, key, val)
		}
	}

	merged.createdAt = Math.min(
		getFiniteTimestamp(local.createdAt) || Number.MAX_SAFE_INTEGER,
		getFiniteTimestamp(remote.createdAt) || Number.MAX_SAFE_INTEGER,
	)
	if (merged.createdAt === Number.MAX_SAFE_INTEGER) {
		merged.createdAt = 0
	}
	merged.updatedAt = Math.max(
		base ? getFiniteTimestamp(base.updatedAt) : 0,
		getFiniteTimestamp(local.updatedAt),
		getFiniteTimestamp(remote.updatedAt),
	)

	return merged as unknown as ChatMetaSessionInfo
}

function getMaxSessionUpdatedAt(sessions: Record<string, ChatMetaSessionInfo>) {
	let max = 0
	for (const key of Object.keys(sessions)) {
		const updatedAt = getFiniteTimestamp(sessions[key]?.updatedAt)
		if (updatedAt > max) max = updatedAt
	}
	return max
}

function mergeChatMeta({
	localContentText,
	remoteContentText,
	baseContentText,
	hasBase = true,
}: IntelligentMergeParams): IntelligentMergeResult {
	const localMeta = parseChatMeta(localContentText)
	const remoteMeta = parseChatMeta(remoteContentText)

	if (!localMeta && !remoteMeta) {
		return {
			success: false,
			error: 'Invalid chat meta JSON on both local and remote',
		}
	}
	if (!localMeta) {
		return { success: true, mergedText: remoteContentText }
	}
	if (!remoteMeta) {
		return { success: true, mergedText: localContentText }
	}

	const baseMeta =
		hasBase && baseContentText ? parseChatMeta(baseContentText) : undefined
	const effectiveHasBase = hasBase && baseMeta !== undefined

	const preferRemote =
		getMaxSessionUpdatedAt(remoteMeta.sessions) >
		getMaxSessionUpdatedAt(localMeta.sessions)

	const baseSessions = effectiveHasBase ? baseMeta.sessions : {}
	const sessionIds = new Set([
		...Object.keys(baseSessions),
		...Object.keys(localMeta.sessions),
		...Object.keys(remoteMeta.sessions),
	])
	const mergedSessions = Object.create(null) as Record<
		string,
		ChatMetaSessionInfo
	>

	for (const id of sessionIds) {
		const bInfo = effectiveHasBase ? getOwn(baseSessions, id) : MISSING
		const lInfo = getOwn(localMeta.sessions, id)
		const rInfo = getOwn(remoteMeta.sessions, id)

		if (lInfo !== MISSING && rInfo !== MISSING) {
			if (isEqual(lInfo, rInfo)) {
				setSafeProperty(mergedSessions, id, lInfo)
			} else if (bInfo !== MISSING && isEqual(lInfo, bInfo)) {
				setSafeProperty(mergedSessions, id, rInfo)
			} else if (bInfo !== MISSING && isEqual(rInfo, bInfo)) {
				setSafeProperty(mergedSessions, id, lInfo)
			} else {
				setSafeProperty(
					mergedSessions,
					id,
					mergeChatMetaSessionInfo(
						bInfo === MISSING ? undefined : bInfo,
						lInfo,
						rInfo,
					),
				)
			}
		} else {
			const val = mergeGenericValue(bInfo, lInfo, rInfo, preferRemote)
			if (val !== MISSING && isPlainObject(val)) {
				setSafeProperty(
					mergedSessions,
					id,
					val as unknown as ChatMetaSessionInfo,
				)
			}
		}
	}

	const mergedOrder = mergeKeyedSequence({
		baseItems: effectiveHasBase ? baseMeta.orderedSessionIds : undefined,
		localItems: localMeta.orderedSessionIds,
		remoteItems: remoteMeta.orderedSessionIds,
		hasBase: effectiveHasBase,
		getKey: (id) => (typeof id === 'string' && id.length > 0 ? id : undefined),
		getRunSortOrder: (id) => {
			const info = getOwn(mergedSessions, id)
			return info !== MISSING ? -getFiniteTimestamp(info.updatedAt) : undefined
		},
		mergeConflict: (_b, l) => l,
	})

	const orderedSet = new Set<string>()
	const cleanedOrder: string[] = []
	for (const id of mergedOrder) {
		if (Object.hasOwn(mergedSessions, id) && !orderedSet.has(id)) {
			orderedSet.add(id)
			cleanedOrder.push(id)
		}
	}
	for (const id of Object.keys(mergedSessions)) {
		if (!orderedSet.has(id)) {
			orderedSet.add(id)
			cleanedOrder.push(id)
		}
	}

	let activeSessionId = mergeGenericValue(
		effectiveHasBase && baseMeta.activeSessionId !== undefined
			? baseMeta.activeSessionId
			: MISSING,
		localMeta.activeSessionId !== undefined
			? localMeta.activeSessionId
			: MISSING,
		remoteMeta.activeSessionId !== undefined
			? remoteMeta.activeSessionId
			: MISSING,
		preferRemote,
	)

	if (
		typeof activeSessionId !== 'string' ||
		!Object.hasOwn(mergedSessions, activeSessionId)
	) {
		const fallbackCandidates = preferRemote
			? [remoteMeta.activeSessionId, localMeta.activeSessionId, cleanedOrder[0]]
			: [localMeta.activeSessionId, remoteMeta.activeSessionId, cleanedOrder[0]]
		activeSessionId = fallbackCandidates.find(
			(id): id is string =>
				typeof id === 'string' && Object.hasOwn(mergedSessions, id),
		)
	}

	const mergedMeta = Object.create(null) as Record<string, unknown>
	const baseRecord = (baseMeta ?? {}) as unknown as Record<string, unknown>
	const localRecord = localMeta as unknown as Record<string, unknown>
	const remoteRecord = remoteMeta as unknown as Record<string, unknown>

	for (const key of new Set([
		...Object.keys(baseRecord),
		...Object.keys(localRecord),
		...Object.keys(remoteRecord),
	])) {
		if (
			key === 'activeSessionId' ||
			key === 'orderedSessionIds' ||
			key === 'sessions'
		) {
			continue
		}
		const val = mergeGenericValue(
			effectiveHasBase ? getOwn(baseRecord, key) : MISSING,
			getOwn(localRecord, key),
			getOwn(remoteRecord, key),
			preferRemote,
		)
		if (val !== MISSING) {
			setSafeProperty(mergedMeta, key, val)
		}
	}

	if (typeof activeSessionId === 'string') {
		mergedMeta.activeSessionId = activeSessionId
	}
	mergedMeta.orderedSessionIds = cleanedOrder
	mergedMeta.sessions = mergedSessions

	const indent = detectJsonIndent(localContentText) ?? 2
	return {
		success: true,
		mergedText: stringifyJsonWithIndent(mergedMeta, indent),
	}
}

export const chatSessionMergeEngine: MergeEngine = {
	id: 'chat-session',
	match: isChatSessionPath,
	merge: mergeChatSession,
}

export const chatMetaMergeEngine: MergeEngine = {
	id: 'chat-meta',
	match: isChatMetaPath,
	merge: mergeChatMeta,
}
