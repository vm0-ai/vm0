import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import { sshErrorResponse } from "../../lib/ssh-error";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  createSshConnection,
  deleteSshConnection,
  listSshConnections,
  resetSshConnectionHostKey,
  summarizeSshConnections,
  updateSshConnection,
} from "../services/ssh-connection.service";

const sshConfigurationUnavailable = Object.freeze(
  sshErrorResponse(
    404,
    SSH_ERROR_CODES.UNAVAILABLE,
    "SSH configuration is not available",
  ),
);

const sshAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const sshFeatureContext$ = computed(
  async (get): Promise<FeatureSwitchContext | null> => {
    const auth = get(organizationAuthContext$);
    const context = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    return isFeatureEnabled(FeatureSwitchKey.SshAccess, context)
      ? context
      : null;
  },
);

function mapSshFailure(result: {
  readonly kind: "bad_request" | "not_found" | "conflict";
  readonly message: string;
  readonly code: SshErrorCode;
}) {
  switch (result.kind) {
    case "bad_request": {
      return sshErrorResponse(400, result.code, result.message);
    }
    case "not_found": {
      return sshErrorResponse(404, result.code, result.message);
    }
    case "conflict": {
      return sshErrorResponse(409, result.code, result.message);
    }
  }
}

const listSshConnectionsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await get(sshFeatureContext$);
    signal.throwIfAborted();
    if (!featureContext) {
      return sshConfigurationUnavailable;
    }

    const connections = await listSshConnections(
      get(db$),
      auth.orgId,
      auth.userId,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { connections } };
  },
);

const summarizeSshConnectionsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await get(sshFeatureContext$);
    signal.throwIfAborted();
    if (!featureContext) {
      return sshConfigurationUnavailable;
    }

    const summary = await summarizeSshConnections(
      get(db$),
      auth.orgId,
      auth.userId,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: summary };
  },
);

const createSshConnectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await get(sshFeatureContext$);
    signal.throwIfAborted();
    if (!featureContext) {
      return sshConfigurationUnavailable;
    }

    const bodyResult = await get(bodyResultOf(sshConnectionsContract.create));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return sshErrorResponse(
        400,
        SSH_ERROR_CODES.INVALID_INPUT,
        "Invalid SSH configuration",
      );
    }

    const result = await createSshConnection({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      body: bodyResult.data,
      featureContext,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      return mapSshFailure(result);
    }
    return { status: 201 as const, body: result.value };
  },
);

const updateSshConnectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await get(sshFeatureContext$);
    signal.throwIfAborted();
    if (!featureContext) {
      return sshConfigurationUnavailable;
    }

    const [params, bodyResult] = await Promise.all([
      get(pathParamsOf(sshConnectionsContract.update)),
      get(bodyResultOf(sshConnectionsContract.update)),
    ]);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return sshErrorResponse(
        400,
        SSH_ERROR_CODES.INVALID_INPUT,
        "Invalid SSH configuration",
      );
    }

    const result = await updateSshConnection({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      connectionId: params.connectionId,
      body: bodyResult.data,
      featureContext,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      return mapSshFailure(result);
    }
    return { status: 200 as const, body: result.value };
  },
);

const deleteSshConnectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await get(sshFeatureContext$);
    signal.throwIfAborted();
    if (!featureContext) {
      return sshConfigurationUnavailable;
    }

    const params = await get(pathParamsOf(sshConnectionsContract.delete));
    signal.throwIfAborted();
    const result = await deleteSshConnection({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      connectionId: params.connectionId,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      return mapSshFailure(result);
    }
    return { status: 204 as const, body: undefined };
  },
);

const resetSshConnectionHostKeyInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await get(sshFeatureContext$);
    signal.throwIfAborted();
    if (!featureContext) {
      return sshConfigurationUnavailable;
    }

    const [params, bodyResult] = await Promise.all([
      get(pathParamsOf(sshConnectionsContract.resetHostKey)),
      get(bodyResultOf(sshConnectionsContract.resetHostKey)),
    ]);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return sshErrorResponse(
        400,
        SSH_ERROR_CODES.INVALID_INPUT,
        "Invalid SSH configuration",
      );
    }

    const result = await resetSshConnectionHostKey({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      connectionId: params.connectionId,
      expectedGeneration: bodyResult.data.expectedGeneration,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      return mapSshFailure(result);
    }
    return { status: 200 as const, body: result.value };
  },
);

export const sshConnectionsRoutes: readonly RouteEntry[] = [
  {
    route: sshConnectionsContract.list,
    handler: authRoute(sshAuth, listSshConnectionsInner$),
  },
  {
    route: sshConnectionsContract.summary,
    handler: authRoute(sshAuth, summarizeSshConnectionsInner$),
  },
  {
    route: sshConnectionsContract.create,
    handler: authRoute(sshAuth, createSshConnectionInner$),
  },
  {
    route: sshConnectionsContract.update,
    handler: authRoute(sshAuth, updateSshConnectionInner$),
  },
  {
    route: sshConnectionsContract.delete,
    handler: authRoute(sshAuth, deleteSshConnectionInner$),
  },
  {
    route: sshConnectionsContract.resetHostKey,
    handler: authRoute(sshAuth, resetSshConnectionHostKeyInner$),
  },
];
