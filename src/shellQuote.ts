/**
 * Quote one token for the interactive shell that Terminal Pro starts.
 *
 * Windows uses PowerShell, where a single-quoted string is literal and `''`
 * escapes a quote. POSIX shells use `'\''` for the same purpose. Newlines are
 * collapsed so an inserted path can never submit a command by itself.
 */
export function quoteForShell(value: string, platform: NodeJS.Platform = process.platform): string {
  const clean = String(value ?? '').replace(/\r?\n/g, ' ');
  if (platform === 'win32') {
    return `'${clean.replace(/'/g, "''")}'`;
  }
  return `'${clean.replace(/'/g, `'\\''`)}'`;
}
