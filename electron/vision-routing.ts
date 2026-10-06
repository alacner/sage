import { getCachedCaps } from './model-probe';
import type { ResolvedModel } from './model-resolver';
import { nativeVisionCapability } from '../shared/vision-capability';
export { nativeVisionCapability } from '../shared/vision-capability';
export async function supportsNativeVision(model?: ResolvedModel | null): Promise<boolean> {
  if (!model) return false;
  const caps = await getCachedCaps();
  // Relay request IDs are opaque transport identifiers; capability probes use the real model name.
  const identity = model.thinkingModel?.trim() || model.model.trim();
  return nativeVisionCapability(identity, caps[`model:${identity}`]?.vision);
}
