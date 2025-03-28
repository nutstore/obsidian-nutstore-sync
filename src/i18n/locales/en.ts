export default {
	settings: {
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
			name: 'Check connection',
			desc: 'Click to check WebDAV connection',
			success: 'WebDAV connection successful',
			failure: 'WebDAV connection failed',
			successButton: 'Connected ✓',
			failureButton: 'Failed ×',
		},
		remoteDir: {
			name: 'Remote directory',
			desc: 'Enter the remote directory',
			placeholder: 'Enter the remote directory',
			edit: 'Edit',
		},
		login: {
			name: 'Login',
			desc: 'Click to login',
			success: 'Login successful',
			failure: 'Login failed, please try again',
		},
		loginMode: {
			name: 'Login mode',
			manual: 'Manual input',
			sso: 'Single sign-on',
		},
		ssoStatus: {
			loggedIn: 'Logged in',
			notLoggedIn: 'Not logged in',
			logout: 'Logout',
			logoutSuccess: 'Logged out successfully',
		},
		useGitStyle: {
			name: 'Use git-style conflict markers',
			desc: 'Use <<<<<<< and >>>>>>> markers for conflicts instead of HTML tags',
		},
		backupWarning: {
			name: 'Backup warning',
			desc: '⚠️ Note: Sync process will modify or delete local files. Please backup important files before syncing.',
		},
		conflictStrategy: {
			name: 'Conflict resolution strategy',
			desc: 'Choose how to resolve file conflicts. \nNote: It is recommended to backup important files before using auto-merge feature to prevent data loss.',
			diffMatchPatch: 'Smart merge (Recommended)',
			latestTimestamp: 'Use latest version',
		},
		confirmBeforeSync: {
			name: 'Confirm before sync',
			desc: 'Show pending tasks and execute after confirmation',
		},
		sections: {
			account: 'Account',
			common: 'General',
		},
		logout: {
			confirmTitle: 'Confirm logout',
			confirmMessage:
				'Are you sure you want to log out? You will need to log in again to continue syncing.',
			confirm: 'Confirm logout',
			cancel: 'Cancel',
		},
		help: {
			name: 'How to get WebDAV account and credential?',
			desc: 'Click to view help documentation',
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
		startButton: 'Start sync',
		stopButton: 'Stop sync',
		failedStatus: 'Sync failed',
		cancelled: 'Sync cancelled',
		modalTitle: 'Syncing',
		cancelButton: 'Cancel sync',
		progressText: 'Syncing files',
		confirmModal: {
			title: 'Sync confirmation',
			message:
				'⚠️ Please note:\n\n1. Sync operation may modify or delete local files\n2. It is recommended to backup important files before syncing\n3. In case of file conflicts, manual resolution may be required\n4. Initial sync will process all files and may take longer, please be patient\n\nAre you sure you want to start syncing?',
			confirm: 'Confirm sync',
			cancel: 'Cancel',
			remoteDir: 'Remote directory: {{dir}}',
			strategy: 'Sync strategy: {{strategy}}',
		},
	},
	taskList: {
		title: 'Sync Task List',
		instruction:
			'Please review the tasks below. Click "Continue" to execute the selected tasks, or "Cancel" to skip this sync.',
		execute: 'Execute',
		action: 'Action',
		localPath: 'Local Path',
		remotePath: 'Remote Path',
		continue: 'Continue',
		cancel: 'Cancel',
		actions: {
			merge: 'Merge',
			createLocalDir: 'Create Local Directory',
			createRemoteDir: 'Create Remote Directory',
			download: 'Download',
			upload: 'Upload',
			removeLocal: 'Remove Local',
			removeRemote: 'Remove Remote',
			sync: 'Sync',
		},
	},
}
