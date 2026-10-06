import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Resolve the actual host, never guess a production identity for an unknown process. */
export function runningBundleId(executable = process.execPath): string {
  const macOS = path.dirname(executable), contents = path.dirname(macOS);
  if (path.basename(macOS) !== 'MacOS' || path.basename(contents) !== 'Contents' || !path.dirname(contents).endsWith('.app')) return '';
  try {
    const value = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(contents, 'Info.plist')], { encoding: 'utf8', timeout: 2000 }).trim();
    return /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(value) ? value : '';
  } catch { return ''; }
}
