# 🔄 Nutstore Sync

This plugin enables two-way synchronization between Obsidian notes and Nutstore via WebDAV protocol.

## ✨ Key Features

- **Two-way Sync**: Efficiently synchronize your notes across devices
- **Incremental Sync**: Fast updates that only transfer changed files, making large vaults sync quickly
- **Single Sign-On**: Connect to Nutstore with simple authorization instead of manually entering WebDAV credentials
- **WebDAV Explorer**: Visual file browser for remote file management
- **Smart Conflict Resolution**:
  - Character-level comparison to automatically merge changes when possible
  - Option to use timestamp-based resolution (newest file wins)
- **Loose Sync Mode**: Optimize performance for vaults with thousands of notes
- **Large File Handling**: Set size limits to skip large files for better performance
- **Sync Status Tracking**: Clear visual indicators of sync progress and completion
- **Detailed Logging**: Comprehensive logs for troubleshooting

## ⚠️ Important Notes

- ⏳ Initial sync may take longer (especially with many files)
- 💾 Please backup before syncing

## 🔍 Sync Algorithm

```mermaid
flowchart TD
 subgraph s1["Directory Sync Process"]
        RemoteToLocal{"Check Remote Dir"}
        SyncFolders{"Start Dir Sync"}
        ValidateType{"Type Validation<br>Ensure both are dirs"}
        ErrorFolder["Error: Type Conflict<br>One is file, other is dir"]
        CheckRemoteFolderChanged{"Check Remote Dir<br>for Changes"}
        CreateLocalDir["Create Local Dir"]
        CheckRemoteRemovable{"Check if Remote Removable<br>1.Scan subfiles<br>2.Verify timestamps"}
        RemoveRemoteFolder["Remove Remote Dir"]
        CreateLocalFolder["Create Local Dir"]
        LocalToRemote{"Check Local Dir"}
        CheckLocalFolderRecord{"Check Local Sync Record"}
        CreateRemoteFolder["Create Remote Dir"]
        CheckLocalFolderRemovable{"Check if Local Removable<br>1.Scan subfiles<br>2.Verify timestamps"}
        RemoveLocalFolder["Remove Local Dir"]
        CreateRemoteDirNew["Create Remote Dir"]
  end
 subgraph s2["File Sync Process"]
        CheckSyncRecord{"Check Sync Record"}
        SyncFiles{"Start File Sync"}
        ExistenceCheck{"Check File Existence"}
        ChangeCheck{"Check Change Status<br>Compare Timestamps"}
        Conflict["Resolve Conflict<br>Use Latest Timestamp"]
        Download["Download Remote File"]
        Upload["Upload Local File"]
        RemoteOnlyCheck{"Check Remote File"}
        DownloadNew["Download New File"]
        DeleteRemoteFile["Delete Remote File"]
        LocalOnlyCheck{"Check Local File"}
        UploadNew["Upload New File"]
        DeleteLocalFile["Delete Local File"]
        NoRecordCheck{"Check File Status"}
        ResolveConflict["Resolve Conflict<br>Use Latest Timestamp"]
        PullNewFile["Download Remote File"]
        PushNewFile["Upload Local File"]
  end
    Start(["Start Sync"]) --> PrepareSync["Prepare Sync Environment<br>1.Create Remote Base Dir<br>2.Load Sync Records"]
    PrepareSync --> LoadStats["Get File Stats<br>1.Scan Local Files<br>2.Scan Remote Files"]
    LoadStats --> SyncFolders
    SyncFolders -- "Step 1: Remote to Local" --> RemoteToLocal
    RemoteToLocal -- "Local Exists" --> ValidateType
    ValidateType -- "Type Mismatch" --> ErrorFolder
    RemoteToLocal -- "Local Missing but Has Record" --> CheckRemoteFolderChanged
    CheckRemoteFolderChanged -- "Remote Modified" --> CreateLocalDir
    CheckRemoteFolderChanged -- "Remote Unchanged" --> CheckRemoteRemovable
    CheckRemoteRemovable -- "Can Remove" --> RemoveRemoteFolder
    RemoteToLocal -- "No Record" --> CreateLocalFolder
    SyncFolders -- "Step 2: Local to Remote" --> LocalToRemote
    LocalToRemote -- "Remote Missing" --> CheckLocalFolderRecord
    CheckLocalFolderRecord -- "Has Record & Local Changed" --> CreateRemoteFolder
    CheckLocalFolderRecord -- "Has Record Unchanged" --> CheckLocalFolderRemovable
    CheckLocalFolderRemovable -- "Can Remove" --> RemoveLocalFolder
    CheckLocalFolderRecord -- "No Record" --> CreateRemoteDirNew
    SyncFiles --> CheckSyncRecord & UpdateRecords["Update Sync Records"]
    CheckSyncRecord -- "Has Sync Record" --> ExistenceCheck
    ExistenceCheck -- "Both Exist" --> ChangeCheck
    ChangeCheck -- "Both Changed" --> Conflict
    ChangeCheck -- "Remote Changed Only" --> Download
    ChangeCheck -- "Local Changed Only" --> Upload
    ExistenceCheck -- "Remote Only" --> RemoteOnlyCheck
    RemoteOnlyCheck -- "Remote Changed" --> DownloadNew
    RemoteOnlyCheck -- "Remote Unchanged" --> DeleteRemoteFile
    ExistenceCheck -- "Local Only" --> LocalOnlyCheck
    LocalOnlyCheck -- "Local Changed" --> UploadNew
    LocalOnlyCheck -- "Local Unchanged" --> DeleteLocalFile
    CheckSyncRecord -- "No Sync Record" --> NoRecordCheck
    NoRecordCheck -- "Both Exist" --> ResolveConflict
    NoRecordCheck -- "Remote Only" --> PullNewFile
    NoRecordCheck -- "Local Only" --> PushNewFile
    SyncFolders --> SyncFiles
    UpdateRecords --> End(["Sync Complete"])
```
