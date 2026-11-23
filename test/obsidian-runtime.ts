import type {
	RequestUrlParam,
	RequestUrlResponse,
	TAbstractFile as ObsidianTAbstractFile,
	TFile as ObsidianTFile,
	TFolder as ObsidianTFolder,
} from 'obsidian'

export interface ObsidianElementOptions {
	cls?: string | string[]
	text?: string | DocumentFragment
	attr?: Record<string, string | number | boolean | null>
	title?: string
	type?: string
	value?: string
	placeholder?: string
	href?: string
	prepend?: boolean
	parent?: HTMLElement
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isWin: false,
	isMacOS: true,
	isLinux: false,
	isSafari: false,
	isPhone: false,
	isTablet: false,
}

export const obsidianRuntime = {
	notices: [] as Array<{
		message: string | DocumentFragment
		timeout?: number
	}>,
	icons: new Map<string, string>(),
	removedIcons: [] as string[],
	appliedIcons: [] as Array<{ el: HTMLElement; iconId: string }>,
	requestUrlHandler: null as
		((request: RequestUrlParam | string) => Promise<RequestUrlResponse>) | null,
	markdownRenderHandler: null as
		| ((
				app: any,
				markdown: string,
				el: HTMLElement,
				sourcePath: string,
				component: Component,
		  ) => Promise<void> | void)
		| null,
	onNotice: null as
		| ((notice: {
				message: string | DocumentFragment
				timeout?: number
		  }) => void)
		| null,
	onSetIcon: null as ((parent: HTMLElement, iconId: string) => void) | null,
	onAddIcon: null as ((iconId: string, svgContent: string) => void) | null,
	onRemoveIcon: null as ((iconId: string) => void) | null,
	reset() {
		this.notices.length = 0
		this.icons.clear()
		this.removedIcons.length = 0
		this.appliedIcons.length = 0
		this.requestUrlHandler = null
		this.markdownRenderHandler = null
		this.onNotice = null
		this.onSetIcon = null
		this.onAddIcon = null
		this.onRemoveIcon = null
		Object.assign(Platform, {
			isDesktop: true,
			isMobile: false,
			isDesktopApp: true,
			isMobileApp: false,
			isIosApp: false,
			isAndroidApp: false,
			isPhone: false,
			isTablet: false,
		})
	},
}

export const apiVersion = '1.13.0'

export function normalizePath(path: string): string {
	const cleaned = path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+|\/+$/g, '')
	return cleaned || '/'
}

function splitClasses(cls: string | string[]): string[] {
	return (Array.isArray(cls) ? cls : [cls])
		.flatMap((token) => token.split(/\s+/))
		.filter(Boolean)
}

function applyElementOptions(
	el: HTMLElement,
	opts?: ObsidianElementOptions | string,
) {
	if (!opts) return
	if (typeof opts === 'string') {
		const classes = splitClasses(opts)
		if (classes.length) el.classList.add(...classes)
		return
	}
	if (opts.cls) {
		const classes = splitClasses(opts.cls)
		if (classes.length) el.classList.add(...classes)
	}
	if (opts.text !== undefined) {
		if (typeof opts.text === 'string') el.textContent = opts.text
		else {
			el.textContent = ''
			el.appendChild(opts.text)
		}
	}
	if (opts.title !== undefined) el.title = opts.title
	if (opts.type !== undefined) el.setAttribute('type', opts.type)
	if (opts.value !== undefined) (el as HTMLInputElement).value = opts.value
	if (opts.placeholder !== undefined)
		el.setAttribute('placeholder', opts.placeholder)
	if (opts.href !== undefined) el.setAttribute('href', opts.href)
	if (opts.attr) {
		for (const [k, v] of Object.entries(opts.attr)) {
			if (v === null || v === false) el.removeAttribute(k)
			else el.setAttribute(k, v === true ? '' : String(v))
		}
	}
}

let domHelpersInstalled = false

