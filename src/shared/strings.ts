import type { TerminalStrings } from './terminalProtocol';

const en: TerminalStrings = {
  appName: 'TermMoor',
  newTerminal: 'New terminal',
  closeTerminal: 'Close terminal',
  closeOtherTerminals: 'Close other terminals',
  restart: 'Restart',
  hint: 'Click path · Ctrl+Alt+Enter insert code · Ctrl+1-9/←→ tabs · Ctrl+F find',
  terminalStarting: 'Starting terminal…',
  terminalExited: 'Terminal exited',
  copy: 'Copy',
  paste: 'Paste',
  clearTerminal: 'Clear terminal',
  find: 'Find in terminal (Ctrl+F)',
  findPlaceholder: 'Find…',
  findNoResults: '0/0',
  findPrev: 'Previous match (Shift+Enter)',
  findNext: 'Next match (Enter)',
  close: 'Close (Esc)',
  jumpedCommandBlock: 'Command',
  noCommandBlocks: 'No recorded command blocks yet.',
  contextAdded: 'Inserted into the terminal.',
  contextQueued: 'Queued until the terminal starts.',
  longCommandDone: 'Command finished in TermMoor',
  longCommandFailed: 'Command exited with error in TermMoor',
  terminalBell: 'TermMoor needs attention',
  focusTerminal: 'Show Terminal',
  errorPrefix: 'Error',
  attentionNeeded: 'Needs attention'
};

const zh: TerminalStrings = {
  appName: 'TermMoor',
  newTerminal: '新建终端',
  closeTerminal: '关闭终端',
  closeOtherTerminals: '关闭其他终端',
  restart: '重启',
  hint: '点击路径跳转 · Ctrl+Alt+Enter 填入代码 · Ctrl+1-9/←→ 切标签 · Ctrl+F 搜索',
  terminalStarting: '正在启动终端…',
  terminalExited: '终端已退出',
  copy: '复制',
  paste: '粘贴',
  clearTerminal: '清空终端',
  find: '终端内搜索 (Ctrl+F)',
  findPlaceholder: '搜索…',
  findNoResults: '0/0',
  findPrev: '上一个匹配 (Shift+Enter)',
  findNext: '下一个匹配 (Enter)',
  close: '关闭 (Esc)',
  jumpedCommandBlock: '命令块',
  noCommandBlocks: '暂无已记录的命令提示符位置。',
  contextAdded: '已插入终端。',
  contextQueued: '终端启动后插入。',
  longCommandDone: 'TermMoor 长耗时命令已完成',
  longCommandFailed: 'TermMoor 命令执行失败',
  terminalBell: 'TermMoor 收到响铃提醒',
  focusTerminal: '查看终端',
  errorPrefix: '错误',
  attentionNeeded: '需要关注'
};

export function getStrings(locale: string): TerminalStrings {
  return locale.toLowerCase().startsWith('zh') ? zh : en;
}
