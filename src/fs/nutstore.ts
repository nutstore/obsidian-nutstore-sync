import { Vault } from 'obsidian'
import { isAbsolute } from 'path-browserify'
import { isNotNil } from 'ramda'
import { createClient, WebDAVClient } from 'webdav'
import { NS_DAV_ENDPOINT } from '~/consts'
import { useSettings } from '~/settings'
import { getTraversalWebDAVDBKey } from '~/utils/get-db-key'
import GlobMatch, {
	extendRules,
	GlobMatchOptions,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import { stdRemotePath } from '~/utils/std-remote-path'
import { ResumableWebDAVTraversal } from '~/utils/traverse-webdav'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class NutstoreFileSystem implements AbstractFileSystem {
	private webdav: WebDAVClient

	constructor(
		private options: {
			vault: Vault
			token: string
			remoteBaseDir: string
		},
	) {
		this.webdav = createClient(NS_DAV_ENDPOINT, {
			headers: {
				Authorization: `Basic ${this.options.token}`,
			},
		})
	}

	async walk() {
		const traversal = new ResumableWebDAVTraversal({
			token: this.options.token,
			remoteBaseDir: this.options.remoteBaseDir,
			kvKey: await getTraversalWebDAVDBKey(
				this.options.token,
				this.options.remoteBaseDir,
			),
			saveInterval: 1,
		})
		let stats = await traversal.traverse()

		if (stats.length === 0) {
			return []
		}

		const base = stdRemotePath(this.options.remoteBaseDir)
		const subPath = new Set<string>()
		for (let { path } of stats) {
			if (path.endsWith('/')) {
				path = path.slice(0, path.length - 1)
			}
			if (!path.startsWith('/')) {
				path = `/${path}`
			}
			if (isSub(base, path)) {
				subPath.add(path)
			}
		}

		const statsMap = new Map(stats.map((s) => [s.path, s]))
		stats = [...subPath].map((path) => statsMap.get(path)).filter(isNotNil)
		for (const item of stats) {
			if (isAbsolute(item.path)) {
				item.path = item.path.replace(this.options.remoteBaseDir, '')
				if (item.path.startsWith('/')) {
					item.path = item.path.slice(1)
				}
			}
		}

		const settings = await useSettings()
		const exclusions = this.buildRules(settings?.filterRules.exclusionRules)
		const inclusions = this.buildRules(settings?.filterRules.inclusionRules)

		const includedStats = stats.filter((stat) =>
			needIncludeFromGlobRules(stat.path, inclusions, exclusions),
		)
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		const results = stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
		return results
	}

	private buildRules(rules: GlobMatchOptions[] = []): GlobMatch[] {
		return extendRules(
			rules
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
	}
}
