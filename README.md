<h1 align="center">Nutstore Sync</h1>

<p align="center">
  <a href="#zh">中文</a> ·
  <a href="#en">English</a>
</p>

<p align="center">
  <strong>在 Obsidian 中连接坚果云：可控的增量同步，以及能理解上下文的 AI 助手。</strong><br>
  <em>Controlled incremental sync for Obsidian and Nutstore, with an extensible AI assistant built into your workspace.</em>
</p>

<p align="center">
  <a href="https://github.com/nutstore/obsidian-nutstore-sync/releases">
    <img src="https://img.shields.io/github/v/release/nutstore/obsidian-nutstore-sync?display_name=tag&sort=semver&style=flat-square" alt="Latest release">
  </a>
  <a href="https://community.obsidian.md/plugins/nutstore-sync">
    <img src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=Downloads&query=%24%5B%22nutstore-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=flat-square" alt="Obsidian downloads">
  </a>
</p>

---

<a id="zh"></a>

Nutstore Sync 是面向坚果云用户的 Obsidian 同步插件，支持桌面端与移动端。你可以按自己的工作方式选择双向、单向或镜像同步，还可以使用内置 AI 助手调用工具、复用 Skills、连接 MCP 服务，以及按需启用专用子 Agent。

### ✨ 为什么使用 Nutstore Sync

- **同步方向由你决定**：五种同步策略覆盖多设备同步、单向备份和镜像场景。
- **重要操作看得见**：可在同步前审阅待执行操作，并为自动删除单独保留确认步骤。
- **大型 Vault 也能灵活配置**：支持增量同步、宽松或严格扫描、路径过滤和大文件跳过。
- **可扩展的 AI 助手**：在 Obsidian 中使用内置工具、Skills、MCP 和可配置子 Agent，并在重要修改前保留确认。

### 🚀 快速开始

1. 从 Obsidian 社区插件中安装并启用 **Nutstore Sync**。
2. 打开插件设置，使用坚果云授权登录；也可以选择手动模式，填写 WebDAV 应用密码。
3. 选择坚果云中的远程目录和同步策略，然后检查 WebDAV 连接。
4. 点击功能区的同步图标，或从命令面板运行 **Start sync**。
5. 首次同步前查看操作预览，确认无误后开始同步。

> [!IMPORTANT]
> 首次同步前请备份 Vault。带有“覆盖”或“还原”含义的镜像策略可能删除另一端独有的文件。

### 🔄 按你的方式同步

| 同步策略               | 行为                                             | 适合场景                   |
| ---------------------- | ------------------------------------------------ | -------------------------- |
| **双向同步**           | 在本地与坚果云之间同步新增、修改和删除           | 多设备日常使用             |
| **仅发送**             | 上传本地新增和修改，保留坚果云独有或已变化的内容 | 本地为主，云端保留独立内容 |
| **仅发送（覆盖云端）** | 让坚果云内容与本地保持一致                       | 将本地作为完整主副本       |
| **仅接收**             | 下载坚果云新增和修改，保留本地独有或已变化的内容 | 云端为主，本地保留独立内容 |
| **仅接收（还原本地）** | 让本地内容与坚果云保持一致                       | 将坚果云作为完整主副本     |

你还可以进一步控制同步行为：

- **增量同步**：建立同步记录后，只处理发生变化的内容；首次扫描可能需要更长时间。
- **宽松与严格模式**：宽松模式优先大型 Vault 的扫描速度；严格模式更适合首次接入已有远程目录或优先准确性的场景。
- **自动同步**：按需启用实时同步、启动后同步或定时同步。
- **过滤规则**：使用 Gitignore-style 路径规则排除或强制包含文件，最后一条匹配规则生效。
- **Obsidian 配置目录**：可以不同步、只同步书签，或同步大部分配置文件。
- **大文件控制**：设置大小上限，让超出限制的文件保持不同步。
- **可见的同步过程**：查看进度、状态和日志，并可在进行中停止同步。
- **远程目录选择**：通过可视化目录选择器定位同步位置，也可以新建文件夹。

### 🧩 冲突处理由你选择

双向同步时，如果本地和坚果云都修改了同一文件，可以选择：

- **无冲突合并**：尝试生成不带冲突标记的合并文本。
- **Diff3 合并**：保留冲突标记，方便你逐段检查。
- **本地优先**：用本地版本替换坚果云版本。
- **坚果云优先**：用坚果云版本替换本地版本。

自动合并仅适用于插件能够识别的文本格式。二进制文件、文件与文件夹同名等情况需要选择优先版本或手动处理。合并完成后仍建议检查结果。

