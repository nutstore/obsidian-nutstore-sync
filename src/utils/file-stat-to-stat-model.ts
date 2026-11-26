import { FileStat } from 'webdav'
import { StatModel } from '~/model/stat.model'

function parseLastModified(lastmod: string | null | undefined): number {
	if (!lastmod) return 0
	const parsed = new Date(lastmod).valueOf()
	return Number.isFinite(parsed) ? parsed : 0
}

export function fileStatToStatModel(from: FileStat): StatModel {
	if (from.type === 'directory') {
		return {
			path: from.filename,
			basename: from.basename,
			isDir: true,
			isDeleted: false,
			mtime: parseLastModified(from.lastmod),
		}
	}
	return {
		path: from.filename,
		basename: from.basename,
		isDir: false,
		isDeleted: false,
		mtime: parseLastModified(from.lastmod),
		size: Number.isFinite(from.size) ? from.size : 0,
		etag:
			typeof from.etag === 'string' && from.etag.length > 0 ? from.etag : null,
	}
}
