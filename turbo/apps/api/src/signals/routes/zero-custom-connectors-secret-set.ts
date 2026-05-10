import { command } from "ccstate";
import { zeroCustomConnectorSecretContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { encryptSecretValue } from "../services/crypto.utils";
import { getCustomConnectorById } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route";

const setSecretInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorSecretContract.set));
  signal.throwIfAborted();

  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorSecretContract.set),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const connector = await get(
    getCustomConnectorById({
      orgId: auth.orgId,
      connectorId: params.id,
    }),
  );
  signal.throwIfAborted();
  if (!connector) {
    return notFound("Custom connector not found");
  }

  const encryptedValue = encryptSecretValue(bodyResult.data.value);
  const writeDb = set(writeDb$);
  await writeDb
    .insert(orgCustomConnectorSecrets)
    .values({
      connectorId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      encryptedValue,
    })
    .onConflictDoUpdate({
      target: [
        orgCustomConnectorSecrets.connectorId,
        orgCustomConnectorSecrets.userId,
      ],
      set: {
        encryptedValue,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const zeroCustomConnectorsSecretSetRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorSecretContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setSecretInner$,
    ),
  },
];
