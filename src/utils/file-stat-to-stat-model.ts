import { FileStat } from 'webdav'
import { StatModel } from '~/model/stat.model'

export function fileStatToStatModel(from: FileStat): StatModel {
	return {
		path: from.filename,
		basename: from.basename,
		isDir: from.type === 'directory',
		isDeleted: false,
		mtime: new Date(from.lastmod).valueOf(),
	}
}
