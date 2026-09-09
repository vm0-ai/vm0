import { computed } from "ccstate";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { accept } from "../../../lib/accept.ts";
import { i18n } from "../../../i18n/index.ts";
import { agents$ } from "../../agent.ts";
import { apiClient$ } from "../../api-client.ts";
import { currentUserInfo$ } from "../../auth.ts";
import { sshSummary$ } from "../../ssh.ts";
import {
  connectorsConnectionFilter$,
  connectorsSearch$,
} from "./connectors.ts";

export const filteredSshSummary$ = computed(async (get) => {
  const filter = get(connectorsConnectionFilter$);
  const search = get(connectorsSearch$).trim().toLowerCase();
  const summary = await get(sshSummary$);
  if (!summary) {
    return null;
  }
  const description = i18n.t(($) => {
    return $.ssh.description;
  });
  if (!`ssh ${description}`.toLowerCase().includes(search)) {
    return null;
  }
  if (filter.kind === "connected" && summary.configuredCount === 0) {
    return null;
  }
  if (filter.kind === "not-connected" && summary.configuredCount > 0) {
    return null;
  }
  if (filter.kind === "agent") {
    const [agents, user] = await Promise.all([
      get(agents$),
      get(currentUserInfo$),
    ]);
    if (
      !agents.some((agent) => {
        return agent.agentId === filter.agentId && agent.ownerId === user?.id;
      })
    ) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(agentSshAccessContract).get({
        params: { agentId: filter.agentId },
      }),
      [200, 404],
    );
    if (result.status === 404 || !result.body.enabled) {
      return null;
    }
  }
  return summary;
});
