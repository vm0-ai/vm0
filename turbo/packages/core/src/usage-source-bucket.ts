import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";

/**
 * Source bucket for per-user usage insight grouping.
 * Maps TriggerSource values to one of 5 display buckets.
 */
export type SourceBucket = "chat" | "slack" | "email" | "schedule" | "others";

/**
 * Map a TriggerSource (or null for deleted runs) to a display bucket.
 * This is the authoritative mapping used by both the SQL CASE expression
 * and the client-side chart legend — single source of truth.
 */
export function triggerSourceToBucket(
  source: TriggerSource | null,
): SourceBucket {
  switch (source) {
    case "web":
      return "chat";
    case "slack":
      return "slack";
    case "email":
      return "email";
    case "schedule":
      return "schedule";
    default:
      // telegram, github, cli, agent, phone, imessage, voice-chat, null
      return "others";
  }
}

/**
 * Fixed hex colors for source buckets in the insight chart.
 */
export const SOURCE_BUCKET_COLORS: Record<SourceBucket, string> = {
  chat: "hsl(var(--primary))",
  slack: "#4ade80",
  email: "#f59e0b",
  schedule: "#8b5cf6",
  others: "hsl(var(--muted-foreground))",
};
