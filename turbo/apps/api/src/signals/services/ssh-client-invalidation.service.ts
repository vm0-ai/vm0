import { publishUserSignal } from "../external/realtime";

/** A committed change stays successful even when browser publication fails. */
export async function publishSshClientInvalidation(owner: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await publishUserSignal([owner.userId], "ssh:changed", {
    orgId: owner.orgId,
  });
}
