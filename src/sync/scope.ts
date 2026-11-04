import type { FsWalkResult } from '~/fs/fs.interface'
import type { SyncRecordModel } from '~/model/sync-record.model'
import type { BaseTask } from './tasks/task.interface'
import {
	compileFilterRules,
	isPathIncluded,
	type GlobFilterRule,
} from '~/utils/glob-match'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'

export interface ScanIssue {
	path: string
	operation: 'list' | 'stat'
	cause: unknown
}

export interface ScanSnapshot {
	entries: import('~/model/stat.model').StatModel[]
	issues: ScanIssue[]
}

/** `''` (the vault root) first, then each ancestor of `path` down to `path` itself. */
function* pathChain(path: string): Generator<string> {
	yield ''
	if (path === '') return
	for (
		let end = path.indexOf('/');
		end !== -1;
		end = path.indexOf('/', end + 1)
	)
		yield path.slice(0, end)
	yield path
}

/** One run's boundary: unknown or excluded paths never authorize mutations. */
export class SyncScope {
	private readonly rules
	/** Paths whose subtree must stay untouched. Lookups walk a path's ancestors,
	 * so cost follows path depth, not how many paths are protected. */
	private readonly protectedRoots = new Set<string>()
	/** Every proper ancestor of a protected root: answers "does this subtree
	 * contain something protected?" without scanning the roots. */
	private readonly protectedAncestors = new Set<string>()
	readonly issues: ScanIssue[] = []

	constructor(rules: GlobFilterRule[] = []) {
		this.rules = compileFilterRules(rules)
	}

	protect(path: string): void {
		const root = normalizeVaultPath(path)
		if (this.covers(root)) return
		this.protectedRoots.add(root)
		for (const ancestor of pathChain(root)) {
			if (ancestor !== root) this.protectedAncestors.add(ancestor)
		}
	}

	/** Whether `path` is a protected root or lies beneath one. */
	private covers(path: string): boolean {
		for (const prefix of pathChain(path)) {
			if (this.protectedRoots.has(prefix)) return true
		}
		return false
	}

	/** Whether `path` is a protected root or has one somewhere beneath it. */
	private contains(path: string): boolean {
		// `''` is an ancestor of every root, so the vault root needs no special case.
		return this.protectedRoots.has(path) || this.protectedAncestors.has(path)
	}

	report(issue: ScanIssue): void {
		this.issues.push({ ...issue, path: normalizeVaultPath(issue.path) })
		this.protect(issue.path)
	}

	includes(path: string, isDir = false): boolean {
		const normalized = normalizeVaultPath(path)
		return (
			isPathIncluded(normalized, this.rules, isDir) && !this.covers(normalized)
		)
	}

	/** Path type controls filter matching; mutation extent controls ancestor
	 * protection. A write to a file may affect a subtree without being a directory. */
	allows(
		path: string,
		{
			subtree = false,
			isDir = false,
		}: { subtree?: boolean; isDir?: boolean } = {},
	): boolean {
		const normalized = normalizeVaultPath(path)
		return (
			this.includes(normalized, isDir) &&
			(!subtree || !this.contains(normalized))
		)
	}

	/** A task runs only if every path it may change is in scope. */
	allowsTask(task: BaseTask): boolean {
		return task.scopeTargets.every((target) => this.allows(target.path, target))
	}

	/** A sync record may be rewritten or dropped as a whole subtree. */
	allowsRecord(path: string, record: SyncRecordModel): boolean {
		return this.allows(path, { subtree: true, isDir: record.local.isDir })
	}

	observe(entries: readonly FsWalkResult[]): void {
		for (const { stat, ignored } of entries) {
			if (ignored || !isPathIncluded(stat.path, this.rules, stat.isDir)) {
				this.protect(stat.path)
			}
		}
	}

	apply(entries: readonly FsWalkResult[]): FsWalkResult[] {
		return entries.map(({ stat, ignored }) => ({
			stat,
			ignored:
				ignored ||
				!this.allows(stat.path, { isDir: stat.isDir, subtree: !stat.isDir }),
		}))
	}
}
