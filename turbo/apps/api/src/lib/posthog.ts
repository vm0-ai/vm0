import { optionalEnv } from "./env";
import { logger } from "./log";
import { tapError } from "../signals/utils";

const L = logger("PostHog");
const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";
const SAFE_ATTRIBUTION_KEYS = [
  "source_type",
  "referrer_domain",
  "landing_host",
  "landing_path",
  "vm0_source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;
const CLICK_ID_PRESENT_KEYS = [
  ["gclid", "gclid_present"],
  ["gbraid", "gbraid_present"],
  ["wbraid", "wbraid_present"],
] as const;

type PostHogProperties = Readonly<Record<string, unknown>>;
type SafeAttributionKey = (typeof SAFE_ATTRIBUTION_KEYS)[number];
type ClickIdKey = (typeof CLICK_ID_PRESENT_KEYS)[number][0];
type ClickIdPresentKey = (typeof CLICK_ID_PRESENT_KEYS)[number][1];
type SafeAttribution = Partial<
  Record<SafeAttributionKey | ClickIdKey | ClickIdPresentKey, string>
>;

interface CapturePostHogEventInput {
  readonly event: string;
  readonly distinctId: string;
  readonly properties?: PostHogProperties;
  readonly groups?: {
    readonly organizationId?: string;
  };
}

function postHogProjectKey(): string | undefined {
  return (
    optionalEnv("POSTHOG_PROJECT_API_KEY") ??
    optionalEnv("POSTHOG_KEY") ??
    optionalEnv("VITE_POSTHOG_KEY") ??
    optionalEnv("NEXT_PUBLIC_POSTHOG_KEY")
  );
}

function cleanProperties(
  properties: PostHogProperties | undefined,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function safeAcquisitionAttributionProperties(
  attribution: SafeAttribution | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of SAFE_ATTRIBUTION_KEYS) {
    properties[key] = attribution?.[key];
  }
  for (const [clickIdKey, presentKey] of CLICK_ID_PRESENT_KEYS) {
    properties[presentKey] =
      attribution?.[presentKey] === "true" ||
      Boolean(attribution?.[clickIdKey]);
  }
  return properties;
}

export async function capturePostHogEvent(
  args: CapturePostHogEventInput,
): Promise<void> {
  const apiKey = postHogProjectKey();
  if (!apiKey) {
    return;
  }

  const properties = cleanProperties({
    ...args.properties,
    ...(args.groups?.organizationId
      ? { $groups: { organization: args.groups.organizationId } }
      : {}),
    distinct_id: args.distinctId,
    $lib: "vm0-api",
  });
  const response = await tapError(
    fetch(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event: args.event,
        distinct_id: args.distinctId,
        properties,
      }),
    }),
    (error) => {
      L.warn("capture failed", { event: args.event, error });
    },
  );
  if (!response) {
    return;
  }
  if (!response.ok) {
    L.warn("capture failed", {
      event: args.event,
      status: response.status,
    });
  }
}
