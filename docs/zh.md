# 🔄 Nutstore Sync

此插件允许您通过 WebDAV 协议将 Obsidian 笔记与坚果云进行双向同步。

## ✨ 主要特性

- **双向同步**: 高效地在多设备间同步笔记
- **增量同步**: 只传输更改过的文件，使大型笔记库也能快速同步
- **单点登录**: 通过简单授权连接坚果云，无需手动输入 WebDAV 凭据
- **WebDAV 文件浏览器**: 远程文件管理的可视化界面
- **智能冲突解决**:
  - 字符级比较自动合并可能的更改
  - 支持基于时间戳的解决方案（最新文件优先）
- **宽松同步模式**: 优化对包含数千笔记的仓库的性能
- **大文件处理**: 设置大小限制以跳过大文件，提升性能
- **同步状态跟踪**: 清晰的同步进度和完成提示
- **详细日志**: 全面的故障排查日志

## ⚠️ 注意事项

- ⏳ 首次同步可能需要较长时间 (文件比较多时)
- 💾 请在同步之前备份

## 🔍 同步算法

```mermaid
flowchart TD
 subgraph s1["文件夹同步流程"]
        RemoteToLocal["检查远程文件夹"]
        SyncFolders["开始文件夹同步"]
        ValidateType["类型验证<br>确保两端都是文件夹"]
        ErrorFolder["错误:类型冲突<br>一端是文件另一端是文件夹"]
        CheckRemoteFolderChanged["检查远程文件夹<br>是否有变更"]
        CreateLocalDir["创建本地文件夹"]
        CheckRemoteRemovable["检查远程是否可删除<br>1.遍历子文件<br>2.验证修改时间"]
        RemoveRemoteFolder["删除远程文件夹"]
        CreateLocalFolder["创建本地文件夹"]
        LocalToRemote["检查本地文件夹"]
        CheckLocalFolderRecord["检查本地同步记录"]
        CreateRemoteFolder["创建远程文件夹"]
        CheckLocalFolderRemovable["检查本地是否可删除<br>1.遍历子文件<br>2.验证修改时间"]
        RemoveLocalFolder["删除本地文件夹"]
        CreateRemoteDirNew["创建远程文件夹"]
  end
 subgraph s2["文件同步流程"]
        CheckSyncRecord["检查同步记录"]
        SyncFiles["开始文件同步"]
        ExistenceCheck["检查文件存在情况"]
        ChangeCheck["检查变更状态<br>对比修改时间"]
        Conflict["冲突解决<br>使用最新时间戳"]
        Download["下载远程文件"]
        Upload["上传本地文件"]
        RemoteOnlyCheck["远程文件检查"]
        DownloadNew["下载新文件"]
        DeleteRemoteFile["删除远程文件"]
        LocalOnlyCheck["本地文件检查"]
        UploadNew["上传新文件"]
        DeleteLocalFile["删除本地文件"]
        NoRecordCheck["检查文件情况"]
        ResolveConflict["解决冲突<br>使用最新时间戳"]
        PullNewFile["下载远程文件"]
        PushNewFile["上传本地文件"]
  end
    Start(["开始同步"]) --> PrepareSync["准备同步环境<br>1.创建远程基础目录<br>2.加载同步记录"]
    PrepareSync --> LoadStats["获取文件状态<br>1.遍历本地文件统计<br>2.遍历远程文件统计"]
    LoadStats --> SyncFolders
    SyncFolders -- 第一步:远程到本地 --> RemoteToLocal
    RemoteToLocal -- 本地存在 --> ValidateType
    ValidateType -- 类型不匹配 --> ErrorFolder
    RemoteToLocal -- 本地不存在但有记录 --> CheckRemoteFolderChanged
    CheckRemoteFolderChanged -- 远程已修改 --> CreateLocalDir
    CheckRemoteFolderChanged -- 远程未修改 --> CheckRemoteRemovable
    CheckRemoteRemovable -- 可以删除 --> RemoveRemoteFolder
    RemoteToLocal -- 完全无记录 --> CreateLocalFolder
    SyncFolders -- 第二步:本地到远程 --> LocalToRemote
    LocalToRemote -- 远程不存在 --> CheckLocalFolderRecord
    CheckLocalFolderRecord -- 有记录且本地变更 --> CreateRemoteFolder
    CheckLocalFolderRecord -- 有记录未变更 --> CheckLocalFolderRemovable
    CheckLocalFolderRemovable -- 可以删除 --> RemoveLocalFolder
    CheckLocalFolderRecord -- 无记录 --> CreateRemoteDirNew
    SyncFiles --> CheckSyncRecord & UpdateRecords["更新同步记录"]
    CheckSyncRecord -- 存在同步记录 --> ExistenceCheck
    ExistenceCheck -- 双端都存在 --> ChangeCheck
    ChangeCheck -- 双端都有变更 --> Conflict
    ChangeCheck -- 仅远程变更 --> Download
    ChangeCheck -- 仅本地变更 --> Upload
    ExistenceCheck -- 仅远程存在 --> RemoteOnlyCheck
    RemoteOnlyCheck -- 远程有变更 --> DownloadNew
    RemoteOnlyCheck -- 远程无变更 --> DeleteRemoteFile
    ExistenceCheck -- 仅本地存在 --> LocalOnlyCheck
    LocalOnlyCheck -- 本地有变更 --> UploadNew
    LocalOnlyCheck -- 本地无变更 --> DeleteLocalFile
    CheckSyncRecord -- 无同步记录 --> NoRecordCheck
    NoRecordCheck -- 双端都存在 --> ResolveConflict
    NoRecordCheck -- 仅远程存在 --> PullNewFile
    NoRecordCheck -- 仅本地存在 --> PushNewFile
    SyncFolders --> SyncFiles
    UpdateRecords --> End(["同步完成"])
```
