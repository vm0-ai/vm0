import { command } from "ccstate";
import { z } from "zod";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import { searchParams$ } from "../route.ts";
import {
  closeCustomConnectorDialog$,
  customConnectorAgentAuthorizations$,
  customConnectorDialog$,
  customConnectors$,
  openCustomConnectorAccessDialog$,
} from "../okou-page/settings/custom-connectors.ts";
import { openCustomAccountManager$ } from "../okou-page/settings/connector-account-dialogs.ts";
import { setConnectorAccessManagementSearch$ } from "../okou-page/settings/connector-access-management.ts";
import {
  closeCustomConnectorPermissions$,
  customConnectorPermissionDraft$,
  openCustomConnectorPermissions$,
} from "../okou-page/settings/custom-connector-permissions.ts";

const setupCustomConnectorAccessRecovery$ = command(
  async (
    { get, set },
    connector: CustomConnectorResponse,
    params: URLSearchParams,
    signal: AbortSignal,
  ) => {
    set(openCustomConnectorAccessDialog$, connector);
    const agentId = params.get("agentId");
    if (!agentId) {
      return;
    }
    const authorizations = await get(customConnectorAgentAuthorizations$);
    signal.throwIfAborted();
    const dialog = get(customConnectorDialog$);
    if (
      get(searchParams$).toString() !== params.toString() ||
      dialog.kind !== "access" ||
      dialog.connector.id !== connector.id
    ) {
      return;
    }
    const authorization = authorizations.find((row) => {
      return row.agent.agentId === agentId;
    });
    if (!authorization) {
      return;
    }
    if (authorization.agent.displayName) {
      set(setConnectorAccessManagementSearch$, authorization.agent.displayName);
    }
    const permission = params.get("permission");
    if (
      !permission ||
      permission === "__unknown__" ||
      !connector.permissionBundleRef
    ) {
      return;
    }
    const grant = authorization.access.grants.find((item) => {
      return item.customConnectorId === connector.id;
    });
    set(openCustomConnectorPermissions$, {
      surface: "access-management",
      agentId,
      connectorId: connector.id,
      initiallyAuthorized: grant !== undefined,
      permissionNames: grant?.permissionNames ?? [],
    });
  },
);

export const setupCustomConnectorRecovery$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(closeCustomConnectorDialog$);
    set(setConnectorAccessManagementSearch$, "");
    const draft = get(customConnectorPermissionDraft$);
    if (draft?.surface === "access-management") {
      set(closeCustomConnectorPermissions$, draft);
    }

    const params = get(searchParams$);
    const id = z.uuid().safeParse(params.get("customConnectorId"));
    const view = params.get("view");
    if (
      params.get("tab") !== "custom" ||
      !id.success ||
      (view !== "accounts" && view !== "access")
    ) {
      return;
    }
    const initialDialog = get(customConnectorDialog$);
    const connectors = await get(customConnectors$);
    signal.throwIfAborted();
    if (
      get(searchParams$).toString() !== params.toString() ||
      get(customConnectorDialog$) !== initialDialog
    ) {
      return;
    }
    const connector = connectors.find((item) => {
      return item.id === id.data;
    });
    if (!connector) {
      return;
    }
    if (view === "accounts") {
      set(openCustomAccountManager$, connector, signal);
      return;
    }
    await set(setupCustomConnectorAccessRecovery$, connector, params, signal);
  },
);
