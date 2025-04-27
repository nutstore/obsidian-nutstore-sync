# Changelog

本项目的所有重要更改都将记录在此文件中。All notable changes to this project will be documented in this file.

## [0.4.1] - 2025-04-27

* 修复了首次同步时本地数据会覆盖远程数据的问题，现在会进行合并。
* Fixed an issue where local data would overwrite remote data during the initial synchronization. Now, the data will be merged.


## [0.4.0] - 2025-04-25

* 可以配置跳过大文件，避免 OOM；同步进度窗口可以取消同步和隐藏窗口；可选择性清除缓存。
* 串行保存 blob 数据，日志持久化。
* Configure skip large files to avoid OOM; The sync progress window can cancel sync and hide the window; Selectable cache clearing modal.
* Serialize blob saving; Logs are now persistent.


## [0.3.2] - 2025-04-23

* 恢复同步记录后显示同步完成提示。
* 完善了同步记录功能，自动补充缺失文件夹的同步记录。
* 新增内存文件系统。
* 新增同步完成标记功能。
* 新增同步进度弹窗。
* 新增同步和终止命令。
* 优化了同步机制，包括可中断的 503 重试机制和睡眠函数，修复了大量任务并发读取文件时闪退的问题。
* Synchronization complete message is now displayed after synchronization records are restored.
* Enhanced synchronization record functionality by automatically adding missing folder records.
* Implemented an in-memory file system (memfs).
* Added a synchronization completion marker.
* Added a synchronization progress popup.
* Added commands for starting and stopping synchronization.
* Improved synchronization mechanism with interruptible 503 retry and sleep functions, fixing the crash issue when concurrently reading files with a large number of tasks.


## [0.3.1] - 2025-04-21

* 修复：
    * 仅导出当前 vault 的缓存
    * 修复 delta 响应中的类型解析错误
* 功能：
    * 使用标准远程路径处理选择的远程路径，确保路径一致性
    * 添加空操作任务以优化任务执行流程
    * 添加松散同步模式，跳过同名且大小相同的文件
* Bug fixes:
    * Only export the cache of the current vault.
    * Fixed a type parsing error in delta responses.
* Features:
    * Use standardized remote paths to ensure path consistency.
    * Added a no-op task to optimize task execution flow.
    * Added a loose synchronization mode to skip files with the same name and size.


## [0.3.0] - 2025-04-18

* **功能改进:**
    * 实现了 Indexed DB 缓存数据的导入导出功能，并支持保存到坚果云盘。
    * 使用图标代替了选择文件夹的文本。
    * 添加了日志界面。
* **问题修复:**
    * 修复了 stringify 导致的错误。
* **其他改进:**
    * 为生产模式添加了日志记录功能。
    * 将设置模块重构为类。
* **Features:**
    * Implemented import and export of Indexed DB cache data, with support for saving to Nutstore Cloud.
    * Replaced folder selection text with an icon.
    * Added a log interface.
* **Bug Fixes:**
    * Fixed an error caused by stringify.
* **Other Improvements:**
    * Added logging functionality for production mode.
    * Refactored the settings module as a class.


## [0.2.3] - 2025-04-14

* 修复相对路径处理逻辑
* 为过滤器添加 flag

* fix relative path bug
* allow config flag for filter


## [0.2.2] - 2025-04-10

*   修复了部分旧环境下的兼容性问题 (通过 polyfill 数组方法)。
*   修复了导致移动端无法同步的问题。

*   Fixed compatibility issues in some older environments (by polyfilling array methods).
*   Fixed an issue preventing synchronization on mobile devices.


## [0.2.1] - 2025-04-10

*   修正了相对路径的处理。

*   Corrected handling of relative paths. 

## [0.2.0] - 2025-04-09

*   简化了登录流程。
*   增加了自定义过滤功能。
*   支持自定义请求 URL。
*   增加了当同步任务过多时建议使用客户端的提示信息。
*   修复了 iOS 设备上无法通过浏览器进行 SSO 登录的问题。
*   修复了数值可能以科学记数法 (eNotation) 显示的问题。
*   更新了冲突解决策略的描述，增加了备份建议。
*   调整了差异匹配阈值。
*   对路径进行了编码以改善处理。

