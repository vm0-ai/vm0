import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "../../lib/singleton";

// Monday 2026-09-07 09:00 Asia/Shanghai.
const MORNING_BRIEF_DEFAULT_ACTIVATION_AT: Readonly<Date> = new Date(
  "2026-09-07T01:00:00.000Z",
);

interface ScopedActivationInstant {
  readonly value: Date | null;
}

const scopedActivationInstant = singleton(() => {
  return new AsyncLocalStorage<ScopedActivationInstant>();
});

function morningBriefDefaultActivationAt(): Date | null {
  const scoped = scopedActivationInstant.peek()?.getStore();
  return scoped ? scoped.value : MORNING_BRIEF_DEFAULT_ACTIVATION_AT;
}

export function morningBriefDefaultEligibleAt(
  organizationCreatedAt: Date,
): Date | null {
  const activationAt = morningBriefDefaultActivationAt();
  return activationAt && organizationCreatedAt >= activationAt
    ? organizationCreatedAt
    : null;
}

export async function withMorningBriefDefaultActivationAtForTest<T>(
  value: Date | null,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedActivationInstant().run({ value }, work);
}
