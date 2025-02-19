import { FileStat, WebDAVClient } from 'webdav'
import { StatModel } from '~/model/stat.model'
import { fileStatToStatModel } from './file-stat-to-stat-model'

export async function traverseWebDAV(
	client: WebDAVClient,
	from: string = '',
): Promise<StatModel[]> {
	const contents = (await client.getDirectoryContents(from, {
		details: false,
		deep: false,
	})) as FileStat[]
	return [
		contents.map(fileStatToStatModel),
		await Promise.all(
			contents
				.filter((item) => item.type === 'directory')
				.map((item) => traverseWebDAV(client, item.filename)),
		),
	].flat(2)
}
