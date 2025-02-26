export default {
	settings: {
		title: 'WebDAV 设置',
		account: {
			name: '账号',
			desc: '输入你的 WebDAV 账号',
			placeholder: '输入你的账号',
		},
		credential: {
			name: '凭证',
			desc: '输入你的 WebDAV 凭证',
			placeholder: '输入你的凭证',
		},
		remoteDir: {
			name: '远程目录',
			desc: '输入远程目录',
			placeholder: '输入远程目录',
		},
		checkConnection: {
			name: '检查连接',
			desc: '点击检查 WebDAV 连接',
			success: 'WebDAV 连接成功',
			failure: 'WebDAV 连接失败',
		},
		login: {
			name: '登录',
			desc: '点击登录',
		},
		useGitStyle: {
			name: '使用Git样式的冲突标记',
			desc: '启用后将使用 <<<<<<< 和 >>>>>>> 等标记来显示冲突，而不是HTML标记',
		},
		backupWarning: {
			name: '备份提醒',
			desc: '⚠️ 请注意：同步过程会修改或删除本地文件，建议在同步前备份重要文件。',
		},
		conflictStrategy: {
			name: '冲突解决策略',
			desc: '选择解决文件冲突的方式',
			diffMatchPatch: '智能合并(推荐)',
			latestTimestamp: '使用最新版本',
		},
	},
	sync: {
		failed: '同步失败!',
		error: {
			folderButFile: '预期文件夹但发现文件: {{path}}',
			notFound: '未找到: {{path}}',
			localPathNotFound: '本地路径未找到: {{path}}',
			cannotMergeBinary: '无法合并二进制文件',
			failedToAutoMerge: '自动合并失败',
			failedToUploadMerged: '上传合并内容失败',
			conflictsMarkedInFile: '发现冲突，已在文件中标记',
			requestsTooFrequent: '请求过于频繁，请等待几分钟后再试',
		},
		requestsTooFrequent: '请求过于频繁，插件将在 {{time}} 后自动继续同步任务',
		start: '⌛️ 同步开始',
		complete: '✅ 同步完成',
		completeWithFailed: '❌ 同步完成，但有 {{failedCount}} 个任务失败',
		failedWithError: '同步失败，错误信息: {{error}}',
		progress: '同步进度: {{percent}}%',
		startButton: '开始同步',
		stopButton: '停止同步',
		failedStatus: '同步失败',
		cancelled: '同步已取消',
		modalTitle: '同步进行中',
		cancelButton: '取消同步',
		progressText: '正在同步文件',
		confirmModal: {
			title: '同步确认',
			message:
				'⚠️ 请注意：\n\n1. 同步操作可能会修改或删除本地文件\n2. 建议在同步前手动备份重要文件\n3. 如果出现文件冲突，可能需要手动解决\n4. 首次同步需要处理所有文件，可能会比较慢，请耐心等待\n\n确定要开始同步吗？',
			confirm: '确认同步',
			cancel: '取消',
			remoteDir: '远程目录：{{dir}}',
			strategy: '同步策略：{{strategy}}',
		},
	},
}
