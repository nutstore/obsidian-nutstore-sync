import { App } from 'obsidian'
import { NutstoreSettingTab } from '.'
import NutstorePlugin from '..'

export default abstract class BaseSettings {
	constructor(
		protected app: App,
		protected plugin: NutstorePlugin,
		protected settings: NutstoreSettingTab,
		protected containerEl: HTMLElement,
	) {}

	abstract display(): void
}