*   Simplified the login process.
*   Added custom filtering capabilities.
*   Added support for custom request URLs.
*   Added a prompt suggesting client use for numerous sync tasks.
*   Fixed an issue preventing SSO login via browser on iOS devices.
*   Fixed an issue where numbers might display in scientific notation (eNotation).
*   Updated conflict resolution strategy descriptions to include a backup recommendation.
*   Adjusted the match threshold for diffs.
*   Encoded paths for improved handling.

## [0.1.0] - 2025-04-03

*   为冲突解决策略描述添加了备份建议。
*   改进了手动登录帮助链接的结构。
*   禁用了数字显示的科学计数法 (eNotation)。
*   更新了单点登录 (SSO) 组件 (使用 `@nutstore/sso-js`)。

*   Added backup recommendation to conflict resolution strategy descriptions.
*   Improved the structure of the manual login help link.
*   Disabled scientific notation (eNotation) for number display.
*   Updated the Single Sign-On (SSO) component (using `@nutstore/sso-js`).

## [0.0.7] - 2025-03-28

*   新增：执行同步任务前增加确认步骤，通过包含说明文字的新弹窗进行确认。
*   新增：添加 `confirmBeforeSync` 设置项，用于控制是否在同步前进行确认。
*   改进：文件列表（FileList）现在可以同时显示文件和文件夹。
*   改进：为远程目录创建过程中遇到的错误添加了通知提示。
*   优化：优化了同步流程（包括远程目录存在性检查和记录清理）。

*   Added a confirmation step before executing sync tasks, shown in a new modal with instructions.
*   Added a `confirmBeforeSync` setting to control the sync confirmation behavior.
*   Updated FileList to display both files and folders.
*   Added notifications for errors during remote directory creation.
*   Optimized the synchronization process (includes remote directory checks and record cleanup).

## [0.0.6] - 2025-03-25

*   提高了获取目录内容时的可靠性，增加了 API 速率限制和针对临时服务器错误 (503) 的自动重试机制。
*   Improved reliability when fetching directory contents by adding API rate limiting and automatic retries for temporary server errors (503).

## [0.0.5] - 2025-03-21

*   修复：创建新文件夹后自动刷新列表。
*   功能：更新了坚果云单点登录（SSO）支持。

*   Fix: Refresh list automatically after creating a new folder.
*   Feature: Updated Nutstore Single Sign-On (SSO) support.

## [0.0.4] - 2025-03-13

*   更新了单点登录 (SSO) 功能。
*   Updated Single Sign-On (SSO) functionality.

## [0.0.3] - 2025-03-13

*   **同步核心与进度**
    *   新增 同步状态管理、进度百分比显示、完成状态（含失败计数）和同步按钮视觉反馈。
    *   新增 同步取消/停止功能。
    *   新增 SSO（单点登录）用户界面。
    *   新增 同步确认对话框及风险提示。
    *   新增 在本地创建文件夹时，在远端也创建对应文件夹。
    *   新增 同步任务失败时的本地化错误信息。
    *   新增 对二进制文件进行哈希比较。
    *   新增 针对 503 错误的重试机制。
    *   优化 远程基础目录 (`remoteBaseDir`) 回退使用仓库名称。
    *   优化 调整了 API 请求频率限制以提高稳定性。
    *   修复 同步动画旋转方向错误。
    *   修复 从正确的 `remoteBaseDir` 开始遍历文件。
    *   修复 获取目录内容以正确处理服务器基础路径。
*   **冲突处理**
    *   新增 冲突处理策略可选。
    *   新增 冲突标记（支持 Git 风格及自定义），并保留原始内容格式。
    *   新增 跳过空文件冲突。
    *   优化 冲突解决支持可选的本地和远程文件状态信息。
*   **文件处理**
    *   新增 文件属性中包含文件大小。
    *   新增 获取目录内容支持分页。
    *   修复 处理文件系统中的空文件状态。
*   **其他**
    *   新增 插件图标。
    *   新增 中英文文档及同步流程图。
    *   修复 文本自动换行问题。
    *   更新 插件名称。

