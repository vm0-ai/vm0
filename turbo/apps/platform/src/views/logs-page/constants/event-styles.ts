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

function createEventStyles(): Readonly<Record<string, EventStyle>> {
  return {
    // Main event types (from eventType field)
    system: {
      icon: IconRocket,
      label: "System",
      borderColor: "border-l-blue-500",
      bgColor: "bg-blue-50 dark:bg-blue-950/30",
      textColor: "text-blue-700 dark:text-blue-300",
      badgeColor:
        "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    },
    assistant: {
      icon: IconBrain,
      label: "Assistant",
      borderColor: "border-l-purple-500",
      bgColor: "bg-purple-50 dark:bg-purple-950/30",
      textColor: "text-purple-700 dark:text-purple-300",
      badgeColor:
        "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
    },
    user: {
      icon: IconUser,
      label: "User",
      borderColor: "border-l-green-500",
      bgColor: "bg-green-50 dark:bg-green-950/30",
      textColor: "text-green-700 dark:text-green-300",
      badgeColor:
        "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    },
    result: {
      icon: IconFlag,
      label: "Result",
      borderColor: "border-l-emerald-500",
      bgColor: "bg-emerald-50 dark:bg-emerald-950/30",
      textColor: "text-emerald-700 dark:text-emerald-300",
      badgeColor:
        "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    },

    // Content types (from message.content[].type)
    text: {
      icon: IconMessage,
      label: "Text",
      borderColor: "border-l-gray-400",
      bgColor: "bg-gray-50 dark:bg-gray-900/30",
      textColor: "text-gray-700 dark:text-gray-300",
      badgeColor:
        "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    },
    tool_use: {
      icon: IconTool,
      label: "Tool",
      borderColor: "border-l-amber-500",
      bgColor: "bg-amber-50 dark:bg-amber-950/30",
      textColor: "text-amber-700 dark:text-amber-300",
      badgeColor:
        "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    },
    tool_result: {
      icon: IconCheck,
      label: "Result",
      borderColor: "border-l-green-500",
      bgColor: "bg-green-50 dark:bg-green-950/30",
      textColor: "text-green-700 dark:text-green-300",
      badgeColor:
        "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    },
    tool_result_error: {
      icon: IconAlertCircle,
      label: "Error",
      borderColor: "border-l-red-500",
      bgColor: "bg-red-50 dark:bg-red-950/30",
      textColor: "text-red-700 dark:text-red-300",
      badgeColor: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    },

    // Legacy types for backwards compatibility
    init: {
      icon: IconRocket,
      label: "Init",
      borderColor: "border-l-blue-500",
      bgColor: "bg-blue-50 dark:bg-blue-950/30",
      textColor: "text-blue-700 dark:text-blue-300",
      badgeColor:
        "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    },
    thinking: {
      icon: IconBrain,
      label: "Thinking",
      borderColor: "border-l-purple-500",
      bgColor: "bg-purple-50 dark:bg-purple-950/30",
      textColor: "text-purple-700 dark:text-purple-300",
      badgeColor:
        "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
    },
    default: {
      icon: IconMessage,
      label: "Event",
      borderColor: "border-l-gray-300",
      bgColor: "bg-gray-50 dark:bg-gray-900/30",
      textColor: "text-gray-600 dark:text-gray-400",
      badgeColor:
        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
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
