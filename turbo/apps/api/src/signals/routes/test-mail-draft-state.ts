import { testMailDraftStateContract } from "@okouai/api-contracts/contracts/test-mail-draft-state";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { computed } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

// Production deliberately has no endpoint that reveals whether inaccessible
// email content still exists. Keep this test-only read surface narrow so the
// lifecycle test can detect orphaned mail_drafts rows after thread deletion.
const getMailDraftState$ = computed(async (get) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const { mailDraftId } = get(pathParamsOf(testMailDraftStateContract.get));
  const [draft] = await get(db$)
    .select({ id: mailDrafts.id })
    .from(mailDrafts)
    .where(eq(mailDrafts.id, mailDraftId))
    .limit(1);

  return { status: 200 as const, body: { exists: Boolean(draft) } };
});

export const testMailDraftStateRoutes: readonly RouteEntry[] = [
  {
    route: testMailDraftStateContract.get,
    handler: getMailDraftState$,
  },
];