*   **Sync Core & Progress**
    *   Added sync state management, progress percentage display, completion status (with failed count), and visual feedback for the sync button.
    *   Added sync cancellation/stop functionality.
    *   Added SSO (Single Sign-On) user interface.
    *   Added sync confirmation dialog and risk warning.
    *   Added remote folder creation when a local folder is created.
    *   Added localized error messages for sync task failures.
    *   Added hash comparison for binary files.
    *   Added retry mechanism for 503 errors.
    *   Improved `remoteBaseDir` to use the vault name as a fallback.
    *   Adjusted API rate limiting parameters for better stability.
    *   Fixed sync animation rotation direction.
    *   Fixed walking from the correct `remoteBaseDir`.
    *   Fixed `getDirectoryContents` to handle server base paths correctly.
*   **Conflict Handling**
    *   Added selectable conflict resolution strategies.
    *   Added conflict markers (supporting Git style and customization), preserving original content formatting.
    *   Added skipping of blank file conflicts.
    *   Improved conflict resolution to support optional local and remote file stats.
*   **File Handling**
    *   Added file size to file properties.
    *   Added pagination support for getting directory contents.
    *   Fixed handling of empty file stats in the file system.
*   **Other**
    *   Added plugin icons.
    *   Added English and Chinese documentation, including a sync flowchart.
    *   Fixed automatic word wrapping issues.
    *   Updated plugin name.

## [0.0.2] - 2025-03-07

*   **WebDAV:**
    *   新增 WebDAV 文件浏览器功能。
    *   为 WebDAV 配置添加远程基础目录选择器。
    *   支持通过环境变量配置 WebDAV。
    *   提升 WebDAV 可靠性与性能（改进令牌处理、避免重复创建目录、修复 `nextLink` 解码问题）。
*   **用户界面与体验:**
    *   移除同步模态框（SyncModal）组件。
    *   改进移动端适配。
    *   更新坚果云（Nutstore）设置界面。
    *   统一界面文本的大小写。
*   **其他:**
    *   为中文用户添加了帮助说明。
    *   修复了访问 `configDir` 中配置值的问题。

*   **WebDAV:**
    *   Added a WebDAV file explorer feature.
    *   Added a remote base directory selector for WebDAV configuration.
    *   Enabled WebDAV configuration via environment variables.
    *   Enhanced WebDAV reliability and performance (improved token handling, avoided duplicate mkdir, fixed `nextLink` decoding).
*   **User Interface & Experience:**
    *   Removed the SyncModal component.
    *   Improved mobile adaptability.
    *   Updated the Nutstore Setting Tab UI.
    *   Standardized capitalization in UI text.
*   **Other:**
    *   Added Chinese help documentation (`help` for zh).
    *   Fixed accessing configured value from `configDir`.

## [0.0.1] - 2025-02-26

*   新增 WebDAV 及本地文件同步功能，包括文件和文件夹的遍历、创建、删除（支持递归删除）以及基础的冲突解决机制。
*   改进同步冲突处理：增加解决策略，支持跳过空文件冲突，并在解决后更新记录。
*   增强同步用户体验：
    *   增加同步状态管理、进度百分比显示、加载动画（修复了旋转方向）及完成后的失败任务计数。
    *   增加同步过程中的通知提示和本地化错误信息。
    *   添加取消/停止同步按钮。
    *   优化了同步状态的 UI 显示并添加了图标。
*   引入国际化 (i18n) 支持和语言切换功能。
*   添加 SSO (单点登录) 相关界面（后已隐藏）。
*   优化同步设置：远程目录将回退使用仓库名称。
*   修复了同步中处理服务器基本路径、空文件统计信息等问题。

*   Added basic file synchronization for WebDAV and local vaults, including traversal, creation, deletion (with recursive support), and basic conflict resolution.
*   Improved sync conflict handling: added resolution strategies, support for skipping blank file conflicts, and record updates after resolution.
*   Enhanced sync user experience:
    *   Added sync state management, progress percentage display, loading animation (fixed rotation direction), and failed task count on completion.
    *   Added notifications during sync and localized error messages.
    *   Added a cancel/stop sync button.
    *   Improved the sync status UI and added icons.
*   Introduced internationalization (i18n) support and language switching functionality.
*   Added SSO (Single Sign-On) related UI (later hidden).
*   Improved sync setup: Remote base directory now falls back to using the vault name.
*   Fixed issues related to handling server base paths, empty file stats, etc., during synchronization.