export function installObsidianDomHelpers(): void {
	if (domHelpersInstalled || typeof HTMLElement === 'undefined') return
	domHelpersInstalled = true
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>

	const createEl = function (
		this: HTMLElement,
		tag: string,
		o?: ObsidianElementOptions | string,
		cb?: (el: HTMLElement) => void,
	) {
		const el = (this.ownerDocument ?? document).createElement(tag)
		applyElementOptions(el, o)
		const target = (typeof o === 'object' && o?.parent) || this
		if (typeof o === 'object' && o?.prepend && target.firstChild) {
			target.insertBefore(el, target.firstChild)
		} else {
			target.appendChild(el)
		}
		cb?.(el)
		return el
	}
	proto.createEl = createEl
	proto.createDiv = function (
		this: HTMLElement,
		o?: ObsidianElementOptions | string,
		cb?: (el: HTMLDivElement) => void,
	) {
		return createEl.call(
			this,
			'div',
			o,
			cb as ((el: HTMLElement) => void) | undefined,
		)
	}
	proto.createSpan = function (
		this: HTMLElement,
		o?: ObsidianElementOptions | string,
		cb?: (el: HTMLSpanElement) => void,
	) {
		return createEl.call(
			this,
			'span',
			o,
			cb as ((el: HTMLElement) => void) | undefined,
		)
	}
	proto.empty = function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild)
	}
	proto.addClass = function (this: HTMLElement, ...classes: string[]) {
		const tokens = splitClasses(classes)
		if (tokens.length) this.classList.add(...tokens)
	}
	proto.removeClass = function (this: HTMLElement, ...classes: string[]) {
		const tokens = splitClasses(classes)
		if (tokens.length) this.classList.remove(...tokens)
	}
	proto.toggleClass = function (
		this: HTMLElement,
		classes: string | string[],
		value: boolean,
	) {
		for (const token of splitClasses(classes))
			this.classList.toggle(token, value)
	}
	proto.hasClass = function (this: HTMLElement, cls: string) {
		return this.classList.contains(cls)
	}
	proto.setText = function (this: HTMLElement, val: string | DocumentFragment) {
		if (typeof val === 'string') this.textContent = val
		else {
			this.textContent = ''
			this.appendChild(val)
		}
	}
	proto.appendText = function (this: HTMLElement, val: string) {
		this.appendChild((this.ownerDocument ?? document).createTextNode(val))
	}
	proto.setAttr = function (
		this: HTMLElement,
		qualifiedName: string,
		value: string | number | boolean | null,
	) {
		if (value === null || value === false) this.removeAttribute(qualifiedName)
		else this.setAttribute(qualifiedName, value === true ? '' : String(value))
	}
	proto.setCssProps = function (
		this: HTMLElement,
		props: Record<string, string>,
	) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v)
	}
	proto.setCssStyles = function (
		this: HTMLElement,
		styles: Partial<CSSStyleDeclaration>,
	) {
		Object.assign(this.style, styles)
	}
	proto.hide = function (this: HTMLElement) {
		this.style.display = 'none'
	}
	proto.show = function (this: HTMLElement) {
		if (this.style.display === 'none') this.style.display = ''
	}
	proto.toggle = function (this: HTMLElement, show: boolean) {
		if (show) (this as unknown as { show: () => void }).show()
		else (this as unknown as { hide: () => void }).hide()
	}
	proto.find = function (this: HTMLElement, selector: string) {
		return this.querySelector(selector)
	}
	proto.findAll = function (this: HTMLElement, selector: string) {
		return Array.from(this.querySelectorAll(selector))
	}
}

installObsidianDomHelpers()

function makeContainerEl(tag = 'div'): HTMLElement {
	installObsidianDomHelpers()
	if (typeof document !== 'undefined') return document.createElement(tag)
	const stub: Record<string, unknown> = {
		tagName: tag.toUpperCase(),
		children: [],
		style: {},
		textContent: '',
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		empty() {},
		addClass() {},
		removeClass() {},
		toggleClass() {},
		hasClass: () => false,
		setText() {},
		setAttr() {},
		setCssProps() {},
		setCssStyles() {},
		hide() {},
		show() {},
		toggle() {},
		createEl: () => makeContainerEl(),
		createDiv: () => makeContainerEl(),
		createSpan: () => makeContainerEl('span'),
		querySelector: () => null,
		querySelectorAll: () => [],
		appendChild: (child: unknown) => child,
		remove() {},
	}
	return stub as unknown as HTMLElement
}

