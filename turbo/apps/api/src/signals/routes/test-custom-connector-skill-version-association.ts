import { testCustomConnectorSkillVersionAssociationContract } from "@okouai/api-contracts/contracts/test-custom-connector-skill-version-association";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const associationBody$ = bodyResultOf(
  testCustomConnectorSkillVersionAssociationContract.associate,
);

const associate$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(associationBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const [connector] = await set(writeDb$)
    .update(orgCustomConnectors)
    .set({
      skillStorageVersionId: bodyResult.data.skillStorageVersionId,
    })
    .where(eq(orgCustomConnectors.id, bodyResult.data.connectorId))
    .returning({ id: orgCustomConnectors.id });
  signal.throwIfAborted();
  if (!connector) {
    return notFound("Custom connector skill association target not found");
  }
  return { status: 200 as const, body: { ok: true as const } };
});

export const testCustomConnectorSkillVersionAssociationRoutes: readonly RouteEntry[] =
  [
    {
      route: testCustomConnectorSkillVersionAssociationContract.associate,
      handler: associate$,
    },
  ];
