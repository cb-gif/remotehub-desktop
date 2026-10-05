# 构建与发布（P10）

## 本地构建

需要 Node.js 22.12+，建议使用 CI 一致的 Node.js 22 LTS。终端位于项目根目录：

```sh
npm ci
npm run check
npm run dist:win
npm run test:packaged
npm run release:checksums
```

`dist:win` 在 Windows 构建 x64 安装版与免安装版。macOS 使用 `npm run dist:mac`（默认本机架构），Linux x64 使用 `npm run dist:linux`。产物放在 `release/`，不会提交 Git。

`npm run pack` 仅生成当前系统的解包目录；`npm run test:packaged` 自动寻找当前系统/架构的可执行文件，也可在 `--` 后传入可执行文件绝对路径。启动测试使用独立临时用户数据，不访问个人连接或真实远程服务，结束后清理临时数据。

`npm start` 在已有构建输出的前提下直接离线打开，不再依赖 5173 端口。`npm run dev` 显式传入 `--dev` 才启用本地预览服务器。

SQLite 和串口属于原生模块，不能复制其他系统的 node_modules。electron-builder 在安装和打包时按目标 Electron ABI 重建；缺少预编译包时，本机需要 Python 与 C++ 工具链（Windows VS Build Tools / macOS Xcode Command Line Tools / Linux build-essential）。GitHub 托管 runner 已配置工具链。

beta.2 新增 node-pty：Windows/macOS 优先使用 npm 包内自带且完整的 Node-API 预编译文件与辅助程序；没有匹配预编译文件的平台会正常编译。安装与打包共用 `native-dependencies.mjs`，不禁用 Spectre 等编译安全选项。打包冒烟检查会真正运行固定 PTY 命令验证兼容性，不加载用户 Shell 配置。

node-pty 1.1.0 的 macOS 预编译辅助程序存在缺少执行位的上游打包问题（[上游 #850](https://github.com/microsoft/node-pty/issues/850)）。beta.3 在安装及 `beforePack` 中只修复包内 `spawn-helper` 的执行权限，发生在归档、签名和 DMG 创建之前；不在用户运行时更改应用权限，不跳过 PTY 启动验收。

打包器默认全量重编译由 `beforePack` 中的受控重建替代（`npmRebuild: false`），但仍正常收集生产依赖。不要改为从 `beforeBuild` 返回 false，那会跳过生产依赖收集。

## GitHub 发布

1. 更新 package.json 版本，并运行 `npm install` 同步 package-lock.json。
2. 更新 `docs/RELEASE_NOTES.md`，执行本地检查并提交到 main。
3. 创建与 package.json 完全一致的标签，例如 `v0.1.0-beta.1`，推送该标签。
4. `Release desktop` 在 Windows x64、macOS Intel、macOS Apple Silicon、Linux x64 runner 独立构建、检查启动，并上传 Actions 临时产物。
5. 所有平台成功后，发布 job 汇总安装包和 SHA-256 校验文件，创建 GitHub **预发布**。任何平台失败，都不会发布不完整 Release。

手动运行 `Release desktop`（workflow_dispatch）只构建并上传 Actions 产物，不创建 Release。普通 main 提交和 PR 运行 `Validate source`。当前预发布流水线刻意使用 `--prerelease`；稳定发布需先完成下面的验收和签名，再调整策略。

## 权限与签名

构建 job 仅有仓库读取权限；只有发布 job 拥有 `contents: write`，使用 GitHub 自动生成的 token，不需要把个人 token 写入仓库。本地配置不自动发布，所有打包命令均带 `--publish never`。

首版未配置付费签名证书。Windows 未签名，macOS 未使用 Developer ID 签名/公证（Apple Silicon 构建工具可能使用 ad-hoc 签名）；不要把它们描述为已签名稳定版。以后签名密钥只能放 GitHub Secrets，不能提交仓库。

beta.10 已升级至 Electron 44.4.5，并适配原生模块与剪贴板接口；Linux 原生依赖由 electron-rebuild 自动下载并使用 Electron 匹配的 Clang 与 sysroot，以兼容新版 V8 头文件。各平台继续执行打包后离线启动检查。没有自动更新服务，升级需手动下载。

## 发布验收清单

- [ ] Windows 10/11 干净机器安装、免安装启动、卸载/升级保留设置。
- [ ] macOS Intel / Apple Silicon 首次打开、安全提示、终端输入与凭据存储。
- [ ] Linux AppImage 在目标发行版运行（可能需要 FUSE 2）及系统密钥环验证。
- [ ] 授权测试主机的 SSH 密码/私钥、指纹确认、SFTP 文件与目录传输。
- [ ] 测试 MySQL、PostgreSQL 直连/SSH 隧道、大查询分页和连接中断。
- [ ] 实体串口枚举、收发、拔插、重连。
- [ ] SQL JSON 完整数据、复制、Workspace 多视图与重启恢复。

自动化检查不能替代这些真实连接和硬件验收。没有测试设备或凭据时，保持预发布并如实记录未验收项。
