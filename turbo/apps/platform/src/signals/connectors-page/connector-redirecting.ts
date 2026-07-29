import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { IN_VITEST } from "../../env.ts";
import { generateRouterPath } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export type ConnectorRedirectingStatus = "redirecting" | "error";

const MOBILE_REDIRECT_WARNING_DELAY_MS = IN_VITEST ? 100 : 2000;
const internalMobileWarningVisible$ = state(false);

export const connectorRedirectingMobileWarningVisible$ = computed((get) => {
  return get(internalMobileWarningVisible$);
});

export const resetConnectorRedirectingMobileWarning$ = command(({ set }) => {
  set(internalMobileWarningVisible$, false);
});

export const showConnectorRedirectingMobileWarningAfterDelay$ = command(
  async ({ set }, signal: AbortSignal) => {
    const mobileDevice =
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (!mobileDevice) {
      return;
    }

    await delay(MOBILE_REDIRECT_WARNING_DELAY_MS, { signal });
    signal.throwIfAborted();
    set(internalMobileWarningVisible$, true);
  },
);

export function connectorRedirectingPath(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly icon: PublicConnectorCatalogIcon;
  readonly status?: ConnectorRedirectingStatus;
}): string {
  const pathname = generateRouterPath(ROUTES.connectorRedirecting, {
    type: args.connectorSlug,
  });
  const searchParams = new URLSearchParams({
    label: args.label,
    iconUrl: args.icon.url,
    iconInvertInDarkMode: String(args.icon.invertInDarkMode),
  });
  if (args.icon.scale !== undefined) {
    searchParams.set("iconScale", String(args.icon.scale));
  }
  if (args.status === "error") {
    searchParams.set("status", args.status);
  }
  return `${pathname}?${searchParams.toString()}`;
}
