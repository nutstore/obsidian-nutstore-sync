import { App } from 'obsidian'
import { NutstoreSettingTab } from '.'
import NutstorePlugin from '..'

export default abstract class BaseSettings {
	/** Dynamic because translated labels may change while the settings pane is open. */
	abstract readonly name: () => string
	readonly searchable: boolean = true
	abstract readonly showGroupHeading: boolean

	constructor(
		protected app: App,
		protected plugin: NutstorePlugin,
		protected settings: NutstoreSettingTab,
		public readonly containerEl: HTMLElement,
	) {}

	/** Public control labels only; indexing must not render controls or read user values. */
	abstract getSearchTerms(): string[]

	abstract display(): Promise<void>
}
