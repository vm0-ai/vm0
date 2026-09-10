import type { UpdateImageReferenceBody } from "@okouai/api-contracts/contracts/image-references";
import { imageReferences } from "@okouai/db/schema/image-reference";
import { and, eq, or } from "drizzle-orm";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

type UpdateImageReferenceResult =
  | {
      readonly kind: "owner";
      readonly ownerUserId: string;
      readonly previousVisibility: "private" | "public";
      readonly visibility: "private" | "public";
    }
  | {
      readonly kind: "moderated";
      readonly ownerUserId: string;
      readonly previousVisibility: "public";
      readonly visibility: "private";
    };

export const updateImageReference$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly isOrgAdmin: boolean;
      readonly referenceId: string;
      readonly body: UpdateImageReferenceBody;
    },
    signal: AbortSignal,
  ): Promise<UpdateImageReferenceResult | null> => {
    const mutation = await set(writeDb$).transaction(async (tx) => {
      const [previous] = await tx
        .select({
          ownerUserId: imageReferences.ownerUserId,
          visibility: imageReferences.visibility,
        })
        .from(imageReferences)
        .where(
          and(
            eq(imageReferences.id, args.referenceId),
            eq(imageReferences.orgId, args.orgId),
            or(
              eq(imageReferences.ownerUserId, args.userId),
              eq(imageReferences.visibility, "public"),
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (!previous) {
        return null;
      }

      const currentTime = nowDate();
      if (previous.ownerUserId === args.userId) {
        const [updated] = await tx
          .update(imageReferences)
          .set({
            title: args.body.title,
            visibility: args.body.visibility,
            updatedBy: args.userId,
            updatedAt: currentTime,
          })
          .where(
            and(
              eq(imageReferences.id, args.referenceId),
              eq(imageReferences.orgId, args.orgId),
              eq(imageReferences.ownerUserId, args.userId),
            ),
          )
          .returning({ visibility: imageReferences.visibility });
        if (!updated) {
          throw new Error(`Image reference disappeared: ${args.referenceId}`);
        }
        return {
          kind: "owner" as const,
          ownerUserId: previous.ownerUserId,
          previousVisibility: previous.visibility,
          visibility: updated.visibility,
        };
      }

      if (
        !args.isOrgAdmin ||
        args.body.title !== undefined ||
        args.body.visibility !== "private" ||
        previous.visibility !== "public"
      ) {
        return null;
      }
      const [updated] = await tx
        .update(imageReferences)
        .set({
          visibility: "private",
          updatedBy: args.userId,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(imageReferences.id, args.referenceId),
            eq(imageReferences.orgId, args.orgId),
            eq(imageReferences.ownerUserId, previous.ownerUserId),
            eq(imageReferences.visibility, "public"),
          ),
        )
        .returning({ id: imageReferences.id });
      if (!updated) {
        throw new Error(`Image reference disappeared: ${args.referenceId}`);
      }
      return {
        kind: "moderated" as const,
        ownerUserId: previous.ownerUserId,
        previousVisibility: previous.visibility,
        visibility: "private" as const,
      };
    });
    signal.throwIfAborted();
    return mutation;
  },
);