export class Events {
	private listeners = new Map<string, Set<(...args: any[]) => any>>()
	on(name: string, callback: (...args: any[]) => any, ctx?: any) {
		const fn = ctx ? callback.bind(ctx) : callback
		const set = this.listeners.get(name) ?? new Set()
		set.add(fn)
		this.listeners.set(name, set)
		return { name, fn }
	}
	off(name: string, callback: (...args: any[]) => any) {
		this.listeners.get(name)?.delete(callback)
	}
	offref(ref: { name: string; fn: (...args: any[]) => any }) {
		this.listeners.get(ref.name)?.delete(ref.fn)
	}
	trigger(name: string, ...data: any[]) {
		for (const fn of [...(this.listeners.get(name) ?? [])]) fn(...data)
	}
}

export class Component {
	loaded = false
	loadCount = 0
	unloadCount = 0
	children: Component[] = []
	private cleanups: Array<() => unknown> = []

	load() {
		if (this.loaded) return
		this.loaded = true
		this.loadCount += 1
		this.onload()
		for (const child of this.children) child.load()
	}
	onload() {}
	unload() {
		if (!this.loaded) return
		this.loaded = false
		this.unloadCount += 1
		for (const child of [...this.children]) child.unload()
		this.children.length = 0
		for (const cb of this.cleanups.splice(0).reverse()) cb()
		this.onunload()
	}
	onunload() {}
	addChild<T extends Component>(component: T): T {
		if (!this.children.includes(component)) this.children.push(component)
		component.load()
		return component
	}
	removeChild<T extends Component>(component: T): T {
		const idx = this.children.indexOf(component)
		if (idx !== -1) this.children.splice(idx, 1)
		component.unload()
		return component
	}
	register(cb: () => unknown) {
		this.cleanups.push(cb)
	}
	registerEvent(eventRef: { name: string; fn: (...args: any[]) => any }) {
		void eventRef
	}
	registerDomEvent(
		el: EventTarget,
		type: string,
		callback: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	) {
		el.addEventListener(type, callback, options)
		this.register(() => el.removeEventListener(type, callback, options))
	}
	registerInterval(id: number): number {
		this.register(() => clearInterval(id))
		return id
	}
}

export abstract class TAbstractFile implements ObsidianTAbstractFile {
	vault: any
	path: string
	name: string
	parent: TFolder | null
	constructor(path = '', parent: TFolder | null = null, vault: any = null) {
		this.path = path
		this.name = path === '/' ? '' : (path.split('/').pop() ?? '')
		this.parent = parent
		this.vault = vault
	}
}

export class TFile extends TAbstractFile implements ObsidianTFile {
	stat: { ctime: number; mtime: number; size: number }
	basename: string
	extension: string
	constructor(
		path = '',
		stat = { ctime: 0, mtime: 0, size: 0 },
		parent: TFolder | null = null,
		vault: any = null,
	) {
		super(path, parent, vault)
		this.stat = stat
		const dot = this.name.lastIndexOf('.')
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name
		this.extension = dot > 0 ? this.name.slice(dot + 1) : ''
	}
}

export class TFolder extends TAbstractFile implements ObsidianTFolder {
	children: TAbstractFile[] = []
	isRoot(): boolean {
		return this.path === '/' || this.path === ''
	}
}

export class Vault extends Events {}
export class FileManager {}

export class WorkspaceLeaf {
	view: any = null
	constructor(public app: any = {}) {}
	detach() {}
	updateHeader() {
		if (this.view?.titleEl && typeof this.view.getDisplayText === 'function') {
			this.view.titleEl.textContent = this.view.getDisplayText()
		}
	}
}

