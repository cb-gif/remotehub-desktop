# RemoteHub Desktop 0.1.0-beta.8

本次预发布汇总 beta.5 之后的终端、连接、文件传输和主题改进。

## 本次更新

- 新增 Tokyo Night、Storm 和 Light 三套主题；Night 与 Storm 共用强调色和终端 ANSI 配色，Light 使用日间配色。
- SSH 终端新增服务器负载信息展示；串口终端跟随日间／夜间主题切换。
- SSH 无保存密码连接改为连接时询问密码，SSH 与 SFTP 共用短时验证结果；修复仅打开 SFTP 和会话关闭后的验证问题。
- SFTP 工具栏在窄视图下收纳到“…”菜单，修复菜单遮挡，并将单次拖入文件数量上限提高到 10,000。
- 改进连接会话生命周期和数据库刷新处理。

## 选择下载文件

- Windows 10/11 x64：`win-x64-setup.exe` 为安装版，`win-x64-portable.exe` 为免安装版。
- macOS Intel：`mac-x64.dmg`；Apple Silicon：`mac-arm64.dmg`。
- Linux x64：`linux-x64.AppImage`。
- 安装包自带运行时，无需另装 Node.js、npm 或 pnpm。

## 预发布说明

- 发布流水线在各平台通过代码检查、单元测试、生产构建及打包后离线启动检查后，才会创建 GitHub 预发布版。
- 离线检查覆盖 Renderer、preload IPC、临时 SQLite、串口原生模块、本地 PTY 和应用图标；真实 SSH/SFTP/FTP、MySQL/PostgreSQL、在线监控与串口设备仍需目标环境验收。
- 当前 Windows 和 macOS 包尚未使用付费发布证书或 Apple Developer ID 公证，系统可能提示发布者未知或阻止首次打开。
- 请使用 `SHA256SUMS.txt` 核对文件完整性；校验值不等同于代码签名。
- 暂无自动更新，升级需手动下载安装；卸载默认保留用户配置。
