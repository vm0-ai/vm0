import {
  IconRocket,
  IconMessage,
  IconTool,
  IconCheck,
  IconBrain,
  IconUser,
  IconFlag,
  IconAlertCircle,
} from "@tabler/icons-react";

interface EventStyle {
  icon: typeof IconRocket;
  label: string;
  borderColor: string;
  bgColor: string;
  textColor: string;
  badgeColor: string;
}

/**
 * Event styles using semantic colors for clear visual hierarchy.
 * - Blue for system/init events (informational)
 * - Gray for assistant events (neutral)
 * - Cyan for user events (user interaction)
 * - Green for result events (success/completion)
 * - Red for errors only
 */
function createEventStyles(): Readonly<Record<string, EventStyle>> {
  return {
    // System event - blue (informational)
    system: {
      icon: IconRocket,
      label: "System",
      borderColor: "border-l-blue-500",
      bgColor: "bg-blue-50 dark:bg-blue-950/30",
      textColor: "text-blue-700 dark:text-blue-400",
      badgeColor:
        "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400",
    },

    // Assistant event - neutral gray
    assistant: {
      icon: IconBrain,
      label: "Assistant",
      borderColor: "border-l-slate-400 dark:border-l-slate-500",
      bgColor: "bg-slate-50 dark:bg-slate-900/30",
      textColor: "text-slate-700 dark:text-slate-300",
      badgeColor:
        "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    },

    // User event - cyan/teal (user interaction)
    user: {
      icon: IconUser,
      label: "User",
      borderColor: "border-l-cyan-500",
      bgColor: "bg-cyan-50 dark:bg-cyan-950/30",
      textColor: "text-cyan-700 dark:text-cyan-400",
      badgeColor:
        "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-400",
    },

    // Result event - green (success/completion)
    result: {
      icon: IconFlag,
      label: "Result",
      borderColor: "border-l-emerald-500",
      bgColor: "bg-emerald-50 dark:bg-emerald-950/30",
      textColor: "text-emerald-700 dark:text-emerald-400",
      badgeColor:
        "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400",
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
      icon: IconRocket,
      label: "Init",
      borderColor: "border-l-blue-500",
      bgColor: "bg-blue-50 dark:bg-blue-950/30",
      textColor: "text-blue-700 dark:text-blue-400",
      badgeColor:
        "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400",
    },
    thinking: {
      icon: IconBrain,
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
