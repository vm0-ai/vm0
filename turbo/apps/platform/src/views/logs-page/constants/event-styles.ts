import {
  IconSettings,
  IconMessage,
  IconTool,
  IconCheck,
  IconUser,
  IconAlertCircle,
  IconSquareCheck,
} from "@tabler/icons-react";

interface EventStyle {
  icon: typeof IconSettings;
  label: string;
  borderColor: string;
  bgColor: string;
  textColor: string;
  badgeColor: string;
}

/**
 * Event styles matching Figma design.
 * - Sky blue border badge for system events
 * - Yellow border badge for assistant events
 * - Pink border badge for user events
 * - Lime border badge for result events
 * Cards have white background with light border (no left color stripe)
 */
function createEventStyles(): Readonly<Record<string, EventStyle>> {
  return {
    // System event - gear icon, sky blue border badge (Figma: sky/600 #0284c7)
    system: {
      icon: IconSettings,
      label: "System",
      borderColor: "border-border",
      bgColor: "bg-card",
      textColor: "text-sky-600",
      badgeColor: "border border-sky-600 text-sky-600 bg-sky-600/10",
    },

    // Assistant event - user icon, yellow border badge (Figma: yellow/600 #ca8a04)
    assistant: {
      icon: IconUser,
      label: "Assistant",
      borderColor: "border-border",
      bgColor: "bg-card",
      textColor: "text-yellow-600",
      badgeColor: "border border-yellow-600 text-yellow-600 bg-yellow-600/10",
    },

    // User event - user icon, pink border badge (Figma: pink/600 #db2777)
    user: {
      icon: IconUser,
      label: "User",
      borderColor: "border-border",
      bgColor: "bg-card",
      textColor: "text-pink-600",
      badgeColor: "border border-pink-600 text-pink-600 bg-pink-600/10",
    },

    // Result event - check icon, lime border badge (Figma: lime/600)
    result: {
      icon: IconSquareCheck,
      label: "Result",
      borderColor: "border-border",
      bgColor: "bg-card",
      textColor: "text-lime-600",
      badgeColor: "border border-lime-600 text-lime-600 bg-lime-600/10",
    },

    // Content types - subtle styling within cards
    text: {
      icon: IconMessage,
      label: "Text",
      borderColor: "border-l-transparent",
      bgColor: "bg-transparent",
      textColor: "text-foreground",
      badgeColor: "bg-muted text-muted-foreground",
    },
    tool_use: {
      icon: IconTool,
      label: "Tool",
      borderColor: "border-l-amber-500",
      bgColor: "bg-amber-500/10",
      textColor: "text-foreground",
      badgeColor: "bg-amber-500/20 text-amber-600",
    },
    tool_result: {
      icon: IconCheck,
      label: "Result",
      borderColor: "border-l-emerald-500",
      bgColor: "bg-emerald-500/10",
      textColor: "text-emerald-600",
      badgeColor: "bg-emerald-500/20 text-emerald-600",
    },
    tool_result_error: {
      icon: IconAlertCircle,
      label: "Error",
      borderColor: "border-l-red-500",
      bgColor: "bg-red-500/10",
      textColor: "text-red-600",
      badgeColor: "bg-red-500/20 text-red-600",
    },

    // Legacy types for backwards compatibility
    init: {
      icon: IconSettings,
      label: "Init",
      borderColor: "border-l-blue-500",
      bgColor: "bg-blue-500/10",
      textColor: "text-blue-600",
      badgeColor: "bg-blue-500/20 text-blue-600",
    },
    thinking: {
      icon: IconUser,
      label: "Thinking",
      borderColor: "border-l-violet-500",
      bgColor: "bg-violet-500/10",
      textColor: "text-violet-600",
      badgeColor: "bg-violet-500/20 text-violet-600",
    },
    default: {
      icon: IconMessage,
      label: "Event",
      borderColor: "border-l-gray-400",
      bgColor: "bg-muted",
      textColor: "text-muted-foreground",
      badgeColor: "bg-muted text-muted-foreground",
    },
  };
}

export function getEventStyle(eventType: string): EventStyle {
  const styles = createEventStyles();
  return styles[eventType] ?? styles.default;
}

/** Event types that are hidden by default */
export function getHiddenByDefault(): ReadonlySet<string> {
  return new Set(["thinking"]);
}

/** All known event types for filtering */
export const KNOWN_EVENT_TYPES = [
  "system",
  "assistant",
  "user",
  "result",
] as const;
