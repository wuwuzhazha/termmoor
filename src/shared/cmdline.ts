/**
 * cmd.exe argument quoting used when the terminal spawns a `.cmd`/`.bat` file.
 *
 * cmd has no backslash escaping: an embedded `"` must be doubled. Wrapping the
 * whole `/c` payload in one extra pair of quotes makes `/s` strip the outer
 * quotes before cmd parses the command.
 */

const CMD_META = /[\s"&|<>^()]/;

export function quoteForCmd(value: string): string {
  if (value === '') {
    return '""';
  }
  if (!CMD_META.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildCmdCommandLine(file: string, args: readonly string[]): string {
  const inner = [quoteForCmd(file), ...args.map(quoteForCmd)].join(' ');
  return `/d /s /c "${inner}"`;
}