export class ItemView extends Component {
	app: any
	leaf: WorkspaceLeaf
	containerEl: HTMLElement
	contentEl: HTMLElement
	titleEl: HTMLElement
	private headerEl: HTMLElement
	icon = 'document'
	navigation = true
	constructor(leaf: WorkspaceLeaf) {
		super()
		this.leaf = leaf
		this.app = leaf?.app ?? {}
		if (!this.app.workspace) {
			this.app.workspace = Object.assign(new Events(), {
				getActiveViewOfType: () => null,
				getLeavesOfType: () => [],
				getActiveFile: () => null,
			})
		}
		if (!this.app.vault) this.app.vault = new Vault()
		this.containerEl = makeContainerEl('div')
		if (typeof document !== 'undefined') {
			this.headerEl = this.containerEl.createDiv({ cls: 'view-header' })
			this.titleEl = this.headerEl.createDiv({ cls: 'view-header-title' })
			this.contentEl = this.containerEl.createDiv({ cls: 'view-content' })
		} else {
			this.headerEl = makeContainerEl('div')
			this.titleEl = makeContainerEl('div')
			this.contentEl = makeContainerEl('div')
		}
	}
	addAction(
		icon: string,
		title: string,
		callback: (evt: MouseEvent) => any,
	): HTMLElement {
		const el =
			typeof document !== 'undefined'
				? this.headerEl.createEl('a', {
						cls: 'clickable-icon view-action',
						attr: { 'aria-label': title },
					})
				: makeContainerEl('a')
		setIcon(el, icon)
		if (typeof document !== 'undefined') {
			el.addEventListener('click', callback)
		}
		return el
	}
	getViewType() {
		return ''
	}
	getDisplayText() {
		return ''
	}
	getIcon() {
		return this.icon
	}
	getState(): Record<string, unknown> {
		return {}
	}
	async setState(_state: unknown, _result?: unknown) {}
	async onOpen() {}
	async onClose() {}
	onResize() {}
}

export class MarkdownView extends ItemView {
	file: TFile | null = null
}

export class Notice {
	noticeEl: HTMLElement
	constructor(message: string | DocumentFragment, timeout?: number) {
		this.noticeEl = makeContainerEl('div')
		if (typeof document !== 'undefined' && typeof message === 'string') {
			this.noticeEl.textContent = message
		}
		const entry = { message, timeout }
		obsidianRuntime.notices.push(entry)
		obsidianRuntime.onNotice?.(entry)
	}
	setMessage(message: string | DocumentFragment) {
		if (typeof document !== 'undefined' && typeof message === 'string') {
			this.noticeEl.textContent = message
		}
		return this
	}
	hide() {}
}

export class Modal {
	app: any
	containerEl: HTMLElement
	modalEl: HTMLElement
	titleEl: HTMLElement
	contentEl: HTMLElement
	shouldRestoreSelection = false
	constructor(app: any = {}) {
		this.app = app
		this.containerEl = makeContainerEl('div')
		if (typeof document !== 'undefined') {
			this.containerEl.className = 'modal-container'
			this.modalEl = this.containerEl.createDiv({ cls: 'modal' })
			this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' })
			this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' })
		} else {
			this.modalEl = makeContainerEl('div')
			this.titleEl = makeContainerEl('div')
			this.contentEl = makeContainerEl('div')
		}
	}
	open() {
		if (typeof document !== 'undefined' && !this.containerEl.isConnected) {
			document.body.appendChild(this.containerEl)
		}
		this.onOpen()
	}
	close() {
		this.onClose()
		if (typeof document !== 'undefined') this.containerEl.remove()
	}
	onOpen() {}
	onClose() {}
	setTitle(title: string) {
		if (typeof document !== 'undefined') this.titleEl.textContent = title
		return this
	}
	setContent(content: string | DocumentFragment) {
		if (typeof document !== 'undefined') {
			this.contentEl.empty()
			if (typeof content === 'string') this.contentEl.textContent = content
			else this.contentEl.appendChild(content)
		}
		return this
	}
}

export class FuzzySuggestModal<T> extends Modal {
	getItems(): T[] {
		return []
	}
	getItemText(_item: T) {
		return ''
	}
	onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent) {}
}

export class AbstractInputSuggest<T> {
	constructor(
		public app: any,
		public inputEl: HTMLInputElement,
	) {}
	getSuggestions(_query: string): T[] {
		return []
	}
	renderSuggestion(_value: T, _el: HTMLElement) {}
	selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent) {}
	close() {}
}

