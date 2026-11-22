# TermMoor

TermMoor 是面向 VSCodium/VS Code 的 Windows x64 侧边栏终端，只负责一件事：
在你自己的编辑器和你自己运行的 CLI 之间传递代码引用；它不管理 Agent、会话、
提示词或工作区。

English: [README.md](README.md)

> Windows x64 安装包通过 [GitHub Releases](https://github.com/wuwuzhazha/termmoor/releases) 分发，暂未上架 Open VSX。

## 能力

每个标签页就是一个本地伪终端，运行宿主机 shell（Windows 上为 `powershell.exe`）。
`pi`、`claude`、`gdb`、`pytest` 都由你自己敲；TermMoor 只改善代码引用的两个方向：

- **编辑器 → CLI**：`Ctrl+Alt+Enter`（或编辑器右键菜单）把代码引用、选中代码或
  文件路径插入 CLI 输入行，不会替你回车。
- **CLI → 编辑器**：CLI 输出中的文件引用可直接点击，打开对应源码。

扩展不提供 Agent 运行时、不保存会话，也没有其他编辑器侧命令。

## 平台与限制

| 项 | 取值 |
| --- | --- |
| 打包目标 | **仅 `win32-x64`** |
| 宿主 | VSCodium 或 VS Code `^1.106.0` |
| Shell | 本地 PTY 中的宿主机 shell（Windows 为 `powershell.exe`） |
| 运行时 | 仅本地 PTY；无远程、守护进程、attach/detach |
| 会话恢复 | 无：不保存标签列表、顺序或工作目录 |

- **当前仅 Windows x64。** 打包的 PTY 运行时只含 `win32-x64` 预编译产物，请勿
  在 Linux、macOS、Windows arm64 上安装该 VSIX；打包脚本只接受 `win32-x64`，
  无法正确标注的目标会被拒绝。
- **仅本地终端。** 不转发远程、WSL、SSH、容器 shell，也不接管编辑器内置终端。
- **无持久化。** 重载窗口或重启扩展宿主后不保留标签；再次打开只启动一个新的
  shell，工作目录为工作区根目录。会话历史、提示词与 resume 归 CLI 所有。
- **关闭标签即结束其 shell**，正在运行工作时会先确认。
- **拒绝不受信任的工作区**（`untrustedWorkspaces.supported: false`）。
- **每个工作区最多 12 个标签**；标签名由前台进程自动决定。

## 快速开始

```powershell
npm ci
npm run package     # 生成 .\termmoor-0.9.0-win32-x64.vsix
codium --install-extension .\termmoor-0.9.0-win32-x64.vsix
# 或：code --install-extension .\termmoor-0.9.0-win32-x64.vsix
```

提示重载窗口后，在辅助侧边栏中打开 **TermMoor**。

1. **把代码送进 CLI。** 光标位于文件中（有无选区均可）时按 `Ctrl+Alt+Enter`，或
   右键选择 **将代码上下文填入 TermMoor**：有选区时插入选中代码与出处（如
   `src/net/socket.c:42-58`），无选区时插入文件引用。
2. **从 CLI 打开代码。** 点击终端输出中的引用：`path:line:col`、
   `path:start-end`、`#Lx-Ly`、MSVC/Clang `file.c(42,8)`、
   Python `File "x.py", line 84`、Windows 与 UNC 路径、OSC 8 `file://` 链接，
   以及按工作区解析的裸文件名。

面板内：`Ctrl+F` / `Ctrl+Shift+F` 搜索，`Ctrl+Up` / `Ctrl+Down` 在提示符间跳转，
`Ctrl+1`…`Ctrl+9` 切换标签，`+` 新建、`×` 关闭。打开工作区外路径会先确认；
外链仅允许 `http:`、`https:`、`mailto:`。

## 设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `agentTerminal.terminal.scrollback` | `5000` | 面板终端保留的回滚行数。 |
| `agentTerminal.terminal.shellIntegration` | `true` | OSC 133/633 钩子：提示符边界、当前目录、提示符跳转与完成通知。 |
| `agentTerminal.terminal.longRunningThresholdSeconds` | `10` | 未聚焦命令运行超过该秒数并完成时通知；`0` 关闭。 |

以上是 TermMoor 提供的全部设置。

## 包标识与迁移

| | 标识 |
| --- | --- |
| 本仓库的公开发布包 | `wuwuzhazha.termmoor`，版本 `0.9.0` |
| VSIX 文件名 | `termmoor-<version>-win32-x64.vsix` |
| 早期本地构建 | `local.agent-terminal` |

早期本地构建使用开发标识 `local.agent-terminal`。扩展 ID 就是宿主识别的身份，
因此迁移是“切换”，不是“升级”：

- `wuwuzhazha.termmoor` **不会**升级 `local.agent-terminal`，宿主视为两个独立
  扩展，安装新标识不会移除旧标识。
- 设置键仍为 `agentTerminal.*`，因此设置值原样保留。
- 不要同时启用两者：它们注册同一个视图、命令与快捷键，面板与快捷键会产生歧义。
- 卸载或替换旧扩展会**停止其中正在运行的终端**。不要在正在使用的窗口里迁移：
  先完成或保存当前工作，再在该窗口/配置文件中安装新标识，最后卸载或禁用旧标识。

## 安全

- 打开工作区外路径需二次确认；外链限制为 `http:`、`https:`、`mailto:`。
- 拒绝不受信任的工作区。
- 临时上下文文件位于每个进程独立的 `mkdtemp` 目录（平台支持时为 `0700`/`0600`），
  启动时清理超过 24 小时的残留，dispose 时删除；shell 集成辅助文件写在该目录的
  `integration/` 下，不写入工作区。

请私下报告安全问题，见 [SECURITY.md](SECURITY.md)。不要在公开 issue 中披露利用
细节，也不要提交凭据、令牌或完整终端日志。

## 开发

需要 Node.js 22+ 与 npm（锁文件为 v3），并在本目录执行命令。

```powershell
npm ci
npm run build
npm test
npm run package
npm run verify:vsix   # 校验最新的 win32-x64 VSIX
# 或指定文件：
node scripts/verify-vsix.mjs .\termmoor-0.9.0-win32-x64.vsix
```

这四步就是门禁；打包时还会校验暂存清单中的公开发布标识。CI
（`.github/workflows/ci.yml`）在 `windows-latest` + Node 22 上执行同样步骤，只上传
VSIX 构建产物，不发布、不发布 Release、不安装。

面板交互（标签条、面板内搜索、编辑器→CLI 插入）目前没有 GUI 测试，只能手工验证；
单元测试覆盖上下文格式化、shell 转义、与快捷键无关的命令接线、链接解析。

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)，
许可证为 [MIT](LICENSE)。
