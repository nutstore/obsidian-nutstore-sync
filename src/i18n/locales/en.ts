export default {
	settings: {
		title: 'WebDAV Settings',
		account: {
			name: 'Account',
			desc: 'Enter your WebDAV account',
			placeholder: 'Enter your account',
		},
		credential: {
			name: 'Credential',
			desc: 'Enter your WebDAV credential',
			placeholder: 'Enter your credential',
		},
		checkConnection: {
			name: 'Check Connection',
			desc: 'Click to check WebDAV connection',
			success: 'WebDAV connection successful',
			failure: 'WebDAV connection failed',
		},
		remoteDir: {
			name: 'Remote Directory',
			desc: 'Enter the remote directory',
			placeholder: 'Enter the remote directory',
		},
		login: {
			name: 'Login',
			desc: 'Click to login',
		},
		useGitStyle: {
			name: 'Use Git-style Conflict Markers',
			desc: 'Use <<<<<<< and >>>>>>> markers for conflicts instead of HTML tags',
		},
		backupWarning: {
			name: 'Backup Warning',
			desc: '⚠️ Note: Sync process will modify or delete local files. Please backup important files before syncing.',
		},
		conflictStrategy: {
			name: 'Conflict Resolution Strategy',
			desc: 'Choose how to resolve file conflicts',
			diffMatchPatch: 'Smart Merge (Recommended)',
			latestTimestamp: 'Use Latest Version',
		},
	},
	sync: {
		failed: 'Sync failed!',
		error: {
			folderButFile: 'Expected folder but found file: {{path}}',
			notFound: 'Not found: {{path}}',
			localPathNotFound: 'Local path not found: {{path}}',
			cannotMergeBinary: 'Cannot merge binary file',
			failedToAutoMerge: 'Failed to auto merge',
			failedToUploadMerged: 'Failed to upload merged content',
			conflictsMarkedInFile: 'Conflicts found and marked in file',
			requestsTooFrequent:
				'Requests too frequent, please wait a few minutes and try again',
		},
		requestsTooFrequent:
			'Requests too frequent, plugin will resume sync at {{time}}',
		start: '⌛️ Sync started',
		complete: '✅ Sync completed',
		completeWithFailed: '❌ Sync completed with {{failedCount}} failed tasks',
		failedWithError: 'Sync failed with error: {{error}}',
		progress: 'Sync progress: {{percent}}%',
		startButton: 'Start Sync',
		stopButton: 'Stop Sync',
		failedStatus: 'Sync Failed',
		cancelled: 'Sync cancelled',
		modalTitle: 'Syncing',
		cancelButton: 'Cancel Sync',
		progressText: 'Syncing files',
		confirmModal: {
			title: 'Sync Confirmation',
			message:
				'⚠️ Please note:\n\n1. Sync operation may modify or delete local files\n2. It is recommended to backup important files before syncing\n3. In case of file conflicts, manual resolution may be required\n4. Initial sync will process all files and may take longer, please be patient\n\nAre you sure you want to start syncing?',
			confirm: 'Confirm Sync',
			cancel: 'Cancel',
			remoteDir: 'Remote Directory: {{dir}}',
			strategy: 'Sync Strategy: {{strategy}}',
		},
	},
}
