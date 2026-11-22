# 验收清单（TermMoor 0.9.0）

在 VSCodium 中安装/加载本扩展后，按下列顺序逐项验收。除特别说明外，每项
都应在中文和英文界面各走一遍；提示文案以当前 `vscode.env.language` 为准。

前置条件：

- 打开一个包含中文目录/文件名的单根或多根工作区。
- 再准备一个嵌套工作区（工程目录位于另一个已打开的工作区目录之内），用于
  第 7 节。
- 准备一个含多行文本的剪贴板内容。
- 不要求安装任何 Agent；本版本不检测、不启动 Agent。

0.9.0 的验收重点：面板内（webview）功能保留，视图标题与命令/菜单贡献收敛到
最小集合。

## 1. 启动与终端

- [ ] 打开侧边栏：立即出现普通 shell（Windows 为 PowerShell，其它平台为
      登录 shell），工作目录为工作区根目录，不自动进入任何 TUI。
- [ ] 视图内没有自绘标题栏；终端从视图顶部开始，占据全部可用高度。
- [ ] 视图标题栏不贡献任何 TermMoor 操作；新建终端使用标签条的 `＋`。
- [ ] 命令面板中 `TermMoor: New Terminal` 能新开一个 shell，且不会留下旧
      PTY；`TermMoor: Open TermMoor` / `Open in Secondary Side Bar` 能打开视图。
- [ ] 关闭再打开侧边栏后能重新启动 shell；关闭时旧 PTY 被停止。
- [ ] 终端输出超过一屏后，鼠标滚轮可上下滚动；滚动到顶部后继续上滚不会
      带动整个侧边栏滚动。
- [ ] 在 `vim`、`less` 或 Agent TUI 等备用屏幕应用中，滚轮仍按应用自身
      的鼠标/方向键语义工作。

## 2. 路径与链接（保留）

- [ ] 在终端输出中点击普通相对路径、`path:line`、`path:line-column`、
      `path:start-end`、`#Lx-Ly`，均能在对应行打开。
- [ ] 中文路径（含中文目录和中文文件名）可点击并正确打开；CJK 文本紧邻路径、
      路径跨行折行时仍只生成一个链接。
- [ ] Windows 路径和 UNC 路径可点击。
- [ ] 点击工作区外的已存在路径时出现 “Open outside the workspace?” 二次确认；
      取消则不打开。
- [ ] 输出中的 `http(s):` / `mailto:` 链接能打开；`file:`、`command:` 和自定义
      scheme 不会交给 `openExternal`。

## 3. 编辑器 → 终端（保留）

- [ ] 编辑器有选区时按 `Ctrl+Alt+Enter`（macOS `Cmd+Alt+Enter`）或右键
      “Insert Code Context into TermMoor”：输入行出现 "代码 + 出处（如
      `src/app.ts:3-5`）"，不自动回车。
- [ ] 无选区时按同一快捷键：插入文件路径（未保存的缓冲区写入私有临时文件
      并插入该文件路径）。
- [ ] 编辑器右键菜单只有一条 TermMoor 项（Insert Code Context into
      TermMoor）；没有 Insert Selection / File / File Content 三条旧项。
- [ ] 命令面板中只有 `TermMoor: Insert Code Context into TermMoor` 这一条
      TermMoor 插入类命令。
- [ ] 多行粘贴不会误提交：粘贴后文本完整留在输入行，只有用户自己按 Enter
      才提交。

## 4. 已移除的命令与菜单（不得出现）

- [ ] 命令面板中不存在：`Insert Workspace Context`、`Insert Workspace
      Problems`、`Insert Git Diff`、`Open Terminal Output in Editor`、
      `Toggle Multiline Draft Input`、`Insert Selection into Terminal`、
      `Insert File into Terminal`、`Insert Folder into Terminal`、
      `Insert File Content into Terminal`、`Insert Terminal Output into
      TermMoor`、`Rename Active Terminal Tab`、`Restart Terminal`、
      `Find in Terminal`、`Close Active Terminal`。
- [ ] 资源管理器右键文件/文件夹：没有 TermMoor 条目。
- [ ] VS Code 集成终端右键：没有 TermMoor 条目。
- [ ] 不再有可触发的 `Ctrl+Alt+I` 工作区上下文选择器，也没有 `Ctrl+Shift+Space`
      多行草稿输入框；面板内没有草稿按钮或输出导出按钮。