export class Plugin extends Component {
	constructor(
		public app: any = {},
		public manifest: any = {},
	) {
		super()
	}
	addRibbonIcon(
		icon: string,
		title: string,
		callback: (evt: MouseEvent) => any,
	) {
		const el = makeContainerEl('div')
		if (typeof document !== 'undefined') {
			el.className = 'side-dock-ribbon-action'
			el.setAttribute('aria-label', title)
			setIcon(el, icon)
			el.addEventListener('click', callback)
		}
		return el
	}
	addStatusBarItem() {
		return makeContainerEl('div')
	}
	addCommand(command: any) {
		return command
	}
	addSettingTab(_tab: any) {}
	registerView(_type: string, _creator: any) {}
	async loadData(): Promise<any> {
		return null
	}
	async saveData(_data: any) {}
}

export class PluginSettingTab {
	containerEl: HTMLElement
	constructor(
		public app: any,
		public plugin: any,
	) {
		this.containerEl = makeContainerEl('div')
	}
	display() {}
	hide() {}
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement
	constructor(containerEl: HTMLElement) {
		this.buttonEl =
			typeof document !== 'undefined'
				? containerEl.createEl('button', { attr: { type: 'button' } })
				: (makeContainerEl('button') as unknown as HTMLButtonElement)
	}
	setButtonText(name: string) {
		this.buttonEl.textContent = name
		return this
	}
	setIcon(icon: string) {
		setIcon(this.buttonEl, icon)
		return this
	}
	setTooltip(tooltip: string) {
		this.buttonEl.setAttribute('aria-label', tooltip)
		return this
	}
	setClass(cls: string) {
		this.buttonEl.classList.add(...splitClasses(cls))
		return this
	}
	setCta() {
		return this.setClass('mod-cta')
	}
	setWarning() {
		return this.setClass('mod-warning')
	}
	setDisabled(disabled: boolean) {
		this.buttonEl.disabled = disabled
		return this
	}
	onClick(cb: (evt: MouseEvent) => any) {
		this.buttonEl.addEventListener('click', cb)
		return this
	}
	then(cb: (component: this) => any) {
		cb(this)
		return this
	}
}

export class TextComponent {
	inputEl: HTMLInputElement
	constructor(containerEl: HTMLElement) {
		this.inputEl =
			typeof document !== 'undefined'
				? containerEl.createEl('input', { type: 'text' })
				: (makeContainerEl('input') as unknown as HTMLInputElement)
	}
	getValue() {
		return this.inputEl.value ?? ''
	}
	setValue(value: string) {
		this.inputEl.value = value
		return this
	}
	setPlaceholder(placeholder: string) {
		this.inputEl.placeholder = placeholder
		return this
	}
	setDisabled(disabled: boolean) {
		this.inputEl.disabled = disabled
		return this
	}
	onChange(cb: (value: string) => any) {
		this.inputEl.addEventListener('input', () => cb(this.inputEl.value))
		return this
	}
	then(cb: (component: this) => any) {
		cb(this)
		return this
	}
}

export class SearchComponent extends TextComponent {}

export class DropdownComponent {
	selectEl: HTMLSelectElement
	constructor(containerEl: HTMLElement) {
		this.selectEl =
			typeof document !== 'undefined'
				? containerEl.createEl('select')
				: (makeContainerEl('select') as unknown as HTMLSelectElement)
	}
	addOption(value: string, display: string) {
		if (typeof document !== 'undefined') {
			const opt = document.createElement('option')
			opt.value = value
			opt.textContent = display
			this.selectEl.appendChild(opt)
		}
		return this
	}
	addOptions(options: Record<string, string>) {
		for (const [v, d] of Object.entries(options)) this.addOption(v, d)
		return this
	}
	getValue() {
		return this.selectEl.value ?? ''
	}
	setValue(value: string) {
		this.selectEl.value = value
		return this
	}
	setDisabled(disabled: boolean) {
		this.selectEl.disabled = disabled
		return this
	}
	onChange(cb: (value: string) => any) {
		this.selectEl.addEventListener('change', () => cb(this.selectEl.value))
		return this
	}
	then(cb: (component: this) => any) {
		cb(this)
		return this
	}
}

