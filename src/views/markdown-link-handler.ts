const PROVIDER_EDIT_PROTOCOL = 'obsidian://nutstore-sync/modal/provider-edit'

export type MarkdownLinkAction =
	| { type: 'none' }
	| { type: 'internal'; linktext: string }
	| { type: 'external'; href: string }
	| { type: 'protocol'; href: string; providerId?: string }

export interface MarkdownLinkDescriptor {
	href?: string | null
	datasetHref?: string | null
	classNames?: Iterable<string>
}

export function resolveMarkdownSourcePath(sourcePath?: string | null) {
	const trimmed = sourcePath?.trim() ?? ''
	return trimmed || ''
}

export function resolveMarkdownLinkAction(
	link: MarkdownLinkDescriptor,
): MarkdownLinkAction {
	const href = link.href?.trim() ?? ''
	const datasetHref = link.datasetHref?.trim() ?? ''
	const classNames = new Set(link.classNames ?? [])

	if (datasetHref || classNames.has('internal-link')) {
		const linktext = datasetHref || href
		return linktext ? { type: 'internal', linktext } : { type: 'none' }
	}

	if (!href || href === '#') {
		return { type: 'none' }
	}

	if (href.startsWith(PROVIDER_EDIT_PROTOCOL)) {
		try {
			const providerId = new URL(href).searchParams.get('providerId')?.trim()
			return { type: 'protocol', href, providerId: providerId || undefined }
		} catch {
			return { type: 'protocol', href }
		}
	}

	return { type: 'external', href }
}
