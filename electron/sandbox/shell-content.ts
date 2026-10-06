import { resolve } from 'node:path';

/** Recognize only inert setup prefixes; execute the original command unchanged. */
export function routineCommand(command: string, project: string): string {
  let remaining = command.trim();
  for (let i = 0; i < 4; i++) {
    const env = remaining.match(/^export\s+PATH=("[^"]*"|'[^']*'|[^\s]+)\s*&&\s*/);
    if (env) {
      const value = env[1].replace(/^['"]|['"]$/g, '');
      const literal = value.replace(/\$\{PATH\}|\$PATH/g, '');
      if (!/^[A-Za-z0-9_./:~+-]*$/.test(literal) ||
          value.split(':').some(p => !p.startsWith('/') && p !== '$PATH' && p !== '${PATH}')) return command;
      remaining = remaining.slice(env[0].length);
      continue;
    }
    const cd = remaining.match(/^cd\s+("[^"]*"|'[^']*'|[^\s]+)\s*&&\s*/);
    if (cd) {
      const target = cd[1].replace(/^['"]|['"]$/g, '');
      if (/[$`\\]/.test(target) || resolve(project, target) !== resolve(project)) return command;
      remaining = remaining.slice(cd[0].length);
      continue;
    }
    break;
  }
  return remaining;
}

/** Mask only literal arguments of shell output builtins. Unsupported shell syntax
 * stays untouched: a quoted path can still be an actual file operand. */
export function commandForPolicy(command: string): string {
  // Expansions, heredocs, escaping and compound constructs need semantic review.
  // Output can become another command's input (xargs, sh, etc.). Do not erase
  // evidence across pipelines or compound commands.
  if (/[$`\\(){}|;&\n]|<</.test(command)) return command;
  const words = command.match(/'(?:[^']*)'|"(?:[^"]*)"|&&|\|\||[;|&\n<>]|[^\s'";|&<>]+/g);
  if (!words) return command;
  let executable = true;
  let output = false;
  let redirect = false;
  return words.map((word) => {
    if (/^(?:&&|\|\||[;|&\n])$/.test(word)) {
      executable = true;
      output = false;
      redirect = false;
      return word;
    }
    if (/^[<>]$/.test(word)) { redirect = true; return word; }
    if (redirect) { redirect = false; return word; }
    if (executable) {
      executable = false;
      output = word === 'echo' || word === 'printf';
      return word;
    }
    return output ? "'literal'" : word;
  }).join(' ');
}

/** Only a small, explicit command grammar is eligible for deterministic rules.
 * Quotes around one file operand are supported; embedded programs and shell
 * expansions are classified as unknown rather than rejected by text matching. */
export function isSimpleCommand(command: string): boolean {
  if (/[$`\\(){}|;&\n]|<</.test(command)) return false;
  const words = command.match(/'(?:[^']*)'|"(?:[^"]*)"|[^\s'"<>]+|[<>]/g) ?? [];
  if (!words.length) return true;
  if (words.some(w => /^["']/.test(w) && /\s/.test(w.slice(1, -1)))) {
    return /^(?:echo|printf)\s/.test(command);
  }
  return /^(?:echo|printf|cat|ls|pwd|head|tail|wc|stat|file|find|rg|grep|git|npm|node|sudo|rm|mkfs|launchctl|crontab|chmod|chown|dd|diskutil|shutdown|reboot|killall|cp|mv|touch|mkdir)(?:\s|$)/.test(command.trim()) &&
    !/^(?:node)\s+(?:-e|--eval|-p|--print)\b/.test(command.trim());
}
