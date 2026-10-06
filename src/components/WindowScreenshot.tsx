import { useComposerShortcuts } from '../lib/composer-shortcuts';

/** Settings, files and empty windows use the same independent screenshot editor. */
export function WindowScreenshot({active}: {active: boolean}) {
  useComposerShortcuts('', false, true, {
    toggleVoice() {}, beginHold() {}, endHold() {},
    captureScreenshot: () => { void window.api.captureScreenshot().catch(error => console.error('Screenshot window failed to open', error)); },
  }, active);
  return null;
}
