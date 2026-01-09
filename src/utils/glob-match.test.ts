import { describe, expect, it } from 'vitest'
import GlobMatch, { needIncludeFromGlobRules, extendRules } from './glob-match'

describe('needIncludeFromGlobRules', () => {
	// --- 基础行为测试 ---
	it('默认情况：无规则时应包含所有文件', () => {
		const result = needIncludeFromGlobRules('some/file.txt', [], [])
		expect(result).toBe(true)
	})

	it('包含规则：匹配包含规则的文件应被包含', () => {
		const inclusion = [new GlobMatch('*.txt', { caseSensitive: false })]
		const exclusion: GlobMatch[] = []

		const result = needIncludeFromGlobRules(
			'document.txt',
			inclusion,
			exclusion,
		)
		expect(result).toBe(true)
	})

	it('排除规则：匹配排除规则的文件应被排除', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [new GlobMatch('*.log', { caseSensitive: false })]

		const result = needIncludeFromGlobRules('debug.log', inclusion, exclusion)
		expect(result).toBe(false)
	})

	it('优先级：包含规则优先于排除规则', () => {
		const inclusion = [new GlobMatch('important.log', { caseSensitive: false })]
		const exclusion = [new GlobMatch('*.log', { caseSensitive: false })]

		const result = needIncludeFromGlobRules(
			'important.log',
			inclusion,
			exclusion,
		)
		expect(result).toBe(true)
	})

	// --- 多规则测试 ---
	it('多个包含规则：任一匹配即包含', () => {
		const inclusion = [
			new GlobMatch('*.txt', { caseSensitive: false }),
			new GlobMatch('*.md', { caseSensitive: false }),
		]
		const exclusion: GlobMatch[] = []

		expect(needIncludeFromGlobRules('readme.md', inclusion, exclusion)).toBe(
			true,
		)
		expect(needIncludeFromGlobRules('notes.txt', inclusion, exclusion)).toBe(
			true,
		)
		expect(needIncludeFromGlobRules('script.js', inclusion, exclusion)).toBe(
			true,
		)
	})

	it('多个排除规则：任一匹配即排除', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [
			new GlobMatch('*.log', { caseSensitive: false }),
			new GlobMatch('*.tmp', { caseSensitive: false }),
		]

		expect(needIncludeFromGlobRules('debug.log', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('cache.tmp', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('data.json', inclusion, exclusion)).toBe(
			true,
		)
	})

	// --- 路径匹配测试 ---
	it('文件夹匹配：严格的路径匹配语义', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [
			new GlobMatch('node_modules', { caseSensitive: false }),
			new GlobMatch('**/node_modules/**', { caseSensitive: false }),
		]

		expect(needIncludeFromGlobRules('node_modules', inclusion, exclusion)).toBe(
			false,
		)
		expect(
			needIncludeFromGlobRules('src/node_modules', inclusion, exclusion),
		).toBe(true)
		expect(
			needIncludeFromGlobRules(
				'src/node_modules/express/index.js',
				inclusion,
				exclusion,
			),
		).toBe(false)
	})

	it('通配符匹配：支持复杂glob模式', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [new GlobMatch('**/.git/**', { caseSensitive: false })]

		expect(needIncludeFromGlobRules('.git/config', inclusion, exclusion)).toBe(
			false,
		)
		expect(
			needIncludeFromGlobRules(
				'project/.git/hooks/pre-commit',
				inclusion,
				exclusion,
			),
		).toBe(false)
		expect(
			needIncludeFromGlobRules('src/git-utils.js', inclusion, exclusion),
		).toBe(true)
	})

	// --- 大小写敏感测试 ---
	it('大小写敏感：区分大小写的匹配', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [new GlobMatch('README.md', { caseSensitive: true })]

		expect(needIncludeFromGlobRules('README.md', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('readme.md', inclusion, exclusion)).toBe(
			true,
		)
	})

	it('大小写不敏感：忽略大小写的匹配', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [new GlobMatch('README.md', { caseSensitive: false })]

		expect(needIncludeFromGlobRules('README.md', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('readme.md', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('ReadMe.MD', inclusion, exclusion)).toBe(
			false,
		)
	})

	// --- 边界情况测试 ---
	it('空路径：处理空字符串路径', () => {
		const inclusion = [new GlobMatch('', { caseSensitive: false })]
		const exclusion: GlobMatch[] = []

		const result = needIncludeFromGlobRules('', inclusion, exclusion)
		expect(result).toBe(true)
	})

	it('特殊字符：处理包含特殊字符的路径', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [new GlobMatch('*@2x.*', { caseSensitive: false })]

		expect(needIncludeFromGlobRules('icon@2x.png', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('icon@1x.png', inclusion, exclusion)).toBe(
			true,
		)
	})

	// --- 复杂场景测试 ---
	it('Obsidian默认配置：模拟插件的修正后排除规则', () => {
		const inclusion = [
			new GlobMatch('.obsidian/bookmarks.json', { caseSensitive: false }),
		]
		const exclusion = [
			new GlobMatch('.git', { caseSensitive: false }),
			new GlobMatch('**/.git', { caseSensitive: false }),
			new GlobMatch('**/.git/**', { caseSensitive: false }),
			new GlobMatch('.DS_Store', { caseSensitive: false }),
			new GlobMatch('**/.DS_Store', { caseSensitive: false }),
			new GlobMatch('.obsidian', { caseSensitive: false }),
			new GlobMatch('.obsidian/**', { caseSensitive: false }),
			new GlobMatch('**/.obsidian/**', { caseSensitive: false }),
		]

		expect(
			needIncludeFromGlobRules(
				'.obsidian/bookmarks.json',
				inclusion,
				exclusion,
			),
		).toBe(true)

		expect(needIncludeFromGlobRules('.git', inclusion, exclusion)).toBe(false)
		expect(needIncludeFromGlobRules('.DS_Store', inclusion, exclusion)).toBe(
			false,
		)
		expect(
			needIncludeFromGlobRules('.obsidian/settings.json', inclusion, exclusion),
		).toBe(false)
		expect(
			needIncludeFromGlobRules('subfolder/.DS_Store', inclusion, exclusion),
		).toBe(false)

		expect(
			needIncludeFromGlobRules('notes/my-note.md', inclusion, exclusion),
		).toBe(true)
	})

	it('白名单模式：只包含特定类型的文件', () => {
		const inclusion = [
			new GlobMatch('*.md', { caseSensitive: false }),
			new GlobMatch('*.txt', { caseSensitive: false }),
		]
		const exclusion = [new GlobMatch('*', { caseSensitive: false })]

		expect(needIncludeFromGlobRules('notes.md', inclusion, exclusion)).toBe(
			true,
		)
		expect(needIncludeFromGlobRules('readme.txt', inclusion, exclusion)).toBe(
			true,
		)
		expect(needIncludeFromGlobRules('script.js', inclusion, exclusion)).toBe(
			false,
		)
		expect(needIncludeFromGlobRules('image.png', inclusion, exclusion)).toBe(
			false,
		)
	})

	it('复杂路径：处理深层嵌套的文件路径', () => {
		const inclusion: GlobMatch[] = []
		const exclusion = [
			new GlobMatch('**/node_modules/**', { caseSensitive: false }),
			new GlobMatch('**/*.log', { caseSensitive: false }),
		]

		expect(
			needIncludeFromGlobRules(
				'src/components/Button.tsx',
				inclusion,
				exclusion,
			),
		).toBe(true)
		expect(
			needIncludeFromGlobRules(
				'backend/node_modules/express/index.js',
				inclusion,
				exclusion,
			),
		).toBe(false)
		expect(needIncludeFromGlobRules('logs/app.log', inclusion, exclusion)).toBe(
			false,
		)
		expect(
			needIncludeFromGlobRules('src/utils/logger.ts', inclusion, exclusion),
		).toBe(true)
	})

	// --- 高级通配符模式测试 ---
	describe('高级通配符模式', () => {
		it('多层嵌套目录：深度匹配测试', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('**/test/**/fixtures/**', { caseSensitive: false }),
				new GlobMatch('src/**/*.spec.*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules(
					'src/components/Button.tsx',
					inclusion,
					exclusion,
				),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'src/components/Button.spec.tsx',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'lib/test/unit/fixtures/data.json',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'e2e/test/fixtures/mock.js',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'test/fixtures/sample.txt',
					inclusion,
					exclusion,
				),
			).toBe(false)
		})

		it('组合匹配：使用花括号进行多选匹配', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('**/*.{log,tmp,bak}', { caseSensitive: false }),
				new GlobMatch('**/{cache,temp}/**', { caseSensitive: false }),
			]

			expect(needIncludeFromGlobRules('app.log', inclusion, exclusion)).toBe(
				false,
			)
			expect(
				needIncludeFromGlobRules('logs/app.log', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('backup/file.bak', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('session.tmp', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('data/cache/file.txt', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('build/temp/output.js', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('src/main.js', inclusion, exclusion),
			).toBe(true)
		})

		it('复杂问号匹配：单字符占位符', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('test?.txt', { caseSensitive: false }),
				new GlobMatch('**/?-backup-*', { caseSensitive: false }),
			]

			expect(needIncludeFromGlobRules('test1.txt', inclusion, exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('testA.txt', inclusion, exclusion)).toBe(
				false,
			)
			expect(needIncludeFromGlobRules('test10.txt', inclusion, exclusion)).toBe(
				true,
			)
			expect(
				needIncludeFromGlobRules('data/x-backup-file', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('logs/backup-file', inclusion, exclusion),
			).toBe(true)
		})

		it('混合通配符：星号与问号组合', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('*.min.?s', { caseSensitive: false }),
				new GlobMatch('**/*-v?.*.tar.gz', { caseSensitive: false }),
			]

			expect(needIncludeFromGlobRules('app.min.js', inclusion, exclusion)).toBe(
				false,
			)
			expect(
				needIncludeFromGlobRules('styles.min.css', inclusion, exclusion),
			).toBe(true) // css 是两个字符
			expect(needIncludeFromGlobRules('lib.min.ts', inclusion, exclusion)).toBe(
				false,
			)
			expect(
				needIncludeFromGlobRules(
					'release/app-v1.2.3.tar.gz',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'release/app-v10.1.0.tar.gz',
					inclusion,
					exclusion,
				),
			).toBe(true)
		})
	})

	// --- 字符范围和否定匹配测试 ---
	describe('字符范围匹配', () => {
		it('数字范围匹配：版本文件和编号文件', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('backup[0-9].sql', { caseSensitive: false }),
				new GlobMatch('**/*[1-3].log', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('backup5.sql', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('backup10.sql', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('logs/error1.log', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('logs/error4.log', inclusion, exclusion),
			).toBe(true)
		})

		it('字母范围匹配：文件等级和类型', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('level[A-C].data', { caseSensitive: true }),
				new GlobMatch('**/*[a-z].temp', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('levelA.data', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('levelD.data', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('levela.data', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('cache/filex.temp', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('cache/file1.temp', inclusion, exclusion),
			).toBe(true)
		})
	})

	// --- 路径分隔符和边缘情况测试 ---
	describe('路径分隔符处理', () => {
		it('路径开头和结尾的处理', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('/absolute/path/**', { caseSensitive: false }),
				new GlobMatch('**/trailing/', { caseSensitive: false }),
				new GlobMatch('**//double-slash//**', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules(
					'/absolute/path/file.txt',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'relative/absolute/path/file.txt',
					inclusion,
					exclusion,
				),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('folder/trailing/', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('folder/trailing', inclusion, exclusion),
			).toBe(true)
		})

		it('特殊路径字符处理', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('**/*[\\[\\]]*', { caseSensitive: false }),
				new GlobMatch('**/*.{png,jpg}', { caseSensitive: false }),
			]
			expect(
				needIncludeFromGlobRules('folder/file[1].txt', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('pictures/photo.png', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('document.pdf', inclusion, exclusion),
			).toBe(true)
		})

		it('空目录和根目录处理', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('.', { caseSensitive: false }),
				new GlobMatch('..', { caseSensitive: false }),
				new GlobMatch('./', { caseSensitive: false }),
				new GlobMatch('../', { caseSensitive: false }),
			]

			expect(needIncludeFromGlobRules('.', inclusion, exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('..', inclusion, exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('./', inclusion, exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('../', inclusion, exclusion)).toBe(false)
			expect(needIncludeFromGlobRules('./file.txt', inclusion, exclusion)).toBe(
				true,
			)
		})
	})

	// --- Obsidian 实际使用场景测试 ---
	describe('Obsidian 知识库管理场景', () => {
		it('笔记分类和模板管理', () => {
			const inclusion = [
				new GlobMatch('templates/*.md', { caseSensitive: false }),
				new GlobMatch('**/daily-notes/**/*.md', { caseSensitive: false }),
			]
			const exclusion = [
				new GlobMatch('**/.trash/**', { caseSensitive: false }),
				new GlobMatch('**/draft-*', { caseSensitive: false }),
				new GlobMatch('**/*-private.md', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('templates/meeting.md', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'journal/daily-notes/2024/01-15.md',
					inclusion,
					exclusion,
				),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'notes/public-article.md',
					inclusion,
					exclusion,
				),
			).toBe(true)

			expect(
				needIncludeFromGlobRules(
					'notes/.trash/deleted.md',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'ideas/draft-research.md',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'personal/thoughts-private.md',
					inclusion,
					exclusion,
				),
			).toBe(false)
		})

		it('多语言笔记库管理', () => {
			const inclusion = [
				new GlobMatch('**/en/**/*.md', { caseSensitive: false }),
				new GlobMatch('**/zh/**/*.md', { caseSensitive: false }),
			]
			const exclusion = [
				new GlobMatch('**/ja/**', { caseSensitive: false }),
				new GlobMatch('**/ko/**', { caseSensitive: false }),
				new GlobMatch('**/*-draft-*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('content/en/article.md', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('content/zh/文章.md', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('content/ja/記事.md', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'content/en/work-draft-v1.md',
					inclusion,
					exclusion,
				),
			).toBe(true)
		})

		it('插件和配置文件管理', () => {
			const inclusion = [
				new GlobMatch('.obsidian/plugins/*/manifest.json', {
					caseSensitive: false,
				}),
				new GlobMatch('.obsidian/themes/*.css', { caseSensitive: false }),
				new GlobMatch('.obsidian/{app,appearance,core-plugins}.json', {
					caseSensitive: false,
				}),
			]
			const exclusion = [
				new GlobMatch('.obsidian/workspace*', { caseSensitive: false }),
				new GlobMatch('.obsidian/plugins/*/data.json', {
					caseSensitive: false,
				}),
				new GlobMatch('.obsidian/plugins/*/node_modules/**', {
					caseSensitive: false,
				}),
			]

			expect(
				needIncludeFromGlobRules('.obsidian/app.json', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'.obsidian/plugins/custom-plugin/manifest.json',
					inclusion,
					exclusion,
				),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'.obsidian/themes/dark-theme.css',
					inclusion,
					exclusion,
				),
			).toBe(true)

			expect(
				needIncludeFromGlobRules(
					'.obsidian/workspace.json',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'.obsidian/plugins/sync/data.json',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'.obsidian/plugins/custom/node_modules/lib.js',
					inclusion,
					exclusion,
				),
			).toBe(false)
		})
	})

	// --- xxx/* 模式匹配测试 ---
	describe('xxx/* 模式匹配测试', () => {
		it('单级目录匹配：src/* 模式', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('src/*', { caseSensitive: false }),
				new GlobMatch('build/*', { caseSensitive: false }),
				new GlobMatch('temp/*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('src/main.js', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('build/app.js', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('temp/cache.txt', inclusion, exclusion),
			).toBe(false)

			expect(
				needIncludeFromGlobRules('src/utils/helper.js', inclusion, exclusion),
			).toBe(true)
			expect(needIncludeFromGlobRules('src', inclusion, exclusion)).toBe(true)
			expect(
				needIncludeFromGlobRules('other/src/main.js', inclusion, exclusion),
			).toBe(true)
		})

		it('多层目录匹配：xxx/*/* 模式', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('node_modules/*/*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules(
					'node_modules/express/index.js',
					inclusion,
					exclusion,
				),
			).toBe(false)

			expect(
				needIncludeFromGlobRules('node_modules/express', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'node_modules/express/lib/router/index.js',
					inclusion,
					exclusion,
				),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('src/tests/main.js', inclusion, exclusion),
			).toBe(true)
		})

		it('包含模式：xxx/* 白名单', () => {
			const inclusion = [
				new GlobMatch('docs/*', { caseSensitive: false }),
				new GlobMatch('examples/*', { caseSensitive: false }),
				new GlobMatch('tutorials/*', { caseSensitive: false }),
			]
			const exclusion = [new GlobMatch('**', { caseSensitive: false })]

			expect(
				needIncludeFromGlobRules('docs/README.md', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('examples/basic.js', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('tutorials/intro.md', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('src/main.js', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'docs/guide/advanced.md',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('config.json', inclusion, exclusion),
			).toBe(false)
		})

		it('混合模式：xxx/* 与 **/* 组合', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('temp/*', { caseSensitive: false }),
				new GlobMatch('cache/**/*', { caseSensitive: false }),
				new GlobMatch('logs/*', { caseSensitive: false }),
				new GlobMatch('**/node_modules/**', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('temp/file.txt', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('temp/sub/file.txt', inclusion, exclusion),
			).toBe(true)

			expect(
				needIncludeFromGlobRules('cache/data.json', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('cache/sub/data.json', inclusion, exclusion),
			).toBe(false)

			expect(
				needIncludeFromGlobRules('logs/app.log', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('logs/daily/app.log', inclusion, exclusion),
			).toBe(true)

			expect(
				needIncludeFromGlobRules('node_modules/lib.js', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'src/node_modules/express/index.js',
					inclusion,
					exclusion,
				),
			).toBe(false)
		})

		it('特殊字符目录：包含特殊字符的 xxx/* 模式', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('.git/*', { caseSensitive: false }),
				new GlobMatch('__pycache__/*', { caseSensitive: false }),
				new GlobMatch('@types/*', { caseSensitive: false }),
				new GlobMatch('node_modules/@scope/*', { caseSensitive: false }),
			]
			expect(
				needIncludeFromGlobRules('.git/config', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('__pycache__/main.pyc', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('@types/node.d.ts', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'node_modules/@scope/package.json',
					inclusion,
					exclusion,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('.git/hooks/pre-commit', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules('src/@types/custom.ts', inclusion, exclusion),
			).toBe(true)
			expect(
				needIncludeFromGlobRules(
					'node_modules/@scope/lib/index.js',
					inclusion,
					exclusion,
				),
			).toBe(true)
		})

		it('大小写敏感：xxx/* 模式的大小写处理', () => {
			const caseInclusionSensitive: GlobMatch[] = []
			const caseExclusionSensitive = [
				new GlobMatch('Src/*', { caseSensitive: true }),
				new GlobMatch('Build/*', { caseSensitive: true }),
			]

			const caseInclusionInsensitive: GlobMatch[] = []
			const caseExclusionInsensitive = [
				new GlobMatch('Src/*', { caseSensitive: false }),
				new GlobMatch('Build/*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules(
					'Src/main.js',
					caseInclusionSensitive,
					caseExclusionSensitive,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'src/main.js',
					caseInclusionSensitive,
					caseExclusionSensitive,
				),
			).toBe(true)

			expect(
				needIncludeFromGlobRules(
					'Src/main.js',
					caseInclusionInsensitive,
					caseExclusionInsensitive,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'src/main.js',
					caseInclusionInsensitive,
					caseExclusionInsensitive,
				),
			).toBe(false)
			expect(
				needIncludeFromGlobRules(
					'SRC/main.js',
					caseInclusionInsensitive,
					caseExclusionInsensitive,
				),
			).toBe(false)
		})

		it('边界情况：空目录名和根级文件', () => {
			const inclusion: GlobMatch[] = []
			const exclusion = [
				new GlobMatch('/*', { caseSensitive: false }),
				new GlobMatch('tmp/*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('/config.json', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('/etc/config', inclusion, exclusion),
			).toBe(true)

			expect(
				needIncludeFromGlobRules('tmp/file.txt', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('config.json', inclusion, exclusion),
			).toBe(true)
		})

		it('复杂组合：多个 xxx/* 模式的优先级', () => {
			const inclusion = [new GlobMatch('important/*', { caseSensitive: false })]
			const exclusion = [
				new GlobMatch('temp/*', { caseSensitive: false }),
				new GlobMatch('cache/*', { caseSensitive: false }),
				new GlobMatch('logs/*', { caseSensitive: false }),
				new GlobMatch('important/*', { caseSensitive: false }),
			]

			expect(
				needIncludeFromGlobRules('important/data.json', inclusion, exclusion),
			).toBe(true)

			expect(
				needIncludeFromGlobRules('temp/file.txt', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('cache/data.json', inclusion, exclusion),
			).toBe(false)
			expect(
				needIncludeFromGlobRules('logs/app.log', inclusion, exclusion),
			).toBe(false)

			expect(
				needIncludeFromGlobRules('src/main.js', inclusion, exclusion),
			).toBe(true)
		})
	})
})

describe('extendRules', () => {
	// --- 基础功能测试 ---
	it('应该扩展普通文件夹规则', () => {
		const rules = [
			new GlobMatch('.git', { caseSensitive: false }),
			new GlobMatch('node_modules', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 应该包含原有规则 + 扩展规则（每个规则扩展为 3 个）
		expect(extended.length).toBe(8)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('.git')
		expect(exprs).toContain('.git/**')
		expect(exprs).toContain('**/.git')
		expect(exprs).toContain('**/.git/**')
		expect(exprs).toContain('node_modules')
		expect(exprs).toContain('node_modules/**')
		expect(exprs).toContain('**/node_modules')
		expect(exprs).toContain('**/node_modules/**')
	})

	it('应该扩展以斜杠结尾的文件夹规则', () => {
		const rules = [
			new GlobMatch('.obsidian/', { caseSensitive: false }),
			new GlobMatch('temp/', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		expect(extended.length).toBe(8)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('.obsidian/')
		expect(exprs).toContain('.obsidian/**')
		expect(exprs).toContain('**/.obsidian')
		expect(exprs).toContain('**/.obsidian/**')
		expect(exprs).toContain('temp/')
		expect(exprs).toContain('temp/**')
		expect(exprs).toContain('**/temp')
		expect(exprs).toContain('**/temp/**')
	})

	// --- 跳过规则测试 ---
	it('应该跳过以 ! 开头的规则', () => {
		const rules = [
			new GlobMatch('!important', { caseSensitive: false }),
			new GlobMatch('!.gitkeep', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 应该只包含原有规则，不扩展
		expect(extended.length).toBe(2)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('!important')
		expect(exprs).toContain('!.gitkeep')
	})

	it('应该跳过包含通配符的规则', () => {
		const rules = [
			new GlobMatch('*.log', { caseSensitive: false }),
			new GlobMatch('test*.txt', { caseSensitive: false }),
			new GlobMatch('**/.git', { caseSensitive: false }),
			new GlobMatch('node_modules/*', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 应该只包含原有规则，不扩展
		expect(extended.length).toBe(4)
		expect(extended.every((rule, i) => rule.expr === rules[i].expr)).toBe(true)
	})

	it('应该跳过以 ** 结尾的规则', () => {
		const rules = [
			new GlobMatch('.git/**', { caseSensitive: false }),
			new GlobMatch('node_modules/**', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 应该只包含原有规则，不扩展
		expect(extended.length).toBe(2)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('.git/**')
		expect(exprs).toContain('node_modules/**')
	})

	it('应该跳过以 **/ 开头的规则', () => {
		const rules = [
			new GlobMatch('**/.git', { caseSensitive: false }),
			new GlobMatch('**/node_modules', { caseSensitive: false }),
			new GlobMatch('**/.DS_Store', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 已经是全局匹配，不需要扩展
		expect(extended.length).toBe(3)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('**/.git')
		expect(exprs).toContain('**/node_modules')
		expect(exprs).toContain('**/.DS_Store')
	})

	it('应该正确处理以 / 开头的规则（只匹配根目录）', () => {
		const rules = [
			new GlobMatch('/.git', { caseSensitive: false }),
			new GlobMatch('/temp', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 以 / 开头表示根目录，只添加 /** 后缀，不添加 **/ 前缀
		expect(extended.length).toBe(4)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('/.git')
		expect(exprs).toContain('/.git/**')
		expect(exprs).toContain('/temp')
		expect(exprs).toContain('/temp/**')
	})

	// --- 混合规则测试 ---
	it('应该正确处理混合规则', () => {
		const rules = [
			new GlobMatch('.git', { caseSensitive: false }), // 应扩展 -> +3
			new GlobMatch('*.log', { caseSensitive: false }), // 跳过（包含*）
			new GlobMatch('node_modules/', { caseSensitive: false }), // 应扩展 -> +3
			new GlobMatch('!important', { caseSensitive: false }), // 跳过（以!开头）
			new GlobMatch('temp/**', { caseSensitive: false }), // 跳过（以**结尾）
		]

		const extended = extendRules(rules)

		// 原有5个 + 扩展6个（2个规则各扩展3个）= 11个
		expect(extended.length).toBe(11)
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('.git')
		expect(exprs).toContain('.git/**')
		expect(exprs).toContain('**/.git')
		expect(exprs).toContain('**/.git/**')
		expect(exprs).toContain('*.log')
		expect(exprs).toContain('node_modules/')
		expect(exprs).toContain('node_modules/**')
		expect(exprs).toContain('**/node_modules')
		expect(exprs).toContain('**/node_modules/**')
		expect(exprs).toContain('!important')
		expect(exprs).toContain('temp/**')
	})

	it('应该正确处理包含所有边界情况的混合规则', () => {
		const rules = [
			new GlobMatch('.git', { caseSensitive: false }), // 普通规则 -> +3
			new GlobMatch('**/.DS_Store', { caseSensitive: false }), // 以 **/ 开头，跳过
			new GlobMatch('/.obsidian', { caseSensitive: false }), // 以 / 开头 -> +1
			new GlobMatch('*.log', { caseSensitive: false }), // 包含 *，跳过
			new GlobMatch('temp/**', { caseSensitive: false }), // 以 ** 结尾，跳过
			new GlobMatch('!important', { caseSensitive: false }), // 以 ! 开头，跳过
		]

		const extended = extendRules(rules)

		// 原有6个 + .git扩展3个 + /.obsidian扩展1个 = 10个
		expect(extended.length).toBe(10)

		// 验证关键规则存在（不关心顺序）
		const exprs = extended.map((r) => r.expr)
		expect(exprs).toContain('.git')
		expect(exprs).toContain('.git/**')
		expect(exprs).toContain('**/.git')
		expect(exprs).toContain('**/.git/**')
		expect(exprs).toContain('**/.DS_Store')
		expect(exprs).toContain('/.obsidian')
		expect(exprs).toContain('/.obsidian/**')
		expect(exprs).toContain('*.log')
		expect(exprs).toContain('temp/**')
		expect(exprs).toContain('!important')
	})

	// --- 不可变性测试 ---
	it('不应该修改原数组', () => {
		const rules = [
			new GlobMatch('.git', { caseSensitive: false }),
			new GlobMatch('node_modules', { caseSensitive: false }),
		]
		const originalLength = rules.length

		const extended = extendRules(rules)

		// 原数组不应被修改
		expect(rules.length).toBe(originalLength)
		expect(extended).not.toBe(rules)
	})

	// --- 选项保持测试 ---
	it('应该保持原规则的选项配置', () => {
		const rules = [
			new GlobMatch('.git', { caseSensitive: true }),
			new GlobMatch('node_modules', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		// 扩展规则应该保持原规则的选项
		const gitRules = extended.filter(
			(r) =>
				r.expr === '.git' ||
				r.expr === '.git/**' ||
				r.expr === '**/.git' ||
				r.expr === '**/.git/**',
		)
		const nodeRules = extended.filter(
			(r) =>
				r.expr === 'node_modules' ||
				r.expr === 'node_modules/**' ||
				r.expr === '**/node_modules' ||
				r.expr === '**/node_modules/**',
		)

		gitRules.forEach((rule) => {
			expect(rule.options.caseSensitive).toBe(true)
		})
		nodeRules.forEach((rule) => {
			expect(rule.options.caseSensitive).toBe(false)
		})
	})

	// --- 实际使用场景测试 ---
	it('扩展后的规则应该能正确匹配文件夹内的文件', () => {
		const rules = [new GlobMatch('.git', { caseSensitive: false })]
		const extended = extendRules(rules)

		// 验证生成了 4 个规则
		expect(extended.length).toBe(4)

		// 测试各种路径的匹配情况
		const testCases = [
			{ path: '.git', expected: true }, // 根目录的 .git
			{ path: '.git/config', expected: true }, // 根目录 .git 内的文件
			{ path: '.git/hooks/pre-commit', expected: true }, // 根目录 .git 深层文件
			{ path: 'project/.git', expected: true }, // 子目录中的 .git
			{ path: 'src/project/.git', expected: true }, // 深层子目录中的 .git
			{ path: 'project/.git/config', expected: true }, // 子目录 .git 内的文件
			{ path: 'src/project/.git/hooks/pre-commit', expected: true }, // 深层 .git 内的文件
		]

		testCases.forEach(({ path, expected }) => {
			const matched = extended.some((rule) => rule.test(path))
			expect(matched).toBe(expected)
		})
	})

	it('与 needIncludeFromGlobRules 集成测试', () => {
		const exclusionRules = [
			new GlobMatch('.git', { caseSensitive: false }),
			new GlobMatch('.obsidian', { caseSensitive: false }),
		]
		const extended = extendRules(exclusionRules)

		// 应该排除文件夹本身
		expect(needIncludeFromGlobRules('.git', [], extended)).toBe(false)
		expect(needIncludeFromGlobRules('.obsidian', [], extended)).toBe(false)

		// 应该排除文件夹内的文件
		expect(needIncludeFromGlobRules('.git/config', [], extended)).toBe(false)
		expect(
			needIncludeFromGlobRules('.obsidian/workspace.json', [], extended),
		).toBe(false)

		// 不应该排除其他文件
		expect(needIncludeFromGlobRules('readme.md', [], extended)).toBe(true)
	})

	// --- 边界情况测试 ---
	it('应该处理空数组', () => {
		const rules: GlobMatch[] = []
		const extended = extendRules(rules)

		expect(extended.length).toBe(0)
	})

	it('应该处理特殊路径字符', () => {
		const rules = [
			new GlobMatch('@types', { caseSensitive: false }),
			new GlobMatch('__pycache__', { caseSensitive: false }),
			new GlobMatch('.DS_Store', { caseSensitive: false }),
		]

		const extended = extendRules(rules)

		expect(extended.length).toBe(12)
		const exprs = extended.map((r) => r.expr)
		// @types 的扩展
		expect(exprs).toContain('@types')
		expect(exprs).toContain('@types/**')
		expect(exprs).toContain('**/@types')
		expect(exprs).toContain('**/@types/**')
		// __pycache__ 的扩展
		expect(exprs).toContain('__pycache__')
		expect(exprs).toContain('__pycache__/**')
		expect(exprs).toContain('**/__pycache__')
		expect(exprs).toContain('**/__pycache__/**')
		// .DS_Store 的扩展
		expect(exprs).toContain('.DS_Store')
		expect(exprs).toContain('.DS_Store/**')
		expect(exprs).toContain('**/.DS_Store')
		expect(exprs).toContain('**/.DS_Store/**')
	})
})
