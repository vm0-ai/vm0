import { computed, type Computed } from "ccstate";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";
import { and, eq, gt } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

export function zeroComputerUseHost(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
  Promise<{ readonly domain: string; readonly token: string } | null>
> {
  return computed(
    async (
      get,
    ): Promise<{ readonly domain: string; readonly token: string } | null> => {
      const [host] = await get(db$)
        .select({
          domain: computerUseHosts.domain,
          token: computerUseHosts.token,
        })
        .from(computerUseHosts)
        .where(
          and(
            eq(computerUseHosts.orgId, args.orgId),
            eq(computerUseHosts.userId, args.userId),
            gt(computerUseHosts.expiresAt, nowDate()),
          ),
        )
        .limit(1);

      return host ?? null;
    },
  );
}