- [ ] 中文/英文界面下，上述已移除项都没有残留的本地化标题（`package.nls*.json`
      中对应 `cmd.*` 键已删除）。

## 5. 面板内功能（保留，均为 webview 交互）

- [ ] 标签条包含 `＋`：点击新开一个 shell。
- [ ] `Ctrl+1`…`Ctrl+9` 切换标签；标签名称由前台进程自动决定。
- [ ] 标签上的 `✕` 关闭该标签。关闭最后一个标签后出现全新 shell；正在运行
      工作的标签关闭前弹出确认，空闲提示符下无确认。
- [ ] 面板内 Restart（标签右键菜单或已退出遮罩上的重启按钮）可把当前标签
      换成新 shell；运行中重启有确认。
- [ ] `Ctrl+F` / `Ctrl+Shift+F` 在面板内打开搜索条：有匹配计数，Enter /
      Shift+Enter 循环，宽字符高亮正确，`Esc` 关闭；在 `vim` / `less` 中
      `Ctrl+F` 不被面板拦截。
- [ ] `Ctrl+Up` / `Ctrl+Down` 在命令块之间跳转。
- [ ] 后台/未聚焦命令运行超过 `longRunningThresholdSeconds` 后完成时出现提示；
      值为 `0` 时不提示。

## 6. 安全默认值

- [ ] 工作区外路径打开需二次确认（见第 2 节）。
- [ ] `package.json` 中 `capabilities.untrustedWorkspaces.supported` 为 `false`。
- [ ] 临时上下文目录位于系统临时目录，名称以 `terminal-pro-ctx-` 开头；
      POSIX 下目录权限为 `0700`、文件为 `0600`；shell 集成辅助文件位于其中的
      `integration/` 子目录。
- [ ] 扩展 dispose 后临时目录被删除；超过 24 小时的残留目录在下次启动时清理。
- [ ] 安装/替换 VSIX 不写入任何用户状态；被移除命令的旧快捷键调用只会得到
      “command not found”，不影响终端本身。

## 7. 工作区目录跳转

- [ ] 当根目录没有 `integration/`、而 `Tests/integration/` 存在时，点击
      终端输出的 `integration/`，资源管理器应定位到 `Tests/integration/`。
- [ ] 如果 `.tmp/` 里也有发布副本，仍应定位到源码目录；同优先级的候选
      应打开选择框。

## 8. 构建、测试与打包门禁

在扩展目录（不是外层嵌套工作区根目录）执行：

- [ ] `npm run build`：先 `tsc -p tsconfig.json --noEmit`，再 esbuild；退出码 0。
- [ ] `npm test`：打包全部 `test/*.test.ts` 并运行 `node --test`；全部通过，
      记录测试文件数与用例数。
- [ ] `npm run package`：先执行 build，再通过 dist 新鲜度与 PTY prebuild 检查，
      产出 `termmoor-0.9.0-win32-x64.vsix`；退出码 0。
- [ ] VSIX 内容检查：
      - 含 `extension/LICENSE.txt`、`extension/changelog.md`、`extension/readme.md`、
        `extension/package.nls.json`、`extension/package.nls.zh-cn.json`；
      - 不含 `extension/src/**`、`extension/test/**`、`extension/docs/**`；
      - 不含 `extension/dist/pi-extension/**`；
      - 含 `extension/dist/extension.js`、`extension/dist/pty/**`、
        `extension/media/webview/terminal.js`。
- [ ] 打包清单中的 `contributes.commands` 只有 `focus`、`openSidebar`、
      `newSession`、`sendToTerminal` 四项；`menus` 只有 `editor/context`（sendToTerminal）。
- [ ] 不安装 VSIX、不执行 git 操作、不改动 `node_modules`。

## 9. 回归项

- [ ] `state.seq` 生效：快速重启时，webview 不因迟到的旧快照回退。
- [ ] `init` 之后收到旧 `state` 不会覆盖当前标题、提示或运行状态。
- [ ] 终端 resize 的非法尺寸（NaN、过小、过大）被丢弃。
- [ ] 复制失败时回退到宿主剪贴板；宿主剪贴板也失败时给出提示。
- [ ] 视图隐藏后再显示，已有 shell 与输出保持可用（`retainContextWhenHidden`）。
