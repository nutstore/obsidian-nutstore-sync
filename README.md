# 🔄 Nutstore Sync

## 简介 | Introduction

此插件允许您通过 WebDAV 协议将 Obsidian 笔记与坚果云进行双向同步。
_This plugin enables two-way synchronization between Obsidian notes and Nutstore via WebDAV protocol._

---

## ✨ 主要特性 | Key Features

- 🔄 **双向同步 | Two-way Sync**
  高效地在多设备间同步笔记。
  _Efficiently synchronize your notes across devices._
- ⚡ **增量同步 | Incremental Sync**
  只传输更改过的文件，使大型笔记库也能快速同步。
  _Fast updates that only transfer changed files, making large vaults sync quickly._
- 🔐 **单点登录 | Single Sign-On**
  通过简单授权连接坚果云，无需手动输入 WebDAV 凭据。
  _Connect to Nutstore with simple authorization instead of manually entering WebDAV credentials._
- 📁 **WebDAV 文件浏览器 | WebDAV Explorer**
  远程文件管理的可视化界面。
  _Visual file browser for remote file management._
- 🔀 **智能冲突解决 | Smart Conflict Resolution**
  字符级比较自动合并可能的更改；支持基于时间戳的解决方案（最新文件优先）。
  _Character-level comparison to automatically merge changes when possible. Option to use timestamp-based resolution (newest file wins)._
- 🚀 **宽松同步模式 | Loose Sync Mode**
  优化对包含数千笔记的仓库的性能。
  _Optimize performance for vaults with thousands of notes._
- 📦 **大文件处理 | Large File Handling**
  设置大小限制以跳过大文件，提升性能。
  _Set size limits to skip large files for better performance._
- 📊 **同步状态跟踪 | Sync Status Tracking**
  清晰的同步进度和完成提示。
  _Clear visual indicators of sync progress and completion._
- 📝 **详细日志 | Detailed Logging**
  全面的故障排查日志。
  _Comprehensive logs for troubleshooting._
- 🤖 **AI 智能助手 | AI Agent**
  内置 AI 助手，可通过自然语言读取、编辑和管理 Vault 中的文件。
  _Built-in AI assistant that can read, edit, and manage files in your vault through natural language._

---

## 🤖 AI 智能助手 | AI Agent

AI 助手是一个内置的智能代理，让你通过自然语言管理 Obsidian Vault。支持任意兼容 OpenAI 接口的服务商，可自主完成复杂的多步骤任务。
_The AI Agent is a built-in assistant that lets you manage your Obsidian vault through natural language. It supports any OpenAI-compatible provider and can handle complex, multi-step tasks autonomously._

Agent 在做出任何更改前都会请求用户确认。你可以逐条批准、按操作类型批准当前会话，或在设置中开启 _YOLO 模式_ 全部自动通过。
_Before the agent makes any changes, it asks for your approval. You can approve individual operations, approve an operation type for the entire session, or enable *YOLO mode* in settings to auto-approve everything._

**配置方法 | Setup：**

1. 打开插件设置 → **AI** 标签页
   _Open plugin settings → **AI** tab_
2. 添加 AI 服务商（支持任意兼容 OpenAI 接口的端点）并填写模型名称
   _Add an AI provider (any OpenAI-compatible endpoint) and fill in the model name_
3. 从左侧边栏打开 AI 对话框，开始对话
   _Open the AI chat panel from the left sidebar and start chatting_

### ⚡ 备忘录自动触发 | Memo Auto-Trigger

当 vault 中新增笔记达到设定阈值时，插件会自动让 AI Agent 处理它们——例如触发一次「总结备忘录」流程，将笔记整理成任务。

_When enough new notes are created in the vault, the plugin automatically asks the AI Agent to process them — e.g. triggering a "summarize memos" flow that turns notes into tasks._

- 在设置 → **AI** 标签页启用，可配置阈值（默认 10）与触发消息
  _Enable it in Settings → **AI** tab; configure the threshold (default 10) and the trigger message_
- 只有 `.obsidian/`、`.agents/` 目录之外的 `.md` 文件会计数（`欢迎.md` 不计入）
  _Only `.md` files outside `.obsidian/` and `.agents/` are counted (`欢迎.md` is ignored)_
- 触发消息与某个 Skill 的描述匹配时，Agent 会自动加载该 Skill 执行
  _If the trigger message matches a Skill description, the Agent loads that Skill automatically_
- 注意：自动触发仍需遵循常规权限模式——Agent 执行写入操作前会请求确认（除非已开启 YOLO 模式）；自动触发仅在 Obsidian 运行且 AI 服务商已配置时生效
  _Note: the auto-trigger still respects the regular permission mode — the Agent asks for approval before write actions (unless YOLO mode is enabled); it only fires while Obsidian is running with an AI provider configured_

---

## ⚠️ 注意事项 | Important Notes

- ⏳ **首次同步 | Initial Sync**
  首次同步可能需要较长时间（文件比较多时）。
  _Initial sync may take longer (especially with many files)._
- 💾 **数据备份 | Backup**
  请在同步之前备份。
  _Please backup before syncing._
