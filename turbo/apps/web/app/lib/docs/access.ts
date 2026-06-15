import { cache } from "react";
import { auth } from "@clerk/nextjs/server";

export const canViewDocsForUser = cache(
  async (
    userId: string | null | undefined,
    orgId: string | null | undefined,
  ): Promise<boolean> => {
    void userId;
    void orgId;
    return true;
  },
);

export async function canViewDocs(): Promise<boolean> {
  const { userId, orgId } = await auth();
  return canViewDocsForUser(userId, orgId);
}
