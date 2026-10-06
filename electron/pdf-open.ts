import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeJoin } from './files';
const exec = promisify(execFile);

/** Validate local PDFs before passing a file URL to either browser. */
export async function projectPdfUrl(projectPath: string, relPath: string): Promise<string> {
  if (typeof projectPath !== 'string' || typeof relPath !== 'string' || !/\.pdf$/i.test(relPath)) throw Error('Expected a PDF file');
  const file = safeJoin(projectPath, relPath);
  const [root, real] = await Promise.all([fs.realpath(projectPath), fs.realpath(file)]);
  if (!real.startsWith(root + path.sep) || !(await fs.stat(real)).isFile()) throw Error('PDF must be a file inside the project');
  return pathToFileURL(real).href;
}

/** The default PDF handler may be Preview; explicitly select the HTTPS browser. */
export async function openPdfInExternalBrowser(url: string): Promise<void> {
  if (process.platform !== 'darwin') throw Error('External PDF browser opening is currently supported on macOS');
  const script = "ObjC.import('AppKit');var app=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com'));app ? ObjC.unwrap(app.path) : ''";
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 });
  const browser = stdout.trim();
  if (!browser) throw Error('No default web browser found');
  await exec('/usr/bin/open', ['-a', browser, url], { timeout: 15000 });
}
