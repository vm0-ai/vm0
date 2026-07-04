import { useGet, useLastResolved, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { activeRoute$ } from "../../signals/active-route.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { RouteKey } from "../../signals/route-paths.ts";
import {
  chatShortcutHelpOpen$,
  setChatShortcutHelpOpen$,
} from "../../signals/chat-page/chat-shortcut-help.ts";
import { ShortcutHelpDialog } from "../components/shortcut-help-dialog.tsx";

const CHAT_THREAD_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "mod+b", label: "Toggle sidebar" },
      { key: "mod+shift+o", label: "New chat" },
      { key: "mod+shift+a", label: "Open agent list" },
      { key: "f2", label: "Rename chat" },
      { key: "shift+f2", label: "Change icon" },
      { key: "ctrl+shift+1", label: "Set icon (Ctrl+Shift+1-9)" },
      { key: "ctrl+shift+0", label: "Clear icon" },
    ],
  },
  {
    title: "Messages",
    shortcuts: [
      { key: "mod+arrowup", label: "Scroll to top" },
      { key: "mod+arrowdown", label: "Scroll to bottom" },
      { key: "mod+shift+arrowup", label: "Previous thread" },
      { key: "mod+shift+arrowdown", label: "Next thread" },
    ],
  },
  {
    title: "Composer",
    shortcuts: [
      { key: "enter", label: "Send message" },
      { key: "escape", label: "Blur composer" },
    ],
  },
] as const;

const AGENT_CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "mod+b", label: "Toggle sidebar" },
      { key: "mod+shift+o", label: "New chat" },
      { key: "mod+shift+a", label: "Open agent list" },
      { key: "mod+shift+arrowdown", label: "Open first thread" },
    ],
  },
  {
    title: "Composer",
    shortcuts: [
      { key: "enter", label: "Send message" },
      { key: "escape", label: "Blur composer" },
    ],
  },
] as const;

const SIDEBAR_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "mod+b", label: "Toggle sidebar" },
      { key: "mod+shift+o", label: "New chat" },
      { key: "mod+shift+a", label: "Open agent list" },
    ],
  },
] as const;

function isChatThreadEmojiShortcutKey(key: string): boolean {
  return key === "shift+f2" || key === "ctrl+shift+1" || key === "ctrl+shift+0";
}

function shortcutSectionsForRoute(
  route: RouteKey | null,
  chatThreadEmojiEnabled: boolean,
) {
  if (route === "chat") {
    return chatThreadEmojiEnabled
      ? CHAT_THREAD_SHORTCUT_SECTIONS
      : CHAT_THREAD_SHORTCUT_SECTIONS.map((section) => {
          if (section.title !== "Global") {
            return section;
          }
          return {
            ...section,
            shortcuts: section.shortcuts.filter((shortcut) => {
              return !isChatThreadEmojiShortcutKey(shortcut.key);
            }),
          };
        });
  }
  if (route === "agentChat" || route === "home") {
    return AGENT_CHAT_SHORTCUT_SECTIONS;
  }
  return SIDEBAR_SHORTCUT_SECTIONS;
}

export function ChatShortcutHelpDialog() {
  const shortcutHelpOpen = useGet(chatShortcutHelpOpen$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  const activeRoute = useGet(activeRoute$);
  const features = useLastResolved(featureSwitch$);
  const chatThreadEmojiEnabled =
    features?.[FeatureSwitchKey.ChatThreadEmoji] ?? false;
  const shortcutSections = shortcutSectionsForRoute(
    activeRoute,
    chatThreadEmojiEnabled,
  );

  return (
    <ShortcutHelpDialog
      open={shortcutHelpOpen}
      onOpenChange={setShortcutHelpOpen}
      description="Available shortcuts on this page"
      sections={shortcutSections}
    />
  );
}