export class Setting {
	settingEl: HTMLElement
	infoEl: HTMLElement
	nameEl: HTMLElement
	descEl: HTMLElement
	controlEl: HTMLElement
	constructor(containerEl: HTMLElement) {
		if (typeof document !== 'undefined') {
			this.settingEl = containerEl.createDiv({ cls: 'setting-item' })
			this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' })
			this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' })
			this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' })
			this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' })
		} else {
			this.settingEl = makeContainerEl('div')
			this.infoEl = makeContainerEl('div')
			this.nameEl = makeContainerEl('div')
			this.descEl = makeContainerEl('div')
			this.controlEl = makeContainerEl('div')
		}
	}
	setName(name: string | DocumentFragment) {
		this.nameEl.setText(name)
		return this
	}
	setDesc(desc: string | DocumentFragment) {
		this.descEl.setText(desc)
		return this
	}
	setClass(cls: string) {
		this.settingEl.addClass(...splitClasses(cls))
		return this
	}
	setHeading() {
		this.settingEl.addClass('setting-item-heading')
		return this
	}
	setDisabled(disabled: boolean) {
		this.settingEl.toggleClass('is-disabled', disabled)
		return this
	}
	addButton(cb: (component: ButtonComponent) => any) {
		cb(new ButtonComponent(this.controlEl))
		return this
	}
	addText(cb: (component: TextComponent) => any) {
		cb(new TextComponent(this.controlEl))
		return this
	}
	addDropdown(cb: (component: DropdownComponent) => any) {
		cb(new DropdownComponent(this.controlEl))
		return this
	}
	addToggle(cb: (component: any) => any) {
		const el =
			typeof document !== 'undefined'
				? this.controlEl.createEl('input', { type: 'checkbox' })
				: (makeContainerEl('input') as unknown as HTMLInputElement)
		const toggle = {
			getValue: () => Boolean(el.checked),
			setValue: (v: boolean) => {
				el.checked = v
				return toggle
			},
			setDisabled: (d: boolean) => {
				el.disabled = d
				return toggle
			},
			onChange: (fn: (v: boolean) => any) => {
				el.addEventListener('change', () => fn(el.checked))
				return toggle
			},
		}
		cb(toggle)
		return this
	}
	then(cb: (setting: this) => any) {
		cb(this)
		return this
	}
	clear() {
		this.controlEl.empty()
		return this
	}
}

export class Menu {
	items: Array<{
		title?: string
		icon?: string
		onClick?: (evt: MouseEvent | KeyboardEvent) => any
	}> = []
	addItem(cb: (item: any) => any) {
		const record: (typeof this.items)[number] = {}
		const item = {
			setTitle: (t: string) => ((record.title = t), item),
			setIcon: (i: string | null) => ((record.icon = i ?? undefined), item),
			setChecked: () => item,
			setDisabled: () => item,
			setWarning: () => item,
			onClick: (fn: (evt: MouseEvent | KeyboardEvent) => any) => (
				(record.onClick = fn),
				item
			),
		}
		cb(item)
		this.items.push(record)
		return this
	}
	addSeparator() {
		return this
	}
	showAtMouseEvent(_evt: MouseEvent) {
		return this
	}
	showAtPosition(_pos: { x: number; y: number }) {
		return this
	}
	hide() {
		return this
	}
}

export const MarkdownRenderer = {
	async render(
		app: any,
		markdown: string,
		el: HTMLElement,
		sourcePath: string,
		component: Component,
	) {
		if (obsidianRuntime.markdownRenderHandler) {
			await obsidianRuntime.markdownRenderHandler(
				app,
				markdown,
				el,
				sourcePath,
				component,
			)
			return
		}
		if (typeof document !== 'undefined') el.textContent = markdown
	},
}

export function setIcon(parent: HTMLElement, iconId: string): void {
	obsidianRuntime.appliedIcons.push({ el: parent, iconId })
	if (obsidianRuntime.onSetIcon) {
		obsidianRuntime.onSetIcon(parent, iconId)
		return
	}
	if (typeof document !== 'undefined') {
		parent.setAttribute('data-icon', iconId)
		parent.textContent = obsidianRuntime.icons.get(iconId) ?? ''
	}
}

