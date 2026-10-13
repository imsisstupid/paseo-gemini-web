import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider";
import { registerDomBridge } from "./server/dom-bridge";
import { connectBrowserTools } from "./server/browser-tools";
import { GeminiDomCommandSchema } from "./shared/dom-bridge";
import { GeminiBrowser } from "./server/gemini-browser";

export default function contribute(server: PluginServerContext) {
  const bridge = registerDomBridge(server);
  server.registerProvider(createProvider({
    createBrowser(tools) {
      const browser = new GeminiBrowser(tools);
      const stop = browser.stop.bind(browser);
      const close = browser.close.bind(browser);
      browser.stop = async id => { bridge.cancel(id); await stop(id); };
      browser.close = async id => { bridge.cancel(id); await close(id); };
      return browser;
    },
    async connectTools(config) {
      const browser = await connectBrowserTools(config);
      return {
        call(name, args) {
          if (name === 'gemini_dom') {
            if (typeof args.browserId !== 'string') throw new Error('Gemini browser tab is required.');
            return bridge.execute(args.browserId, GeminiDomCommandSchema.parse(args.command));
          }
          return browser.call(name, args);
        },
        close: () => browser.close(),
      };
    },
  }));
  return () => bridge.close();
}
