import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SetupScreen } from "./client/setup";
import { startDomBridge } from "./client/web";

function GeminiItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageCircle"
      active={currentScreen?.screenId === "gemini-web"}
      onPress={() => openScreen({ screenId: "gemini-web" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const stopBridge = startDomBridge(client);
  client.addScreen({ id: "gemini-web", title: "Gemini Web", Component: SetupScreen });
  client.addSidebarFooterItem({ id: "gemini-web", title: "Gemini Web", Component: GeminiItem });
  return stopBridge;
}
