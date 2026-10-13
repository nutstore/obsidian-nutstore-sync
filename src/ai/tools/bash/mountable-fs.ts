import { MountableFs as BashMountableFs } from 'just-bash/browser'

/** Directory types follow the same mount routing and virtual parents as ordinary reads. */
export class MountableFs extends BashMountableFs {
	async readdirWithFileTypes(path: string) {
		const names = await this.readdir(path)
		return Promise.all(
			names.map(async (name) => {
				const stat = await this.lstat(this.resolvePath(path, name))
				return {
					name,
					isFile: stat.isFile,
					isDirectory: stat.isDirectory,
					isSymbolicLink: stat.isSymbolicLink,
				}
			}),
		)
	}
}
