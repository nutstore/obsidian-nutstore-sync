import type { FsWalkResult } from '~/fs/fs.interface'
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

function contains(parent: string, path: string): boolean {
	return parent === '' || parent === path || path.startsWith(`${parent}/`)
}

/** One run's boundary: unknown or excluded paths never authorize mutations. */
export class SyncScope {
	private readonly rules
	private readonly protectedRoots = new Set<string>()
	readonly issues: ScanIssue[] = []

	constructor(rules: GlobFilterRule[] = []) {
		this.rules = compileFilterRules(rules)
	}

	protect(path: string): void {
		const root = normalizeVaultPath(path)
		if ([...this.protectedRoots].some((parent) => contains(parent, root)))
			return
		for (const child of this.protectedRoots) {
			if (contains(root, child)) this.protectedRoots.delete(child)
		}
		this.protectedRoots.add(root)
	}

	report(issue: ScanIssue): void {
		this.issues.push({ ...issue, path: normalizeVaultPath(issue.path) })
		this.protect(issue.path)
	}

	includes(path: string, isDir = false): boolean {
		const normalized = normalizeVaultPath(path)
		return (
			isPathIncluded(normalized, this.rules, isDir) &&
			![...this.protectedRoots].some((root) => contains(root, normalized))
		)
	}

	/** Destructive directory operations must also protect ancestors. */
	allows(path: string, subtree = false): boolean {
		const normalized = normalizeVaultPath(path)
		return (
			this.includes(normalized, subtree) &&
			(!subtree ||
				![...this.protectedRoots].some((root) => contains(normalized, root)))
		)
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
				!this.includes(stat.path, stat.isDir) ||
				(!stat.isDir && !this.allows(stat.path, true)),
		}))
	}
}
