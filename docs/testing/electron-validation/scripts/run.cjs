#!/usr/bin/env node
// Dependency-free process evidence runner. It does not infer test coverage from exit 0.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

async function main() {
  const { values, positionals } = parseArgs({
    options: { project: { type: 'string' }, timeout: { type: 'string', default: '120000' } },
    allowPositionals: true,
  });
  const timeout = Number(values.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !positionals.length)
    throw Error('Usage: run.cjs --project PATH --timeout MS -- COMMAND [ARGS...]');
  const project = fs.realpathSync(values.project || process.cwd());
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-validation-'));
  const out = fs.openSync(path.join(output, 'stdout.log'), 'w');
  const err = fs.openSync(path.join(output, 'stderr.log'), 'w');
  const started = Date.now();
  const env = { ...process.env, ELECTRON_VALIDATION_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  let timedOut = false, interrupted = null, launchError = null;
  const child = spawn(positionals[0], positionals.slice(1), {
    cwd: project, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', out, err],
  });
  const kill = () => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') launchError = String(error); }
  };
  const onInt = () => { interrupted = 'SIGINT'; kill(); };
  const onTerm = () => { interrupted = 'SIGTERM'; kill(); };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
  const result = await new Promise(resolve => {
    child.once('error', error => { launchError = String(error); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  // Reap descendants left behind by an exited launcher on POSIX.
  if (process.platform !== 'win32') kill();
  process.removeListener('SIGINT', onInt);
  process.removeListener('SIGTERM', onTerm);
  fs.closeSync(out); fs.closeSync(err);
  const status = timedOut ? 'timeout' : interrupted ? 'interrupted' : launchError ? 'launch-error' : result.code === 0 ? 'passed' : 'failed';
  const report = {
    schemaVersion: 1, status, project, command: positionals, startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started, exitCode: result.code, signal: result.signal, interrupted, launchError,
    node: process.version, platform: process.platform, arch: process.arch, output,
    coverage: 'Process outcome only; consult suite evidence for actual Electron coverage.',
    cleanup: process.platform === 'win32' ? 'Direct child only; suite must clean up descendants.' : 'Owned process group',
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${status.toUpperCase()}: ${path.join(output, 'report.json')}`);
  console.log(fs.readFileSync(path.join(output, 'stdout.log'), 'utf8'));
  const stderr = fs.readFileSync(path.join(output, 'stderr.log'), 'utf8');
  if (stderr) console.error(stderr);
  process.exitCode = status === 'passed' ? 0 : timedOut ? 124 : interrupted ? 130 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
