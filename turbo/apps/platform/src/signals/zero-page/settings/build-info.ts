import { computed } from "ccstate";
import { buildInfoContract } from "@vm0/api-contracts/contracts/build-info";

import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";

interface BackendBuildInfo {
  readonly backendCommitSha: string | null;
}

export const backendBuildInfo$ = computed(
  async (get): Promise<BackendBuildInfo> => {
    const createClient = get(zeroClient$);
    const client = createClient(buildInfoContract);
    const result = await accept(client.get(), [200], { toast: false });

    return {
      backendCommitSha: result.body.commitSha,
    };
  },
);
