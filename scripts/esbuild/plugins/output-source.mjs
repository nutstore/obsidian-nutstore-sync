const INLINE_SOURCE_MAP_MARKER = '\n//# sourceMappingURL='

export function removeInlineSourceMap(source) {
	const markerIndex = source.lastIndexOf(INLINE_SOURCE_MAP_MARKER)
	return markerIndex === -1 ? source : source.slice(0, markerIndex)
}