### 🤖 AI 助手

AI Agent ChatBox 是驻留在 Obsidian 中的可扩展助手。Vault 是它的重要上下文和工作空间，但不是能力边界：配置模型后，它可以调用内置工具、遵循可复用 Skills、连接你授权的 MCP 服务，并按需委派 Explorer 或 Memory 子 Agent。

你可以这样使用它：

> 整理这个文件夹中的会议记录，提取待办事项，并在修改前让我确认。

> 根据当前选中的内容更新这篇笔记，先展示准备进行的修改。

> 记住我偏好的周报结构，以后整理周报时沿用，并把这套流程做成一个可复用 Skill。

> 使用已连接的 MCP 服务获取所需信息，再结合当前项目笔记生成摘要。

Agent 支持：

- **丰富上下文**：使用当前文件、选中文本、文件夹、附件或图片理解你的任务。
- **内置工具**：搜索和管理文件、处理常见压缩包、查看图片，并在沙盒中预览 HTML 内容。
- **多步骤任务**：拆解复杂任务，并按需使用只读探索任务梳理信息。
- **Skills**：调用内置或用户创建的 Skills，复用工作流程、领域知识和操作约定。
- **MCP**：连接你配置的 MCP 服务，将外部工具和信息源带入对话。
- **子 Agent**：按需启用只读探索，或跨会话检索和维护偏好、约定和决策。
- **持续会话**：保存聊天记录并压缩较长上下文；会话文件可以随现有同步在设备间流转。
- **多种模型**：使用 OpenAI、Anthropic、Google、xAI 等服务商格式与预设，或配置自定义兼容端点。

#### 配置 AI

1. 打开 Nutstore Sync 设置中的 **AI** 标签页。
2. 添加服务商、API Key 和模型，或在账号可用时授权实验性的 Nutstore AI。
3. 选择默认模型。
4. 点击功能区的机器人图标，或从命令面板运行 **Open chatbox**。
5. 按需配置 Explorer 或 Memory 子 Agent、添加 MCP 服务或管理 Skills。

模型能力取决于你选择的服务商和具体模型。Nutstore AI 仍是实验性功能，并非所有账号都可用。

#### 操作权限

Agent 默认会在修改文件或插件设置前请求确认。你可以仅允许一次，也可以在当前会话中自动允许同类操作。设置中的 **完全访问权限（YOLO 模式）** 会跳过逐项确认，请只在你理解任务影响时开启。

Agent 可修改的插件设置采用白名单，不包含坚果云登录凭据或 AI API Key。

### ⚠️ 使用前须知

