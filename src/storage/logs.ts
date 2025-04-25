import { Plugin } from 'obsidian'
import { join } from 'path'
import { isNil } from 'ramda'
import useStorage, { StorageInterface } from './use-storage'

export class LogsStorage extends StorageInterface<string> {
	constructor(private plugin: Plugin) {
		super()
	}

	get logsDir() {
		const pluginDir = this.plugin.manifest.dir
		if (isNil(pluginDir)) {
			return
		}
		return join(pluginDir, 'logs')
	}

	private async checkLogsDir() {
		if (isNil(this.logsDir)) {
			return false
		}
		const logsDir = this.logsDir
		if (await this.plugin.app.vault.adapter.exists(logsDir)) {
			const stat = await this.plugin.app.vault.adapter.stat(logsDir)
			if (!stat || stat.type === 'file') {
				return false
			}
		} else {
			await this.plugin.app.vault.adapter.mkdir(logsDir)
		}
		return true
	}

	async setItem(key: string, value: string): Promise<string> {
		if (!(await this.checkLogsDir())) {
			throw new Error('Failed to access logs directory')
		}
		await this.plugin.app.vault.adapter.write(join(this.logsDir!, key), value)
		return value
	}

	async getItem(key: string): Promise<string | null> {
		if (!(await this.checkLogsDir())) {
			return null
		}
		const filePath = join(this.logsDir!, key)

		if (!(await this.plugin.app.vault.adapter.exists(filePath))) {
			return null
		}

		try {
			const content = await this.plugin.app.vault.adapter.read(filePath)
			return content
		} catch {
			return null
		}
	}

	async removeItem(key: string): Promise<void> {
		if (!(await this.checkLogsDir())) {
			return
		}
		const filePath = join(this.logsDir!, key)
		if (await this.plugin.app.vault.adapter.exists(filePath)) {
			await this.plugin.app.vault.adapter.remove(filePath)
		}
	}

	async keys(): Promise<string[]> {
		if (!(await this.checkLogsDir())) {
			return []
		}

		try {
			const files = await this.plugin.app.vault.adapter.list(this.logsDir!)
			return files.files
		} catch {
			return []
		}
	}

	async clear(): Promise<void> {
		if (!(await this.checkLogsDir())) {
			return
		}
		const allKeys = await this.keys()
		for (const key of allKeys) {
			await this.removeItem(key)
		}
	}
}

export function useLogsStorage(plugin: Plugin) {
	return useStorage(new LogsStorage(plugin))
}
