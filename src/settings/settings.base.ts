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

	/** Public control labels only; indexing must not render controls or read user values. */
	abstract getSearchTerms(): string[]

	abstract display(): Promise<void>
}
