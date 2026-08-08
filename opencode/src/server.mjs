import { createOpenCodeHooks } from './runtime.mjs';

const plugin = Object.freeze({
  id: '@agoragentic/opencode',
  async server(context, options = {}) {
    return createOpenCodeHooks({
      directory: context?.directory,
      options,
    });
  },
});

export default plugin;
