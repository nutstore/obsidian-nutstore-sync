export function isTextMime(mime: string) {
	return mime.toLowerCase().startsWith('text/')
}
