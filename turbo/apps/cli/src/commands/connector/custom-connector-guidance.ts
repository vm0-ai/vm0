import { z } from "zod";
import { connectorActionUrl } from "./action-url";

export function customConnectorIdFromSelector(
  selector: string | undefined,
): string | undefined {
  if (!selector?.startsWith("custom:")) {
    return undefined;
  }
  const id = z.uuid().safeParse(selector.slice("custom:".length));
  if (!id.success) {
    throw new Error(
      "Custom connector selectors must use custom:<uuid>. Run okou connector custom list to find the connector ID.",
    );
  }
  return id.data;
}

export function customConnectorSettingsPath(
  customConnectorId: string,
  view: "accounts" | "access",
  permission?: string,
): string {
  const params = new URLSearchParams({
    tab: "custom",
    customConnectorId,
    view,
  });
  if (permission !== undefined && permission !== "__unknown__") {
    params.set("permission", permission);
  }
  return `/connectors?${params.toString()}`;
}

export function customConnectorSettingsGuidance(
  customConnectorId: string,
  platformOrigin: string,
  permission?: string,
  agentId?: string,
): string {
  const url = connectorActionUrl({
    origin: platformOrigin,
    path: customConnectorSettingsPath(
      customConnectorId,
      permission === undefined ? "accounts" : "access",
      permission,
    ),
    agentId,
  });
  const steps =
    permission === undefined
      ? "Review its accounts and agent access. Reconnect or select an available account as needed."
      : permission === "__unknown__"
        ? "There is no custom unknown-endpoint approval control. Ask an administrator to review the connector's routing and permission definition."
        : "Review the affected agent's access and review Permissions. No permission is granted by opening this link.";
  return `Custom connector ${customConnectorId} uses the existing connector settings flow, not a builtin permission approval link.\nOpen [Custom connector settings](${url}). ${steps}\nIf the connector is unavailable or deleted, select an available connector manually. Settings review does not support callbacks. Connection and selection changes apply to future runs.`;
}