- 首次同步需要扫描两端内容，文件较多时会花费更长时间。
- “仅发送（覆盖云端）”可能删除云端独有文件；“仅接收（还原本地）”可能删除本地独有文件。
- 被过滤或超过大小限制的文件不会同步，因此两端可能有意保持不同。
- 如果两端已经存在大量同名文件，建议先备份并使用严格模式完成首次同步。
- 本插件不是 Obsidian 官方同步服务。遇到问题时可以查看同步日志并通过 [GitHub Issues](https://github.com/nutstore/obsidian-nutstore-sync/issues) 反馈。

---

<a id="en"></a>

Nutstore Sync is an Obsidian plugin for syncing a vault with Nutstore on desktop and mobile. Choose two-way, one-way, or mirror-style synchronization, and optionally work with a built-in AI assistant that can use tools, reusable Skills, MCP connections, and configured subagents.

### ✨ Why Nutstore Sync

- **You control the direction**: Five sync policies cover everyday multi-device use, one-way backup, and mirror workflows.
- **Important operations stay visible**: Review planned operations before syncing and keep a separate confirmation step for automatic deletions.
- **Flexible for large vaults**: Use incremental sync, loose or strict scanning, path filters, and large-file limits.
- **An extensible AI assistant**: Use built-in tools, Skills, MCP, and configurable subagents inside Obsidian while keeping approval in the loop for important changes.

### 🚀 Quick Start

1. Install and enable **Nutstore Sync** from Obsidian Community Plugins.
2. Open the plugin settings and sign in through Nutstore authorization, or enter a WebDAV app password in manual mode.
3. Choose a remote Nutstore directory and a sync policy, then check the WebDAV connection.
4. Click the sync ribbon icon, or run **Start sync** from the command palette.
5. Review the planned operations before starting your first sync.

> [!IMPORTANT]
> Back up your vault before the first sync. Mirror policies that override or revert changes may delete files that exist on only one side.

### 🔄 Sync Your Way

| Policy                          | Behavior                                                                         | Best for                                       |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Two-way sync**                | Syncs creations, changes, and deletions between local and Nutstore               | Everyday use across devices                    |
| **Send only**                   | Uploads local creations and changes while preserving independent cloud content   | Local-first workflows                          |
| **Send only (override cloud)**  | Makes Nutstore match the local vault                                             | Using local as the complete source of truth    |
| **Receive only**                | Downloads cloud creations and changes while preserving independent local content | Cloud-first workflows                          |
| **Receive only (revert local)** | Makes the local vault match Nutstore                                             | Using Nutstore as the complete source of truth |

Additional controls include:

- **Incremental sync** after sync history has been established; the first scan may take longer.
- **Loose and strict modes** to prioritize scanning speed or accuracy when matching existing paths.
- **Automatic sync** through real-time events, startup delay, or a recurring interval.
- **Gitignore-style filters** with ordered include and exclude rules.
- **Obsidian configuration sync** for no config files, bookmarks only, or most configuration files.
- **Large-file limits** that leave files above your chosen size unsynced.
- **Visible progress, status, logs, and cancellation** while a sync is running.
- **A visual remote-directory picker** with folder creation.

### 🧩 Choose How Conflicts Are Handled

When both sides modify the same file during two-way sync, choose from:

- **Conflict-free merge** to attempt a merged text file without conflict markers.
- **Diff3 merge** to preserve conflict markers for review.
- **Local priority** to replace the Nutstore copy with the local version.
- **Nutstore priority** to replace the local copy with the Nutstore version.

Automatic merging only supports recognized text formats. Binary files and file-versus-folder conflicts require a priority choice or manual handling. Review merged files after synchronization.

### 🤖 AI Assistant

AI Agent ChatBox is an extensible assistant that lives inside Obsidian. Your vault is an important source of context and a working space, but it is not the limit of what the assistant can do. After configuring a model, the Agent can use built-in tools, follow reusable Skills, connect to MCP servers you authorize, and delegate to configured Explorer or Memory subagents.

For example:

> Organize the meeting notes in this folder, extract the action items, and ask before changing any files.

> Update this note using the selected text and show me the planned changes first.

> Remember my preferred weekly review structure, reuse it next time, and turn the workflow into a Skill.

> Use a connected MCP server to gather the required information, then combine it with the current project notes into a summary.

The Agent supports:

- **Rich context**: Use the active file, selected text, folders, attachments, or images to understand a task.
- **Built-in tools**: Search and manage files, work with common archives, inspect images, and preview HTML content in a sandbox.
- **Multi-step tasks**: Break down complex work and delegate read-only exploration when useful.
- **Skills**: Use built-in or user-created Skills to reuse workflows, domain knowledge, and operating conventions.
- **MCP**: Connect configured MCP servers to bring external tools and information sources into a conversation.
- **Subagents**: Optionally enable read-only exploration or cross-session memory retrieval and maintenance.
- **Persistent sessions**: Save conversations and compress long contexts; session files can travel through the existing sync flow.
- **Multiple model providers**: Use OpenAI, Anthropic, Google, xAI, or custom compatible endpoints.

#### Configure AI

1. Open the **AI** tab in Nutstore Sync settings.
2. Add a provider, API key, and model, or authorize the experimental Nutstore AI service if it is available for your account.
3. Select a default model.
4. Click the robot ribbon icon, or run **Open chatbox** from the command palette.
5. Optionally configure Explorer or Memory subagents, add MCP servers, or manage Skills.

Capabilities vary by provider and model. Nutstore AI is experimental and is not available to every account.

#### Permissions

By default, the Agent asks for approval before changing files or plugin settings. You can allow an operation once or automatically allow the same type of operation for the current session. **Full Access (YOLO mode)** skips per-operation approval and should only be enabled when you understand the task's impact.

Plugin settings available to the Agent are allowlisted and do not include Nutstore credentials or AI API keys.

### ⚠️ Before You Sync

- The first sync scans both sides and may take longer for large vaults.
- **Send only (override cloud)** may delete cloud-only files; **Receive only (revert local)** may delete local-only files.
- Filtered files and files above the size limit remain unsynced, so the two sides may intentionally differ.
- If both sides already contain many files with matching paths, back up first and use strict mode for the initial sync.
- This plugin is not the official Obsidian Sync service. Check the sync logs and report problems through [GitHub Issues](https://github.com/nutstore/obsidian-nutstore-sync/issues).
