import { runtimeConfig } from '../../shared/runtime-config';

/** Read the current channel timeout without making channel modules depend on startup order. */
export async function channelConnectionTimeoutMs(): Promise<number> {
  try {
    const { readSettings } = await import('../main');
    return runtimeConfig((await readSettings()).runtimeConfig).channelConnectionTimeoutMs;
  } catch {
    return runtimeConfig().channelConnectionTimeoutMs;
  }
}
