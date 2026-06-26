import { command } from "ccstate";
import { zeroCustomConnectorProposalContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { saveCustomConnectorProposal$ } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route";

const saveProposalInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(
      bodyResultOf(zeroCustomConnectorProposalContract.save),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      saveCustomConnectorProposal$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        isAdmin: auth.orgRole === "admin",
        proposal: bodyResult.data.proposal,
        values: bodyResult.data.values,
        ...(bodyResult.data.agentId
          ? { agentId: bodyResult.data.agentId }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in result) {
      return result;
    }
    return { status: 200 as const, body: result };
  },
);

export const zeroCustomConnectorProposalRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorProposalContract.save,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      saveProposalInner$,
    ),
  },
];
