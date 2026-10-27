import { zipSync } from 'fflate/browser'
import { Bash, InMemoryFs } from 'just-bash/browser'
import { describe, expect, it } from 'vitest'
import { archiveCommands } from './zip'

const content = 'English text 与中文内容 🌱\nSecond neutral line 第二行\n'

function createBash(files: Record<string, string | Uint8Array>) {
	return new Bash({
		cwd: '/workspace',
		fs: new InMemoryFs(files),
		customCommands: archiveCommands,
	})
}

describe('zip and unzip commands', () => {
	it('creates, lists, and extracts a recursive archive', async () => {
		const bash = createBash({
			'/workspace/docs/guide.txt': content,
			'/workspace/docs/ignore.tmp': 'temporary 临时内容\n',
			'/workspace/empty/.keep': '',
		})

		const archived = await bash.exec('zip -rq package docs empty -x "*.tmp"')
		const listed = await bash.exec('unzip -l package')
		const extracted = await bash.exec('unzip -o package -d restored')

		expect(archived).toMatchObject({ stderr: '', exitCode: 0 })
		expect(listed.stdout).toContain('docs/guide.txt')
		expect(listed.stdout).toContain('empty/.keep')
		expect(listed.stdout).not.toContain('docs/ignore.tmp')
		expect(extracted).toMatchObject({ stderr: '', exitCode: 0 })
		expect(await bash.fs.readFile('/workspace/restored/docs/guide.txt')).toBe(
			content,
		)
	})

	it('archives paths whose timestamp predates the ZIP date range', async () => {
		const bash = createBash({
			'/workspace/project/notes.txt': 'neutral 中性内容\n',
		})
		const epoch = new Date(0)
		await bash.fs.utimes('/workspace/project', epoch, epoch)

		const result = await bash.exec('zip -r project.zip project')

		expect(result).toMatchObject({ stderr: '', exitCode: 0 })
		expect(await bash.fs.exists('/workspace/project.zip')).toBe(true)
	})

	it('streams a zip archive and its member through pipelines', async () => {
		const bash = createBash({})

		const result = await bash.exec(
			"printf 'English 与中文内容 🌱\\n' | zip - - | unzip -p -",
		)

		expect(result).toMatchObject({ stderr: '', exitCode: 0 })
		expect(result.stdout).toBe('English 与中文内容 🌱\n')
	})

	it('requires an explicit overwrite policy for existing files', async () => {
		const bash = createBash({
			'/workspace/source.txt': content,
			'/workspace/output/source.txt': 'existing 既有内容\n',
		})
		await bash.exec('zip archive source.txt')

		const needsPolicy = await bash.exec('unzip archive -d output')
		const skipped = await bash.exec('unzip -n archive -d output')

		expect(needsPolicy).toMatchObject({ exitCode: 1 })
		expect(needsPolicy.stderr).toContain('Use -o to overwrite or -n to skip')
		expect(skipped).toMatchObject({ stderr: '', exitCode: 0 })
		expect(await bash.fs.readFile('/workspace/output/source.txt')).toBe(
			'existing 既有内容\n',
		)

		const overwritten = await bash.exec('unzip -o archive -d output')

		expect(overwritten).toMatchObject({ stderr: '', exitCode: 0 })
		expect(await bash.fs.readFile('/workspace/output/source.txt')).toBe(content)
	})

	it('rejects archive entries that escape the extraction directory', async () => {
		const bash = createBash({
			'/workspace/unsafe.zip': zipSync({
				'../outside.txt': new TextEncoder().encode('neutral 中性内容\n'),
			}),
		})

		const result = await bash.exec('unzip -o unsafe.zip -d extracted')

		expect(result).toMatchObject({ exitCode: 1 })
		expect(result.stderr).toContain('unsafe archive entry')
		expect(await bash.fs.exists('/workspace/outside.txt')).toBe(false)
	})
})
