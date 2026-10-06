/** Local, high-confidence secret pattern detection for outbound user text.
 * This module returns categories only; callers should never log matched values.
 */
export type SecretFinding = 'privateKey' | 'providerKey' | 'accessToken' | 'credentialAssignment';

const PATTERNS: Array<[SecretFinding, RegExp]> = [
  ['privateKey', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['providerKey', /\b(?:sk-(?:proj-|org-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[\w-]{30,})\b/g],
  ['accessToken', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/gi],
  ['credentialAssignment', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|app[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`,;]{12,})/gi],
];

const PLACEHOLDER = /^(?:x{3,}|\*{3,}|<[^>]+>|\$\{[^}]+\}|your[_-]|example|sample|placeholder|changeme|redacted|replace[_-])/i;

/** Returns unique categories only, never the secret values themselves. */
export function detectPotentialSecrets(text: string): SecretFinding[] {
  const found = new Set<SecretFinding>();
  for (const [category, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      if (category !== 'credentialAssignment' || !PLACEHOLDER.test(match[1] ?? '')) found.add(category);
      if (!match[0].length) pattern.lastIndex++;
    }
  }
  return [...found];
}
