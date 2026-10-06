// @ts-check
/// <reference path="./sage-sdk.d.ts" />
globalThis.sagePlugin = {
  services: {
    notes: {
      read: async (_args, sdk) => (await sdk.settings.get('note')) ?? '',
      save: async (args, sdk) => {
        await sdk.settings.set('note', args.text);
        return true; // Report success only after persistence succeeds.
      }
    }
  }
};