export function addIcon(iconId: string, svgContent: string): void {
	obsidianRuntime.icons.set(iconId, svgContent)
	obsidianRuntime.onAddIcon?.(iconId, svgContent)
}

export function removeIcon(iconId: string): void {
	obsidianRuntime.icons.delete(iconId)
	obsidianRuntime.removedIcons.push(iconId)
	obsidianRuntime.onRemoveIcon?.(iconId)
}

export function getIcon(iconId: string): SVGSVGElement | null {
	if (!obsidianRuntime.icons.has(iconId) || typeof document === 'undefined') {
		return null
	}
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	svg.setAttribute('data-icon', iconId)
	return svg
}

export async function requestUrl(
	request: RequestUrlParam | string,
): Promise<RequestUrlResponse> {
	if (obsidianRuntime.requestUrlHandler) {
		return await obsidianRuntime.requestUrlHandler(request)
	}
	const url = typeof request === 'string' ? request : request.url
	throw new Error(
		`Unhandled obsidian.requestUrl("${url}") in test runtime. Configure obsidianRuntime.requestUrlHandler.`,
	)
}

export function requireApiVersion(_version: string): boolean {
	return true
}

export function debounce<T extends (...args: any[]) => any>(
	cb: T,
	timeout = 0,
) {
	let timer: ReturnType<typeof setTimeout> | null = null
	let lastArgs: Parameters<T> | null = null
	const wrapped = ((...args: Parameters<T>) => {
		lastArgs = args
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = null
			if (lastArgs) cb(...lastArgs)
		}, timeout)
		return wrapped
	}) as T & { cancel: () => unknown; run: () => unknown }
	wrapped.cancel = () => {
		if (timer) clearTimeout(timer)
		timer = null
		return wrapped
	}
	wrapped.run = () => {
		if (timer) clearTimeout(timer)
		timer = null
		if (lastArgs) cb(...lastArgs)
		return wrapped
	}
	return wrapped
}

export function moment(input?: number | string | Date) {
	const date = input === undefined ? new Date() : new Date(input)
	const pad = (v: number) => String(v).padStart(2, '0')
	return {
		valueOf: () => date.getTime(),
		toDate: () => date,
		toISOString: () => date.toISOString(),
		format(pattern = 'YYYY-MM-DD HH:mm:ss') {
			return pattern
				.replace(/YYYY/g, String(date.getFullYear()))
				.replace(/MM/g, pad(date.getMonth() + 1))
				.replace(/DD/g, pad(date.getDate()))
				.replace(/HH/g, pad(date.getHours()))
				.replace(/mm/g, pad(date.getMinutes()))
				.replace(/ss/g, pad(date.getSeconds()))
		},
	}
}

function parseYamlScalar(raw: string): unknown {
	const t = raw.trim()
	if (t === '' || t === 'null' || t === '~') return null
	if (t === 'true') return true
	if (t === 'false') return false
	if (t.startsWith('"') && t.endsWith('"')) {
		try {
			return JSON.parse(t)
		} catch {
			return t.slice(1, -1)
		}
	}
	if (t.startsWith("'") && t.endsWith("'"))
		return t.slice(1, -1).replace(/''/g, "'")
	return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t
}

export function parseYaml(yaml: string): any {
	const result: Record<string, unknown> = {}
	const lines = yaml.replace(/\r\n/g, '\n').split('\n')
	let listKey: string | null = null
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]
		if (!line.trim() || line.trim().startsWith('#')) continue
		const item = /^\s+-\s+(.*)$/.exec(line)
		if (item && listKey && Array.isArray(result[listKey])) {
			;(result[listKey] as unknown[]).push(parseYamlScalar(item[1]))
			continue
		}
		listKey = null
		const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
		if (!kv) continue
		const [, key, rest] = kv
		const trimmed = rest.trim()
		if (
			trimmed === '' &&
			i + 1 < lines.length &&
			/^\s+-\s+/.test(lines[i + 1])
		) {
			result[key] = []
			listKey = key
			continue
		}
		result[key] = parseYamlScalar(trimmed)
	}
	return result
}
