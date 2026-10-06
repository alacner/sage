import fs from 'node:fs/promises';
// Change only when the guide changes, independently of application releases.
export const ONBOARDING_VERSION = 2;
export function createOnboardingClaim(file: string, version = ONBOARDING_VERSION) {
  let queue = Promise.resolve();
  return () => {
    const result = queue.then(async () => {
      let seen = 0;
      try {
        const state = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!Number.isInteger(state.version) || state.version < 0) throw new Error('Invalid onboarding state');
        seen = state.version;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (seen >= version) return { show: false, version };
      await fs.writeFile(file + '.tmp', JSON.stringify({ version }), { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
      return { show: true, version };
    });
    queue = result.then(() => {}, () => {});
    return result;
  };
}
