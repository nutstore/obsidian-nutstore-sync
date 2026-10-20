/** Icons enter Obsidian's trusted DOM, so accept only inert monochrome SVG geometry. */
export function validateAppIcon(svg: string, doc: Document): string {
	if (svg.length > 20_000 || /<!|<\?/.test(svg))
		throw new Error('Invalid App SVG icon')
	const parsed = new doc.defaultView!.DOMParser().parseFromString(
		svg,
		'image/svg+xml',
	)
	const root = parsed.documentElement
	if (
		root.localName !== 'svg' ||
		root.getAttribute('viewBox') !== '0 0 100 100' ||
		parsed.querySelector('parsererror')
	)
		throw new Error('App icon must use an SVG viewBox of 0 0 100 100')
	const tags = new Set([
		'svg',
		'g',
		'path',
		'circle',
		'ellipse',
		'rect',
		'line',
		'polyline',
		'polygon',
	])
	const attrs = new Set([
		'viewBox',
		'xmlns',
		'd',
		'cx',
		'cy',
		'r',
		'rx',
		'ry',
		'x',
		'y',
		'x1',
		'x2',
		'y1',
		'y2',
		'width',
		'height',
		'points',
		'fill',
		'stroke',
		'stroke-width',
		'stroke-linecap',
		'stroke-linejoin',
		'fill-rule',
		'clip-rule',
		'opacity',
		'transform',
	])
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/2000/svg')
			throw new Error('Unsupported App icon namespace')
		if (!tags.has(el.localName) || (el !== root && el.localName === 'svg'))
			throw new Error('Unsupported App icon element')
		for (const attr of Array.from(el.attributes)) {
			if (!attrs.has(attr.name) || /url\s*\(|[<>]/i.test(attr.value))
				throw new Error('Unsupported App icon attribute')
			if (
				['fill', 'stroke'].includes(attr.name) &&
				!['none', 'currentColor'].includes(attr.value)
			)
				throw new Error('App icons use currentColor or none')
		}
		for (const child of Array.from(el.childNodes)) {
			if (
				child.nodeType !== 1 &&
				(child.nodeType !== 3 || child.textContent?.trim())
			)
				throw new Error('App icon contains unsupported content')
		}
	}
	return root.outerHTML
}
export function appIconId(id: string) {
	return `nutstore-app-${id}`
}
export function appIconContent(svg: string) {
	return svg.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '')
}
