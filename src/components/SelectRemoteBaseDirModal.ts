import { App, Modal } from 'obsidian'
import NutstorePlugin from '..'

import { getDirectoryContents } from '~/api/webdav'
import { fileStatToStatModel } from '~/utils/file-stat-to-stat-model'
import { mkdirsWebDAV } from '~/utils/mkdirs-webdav'
import { stdRemotePath } from '~/utils/std-remote-path'
import { mountWebDAVExplorer } from '../components/solid-js'

export default class SelectRemoteBaseDirModal extends Modal {
	constructor(
		app: App,
		private plugin: NutstorePlugin,
		private onConfirm: (path: string) => void | Promise<void>,
	) {
		super(app)
	}

	async onOpen() {
		const scope = this.plugin.sync.lifecycle.scope
		scope.ownModal(this)
		const { contentEl } = this

		const explorer = createDiv()
		contentEl.appendChild(explorer)

		const webdav = await this.plugin.sync.webdav.createWebDAVClient()

		mountWebDAVExplorer(explorer, {
			fs: {
				ls: async (target: string) => {
					const token = await this.plugin.getToken()
					const items = await getDirectoryContents(
						this.plugin.settings,
						token,
						target,
						scope.check,
					)
					return items.map(fileStatToStatModel)
				},
				mkdirs: async (path: string) => {
					await mkdirsWebDAV(webdav, path)
				},
			},
			onClose: () => {
				explorer.remove()
				this.close()
			},
			onConfirm: (path) => {
				scope.check()
				void Promise.resolve(this.onConfirm(stdRemotePath(path))).then(() => {
					explorer.remove()
					this.close()
				})
			},
		})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
