import { describe, expect, it } from 'vitest'
import GlobMatch, { needIncludeFromGlobRules } from './glob-match'

const options = { caseSensitive: false }

const makeRules = (patterns: string[]) =>
	patterns.map((pattern) => new GlobMatch(pattern, options))


describe('needIncludeFromGlobRules', () => {
	it('默认情况：无规则时应包含所有文件', () => {
		expect(needIncludeFromGlobRules('some/file.txt', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('some/../file.txt', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('./some/file.txt', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('some//file.txt', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('/some/file.txt', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('some/folder/..', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('some/folder/../', [], [])).toBe(true)
		expect(needIncludeFromGlobRules('some/././file.txt', [], [])).toBe(true)
	})

	it('包含规则：匹配包含规则的文件应被包含', () => {
		const inclusion = makeRules(['*.txt'])
		const exclusion: GlobMatch[] = []

		expect(needIncludeFromGlobRules('document.txt', inclusion, exclusion)).toBe(
			true,
		)
	})

	it('排除规则：匹配排除规则的文件应被排除', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = makeRules(['*.log'])

		expect(needIncludeFromGlobRules('debug.log', inclusion, exclusion)).toBe(
			false,
		)
	})

	it('优先级：包含规则优先于排除规则', () => {
		const inclusion = makeRules(['important.log'])
		const exclusion = makeRules(['*.log'])

		expect(
			needIncludeFromGlobRules('important.log', inclusion, exclusion),
		).toBe(true)
	})

	describe('标准通配符', () => {
		it('* 匹配零个或多个字符，但不跨目录', () => {
			const exclusion = makeRules(['*.txt'])

			expect(needIncludeFromGlobRules('readme.txt', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('readme.txt/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('notes/readme.txt', [], exclusion)).toBe(
				false,
			)
			expect(
				needIncludeFromGlobRules('notes/archive/readme.txt', [], exclusion),
			).toBe(false)
			expect(needIncludeFromGlobRules('notes/readme.txt.bak', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('readme.md', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('readme', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('dir.with.dot/readme.txt', [], exclusion)).toBe(
				false,
			)
		})

		it('? 匹配任意单个字符', () => {
			const exclusion = makeRules(['debug?.log'])

			expect(needIncludeFromGlobRules('debug1.log', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('debugA.log', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('debug12.log', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('debug.log', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('debug/.log', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('debugä.log', [], exclusion)).toBe(false)
		})

		it('[] 匹配指定字符或范围', () => {
			const exclusion = makeRules(['backup[0-9].sql'])

			expect(needIncludeFromGlobRules('backup0.sql', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('backup9.sql', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('backupA.sql', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('backup10.sql', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('backup-.sql', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('backup5.SQL', [], exclusion)).toBe(false)
		})
	})

	describe('路径分隔符规则', () => {
		it('模式中不包含 /：递归匹配所有目录', () => {
		const exclusion = makeRules(['*.log', 'temp'])

			expect(needIncludeFromGlobRules('app.log', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('logs/app.log', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('logs/app.log/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('temp', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/temp', [], exclusion)).toBe(false)
			expect(
				needIncludeFromGlobRules('src/temp/file.txt', [], exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('src/temp/../temp/file.txt', [], exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('src/./temp/file.txt', [], exclusion),
			).toBe(false)
			expect(needIncludeFromGlobRules('TEMP', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('temporary/file.txt', [], exclusion)).toBe(
				true,
			)
		})

		it('模式以 / 开头：仅匹配根目录', () => {
		const exclusion = makeRules(['/TODO'])

			expect(needIncludeFromGlobRules('TODO', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/TODO', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('TODO/readme.md', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('todo', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/../TODO', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('/TODO', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('nested/TODO', [], exclusion)).toBe(true)
		})

		it('模式以 / 结尾：仅匹配目录及其内容', () => {
		const exclusion = makeRules(['build/'])

			expect(needIncludeFromGlobRules('build/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('build/app.js', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('src/build/', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('src/build/app.js', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('build', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('buildfile/', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('build/../build/app.js', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('./build/app.js', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('build/.hidden', [], exclusion)).toBe(false)
		})

		it('父目录被忽略时子文件应直接被忽略', () => {
		const exclusion = makeRules(['build/'])

			expect(needIncludeFromGlobRules('build/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('build/app.js', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('build/sub/app.js', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('build/sub/', [], exclusion)).toBe(false)
		})

		it('父目录忽略可以被子文件白名单覆盖', () => {
			const inclusion = makeRules(['build/keep.txt'])
		const exclusion = makeRules(['build/'])

			expect(
				needIncludeFromGlobRules('build/keep.txt', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('build/keep/more.txt', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('build/keep.txt/extra', inclusion, exclusion),
			).toBe(false)
		})

		it('模式中间包含 /：相对路径匹配', () => {
			const exclusion = makeRules(['doc/*.txt'])

			expect(needIncludeFromGlobRules('doc/a.txt', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('doc/server/arch.txt', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('docs/a.txt', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('doc/a.txt/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('doc/a.tx', [], exclusion)).toBe(true)
		})
	})

	describe('双星号 ** 深度匹配', () => {
		it('**/pattern：任意深度匹配文件名', () => {
			const exclusion = makeRules(['**/__pycache__'])

			expect(needIncludeFromGlobRules('__pycache__', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('src/__pycache__', [], exclusion)).toBe(
				false,
			)
			expect(
				needIncludeFromGlobRules('src/utils/__pycache__', [], exclusion),
			).toBe(false)
			expect(needIncludeFromGlobRules('src/utils/__pycache__/', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('src/utils/__pycache__x', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('src/__pycache__/file.py', [], exclusion)).toBe(
				false,
			)
		})

		it('pattern/**：匹配该目录下所有内容', () => {
			const exclusion = makeRules(['assets/**'])

			expect(needIncludeFromGlobRules('assets/logo.png', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('assets/icons/icon.svg', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('assets', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('src/assets/logo.png', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('assets/.keep', [], exclusion)).toBe(false)
		})

		it('pattern/**/pattern：跨层级匹配', () => {
			const exclusion = makeRules(['foo/**/bar'])

			expect(needIncludeFromGlobRules('foo/bar', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('foo/x/bar', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('foo/x/y/bar', [], exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('x/foo/bar', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('foo/bar/baz', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('foo/.hidden/bar', [], exclusion)).toBe(false)
		})
	})

	describe('综合示例规则', () => {
		const exclusion = makeRules([
			'*.a',
			'bin/',
			'/vendor/',
			'logs/*.txt',
			'core/**/*.out',
			'test[0-9].js',
		])

		it('*.a：匹配所有目录下的 .a 文件', () => {
			expect(needIncludeFromGlobRules('lib.a', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/lib.a', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/lib.so', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('src/lib.a/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/lib.a.bak', [], exclusion)).toBe(true)
		})

		it('bin/：忽略任意位置的 bin 目录', () => {
			expect(needIncludeFromGlobRules('bin/tool', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/bin/tool', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('binfile', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('src/binfile/tool', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('bin/../bin/tool', [], exclusion)).toBe(false)
		})

		it('/vendor/：仅忽略根目录的 vendor', () => {
			expect(needIncludeFromGlobRules('vendor/lib.js', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/vendor/lib.js', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('vendor', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('vendor/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('src/../vendor/lib.js', [], exclusion)).toBe(
				false,
			)
		})

		it('logs/*.txt：仅匹配 logs 下一级 .txt', () => {
			expect(needIncludeFromGlobRules('logs/app.txt', [], exclusion)).toBe(false)
			expect(
				needIncludeFromGlobRules('logs/history/2023.txt', [], exclusion),
			).toBe(true)
			expect(needIncludeFromGlobRules('logs/app.txt/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('logs/app.tx', [], exclusion)).toBe(true)
		})

		it('core/**/*.out：匹配 core 下任意深度 .out', () => {
			expect(needIncludeFromGlobRules('core/main.out', [], exclusion)).toBe(false)
			expect(
				needIncludeFromGlobRules('core/a/b/c/test.out', [], exclusion),
			).toBe(false)
			expect(needIncludeFromGlobRules('src/core/test.out', [], exclusion)).toBe(
				true,
			)
			expect(needIncludeFromGlobRules('core/test.out/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('core/test.output', [], exclusion)).toBe(true)
		})

		it('test[0-9].js：匹配 test0.js ~ test9.js', () => {
			expect(needIncludeFromGlobRules('test0.js', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('test9.js', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('test10.js', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('testA.js', [], exclusion)).toBe(true)
			expect(needIncludeFromGlobRules('test0.js/', [], exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('test5.js.map', [], exclusion)).toBe(true)
		})
	})
})
