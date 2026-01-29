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
 * - Orange border badge for system/assistant events
 * - Red border badge for user events
 * - Green border badge for result events
 * Cards have white background with light border (no left color stripe)
 */
function createEventStyles(): Readonly<Record<string, EventStyle>> {
  return {
    // System event - gear icon, blue border badge (matching Figma)
    system: {
      icon: IconSettings,
      label: "System",
      borderColor: "border-border",
      bgColor: "bg-white dark:bg-slate-900",
      textColor: "text-sky-600",
      badgeColor:
        "border border-sky-400 text-sky-600 bg-sky-50 dark:border-sky-500 dark:text-sky-400 dark:bg-sky-950/30",
    },

    // Assistant event - user icon, orange/amber border badge (matching Figma)
    assistant: {
      icon: IconUser,
      label: "Assistant",
      borderColor: "border-border",
      bgColor: "bg-white dark:bg-slate-900",
      textColor: "text-amber-600",
      badgeColor:
        "border border-amber-400 text-amber-600 bg-amber-50 dark:border-amber-500 dark:text-amber-400 dark:bg-amber-950/30",
    },

    // User event - user icon, pink/magenta border badge (matching Figma)
    user: {
      icon: IconUser,
      label: "User",
      borderColor: "border-border",
      bgColor: "bg-white dark:bg-slate-900",
      textColor: "text-pink-500",
      badgeColor:
        "border border-pink-400 text-pink-500 bg-pink-50 dark:border-pink-500 dark:text-pink-400 dark:bg-pink-950/30",
    },

    // Result event - check icon, lime border badge (matching Figma)
    result: {
      icon: IconSquareCheck,
      label: "Result",
      borderColor: "border-border",
      bgColor: "bg-white dark:bg-slate-900",
      textColor: "text-lime-600",
      badgeColor:
        "border border-lime-600 text-lime-600 bg-lime-50 dark:border-lime-500 dark:text-lime-400 dark:bg-lime-950/30",
    },

    // Content types - subtle styling within cards
    text: {
      icon: IconMessage,
      label: "Text",
      borderColor: "border-l-transparent",
      bgColor: "bg-transparent",
      textColor: "text-foreground",
      badgeColor:
        "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
    },
    tool_use: {
      icon: IconTool,
      label: "Tool",
      borderColor: "border-l-amber-400 dark:border-l-amber-500",
      bgColor: "bg-amber-50/50 dark:bg-amber-950/20",
      textColor: "text-foreground",
      badgeColor:
        "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400",
    },
    tool_result: {
      icon: IconCheck,
      label: "Result",
      borderColor: "border-l-emerald-400 dark:border-l-emerald-500",
      bgColor: "bg-emerald-50/50 dark:bg-emerald-950/20",
      textColor: "text-emerald-700 dark:text-emerald-400",
      badgeColor:
        "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400",
    },
    tool_result_error: {
      icon: IconAlertCircle,
      label: "Error",
      borderColor: "border-l-red-500",
      bgColor: "bg-red-50 dark:bg-red-950/30",
      textColor: "text-red-700 dark:text-red-400",
      badgeColor:
        "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400",
    },

    // Legacy types for backwards compatibility
    init: {
      icon: IconSettings,
      label: "Init",
      borderColor: "border-l-blue-500",
      bgColor: "bg-blue-50 dark:bg-blue-950/30",
      textColor: "text-blue-700 dark:text-blue-400",
      badgeColor:
        "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400",
    },
    thinking: {
      icon: IconUser,
      label: "Thinking",
      borderColor: "border-l-violet-400 dark:border-l-violet-500",
      bgColor: "bg-violet-50/50 dark:bg-violet-950/20",
      textColor: "text-violet-700 dark:text-violet-400",
      badgeColor:
        "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-400",
    },
    default: {
      icon: IconMessage,
      label: "Event",
      borderColor: "border-l-slate-300 dark:border-l-slate-600",
      bgColor: "bg-slate-50 dark:bg-slate-900/30",
      textColor: "text-slate-600 dark:text-slate-400",
      badgeColor:
        "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
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
