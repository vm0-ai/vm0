import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { generateRouterPath } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export type ConnectorRedirectingStatus = "redirecting" | "error";

export function connectorRedirectingPath(args: {
  readonly type: ConnectorRef;
  readonly label: string;
  readonly status?: ConnectorRedirectingStatus;
}): string {
  const pathname = generateRouterPath(ROUTES.connectorRedirecting, {
    type: args.type,
  });
  const searchParams = new URLSearchParams({ label: args.label });
  if (args.status === "error") {
    searchParams.set("status", args.status);
  }
  return `${pathname}?${searchParams.toString()}`;
}
