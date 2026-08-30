import { command, computed, state } from "ccstate";

import type { AuthRecovery } from "./auth-retry.ts";

export interface AuthenticatedIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly email?: string;
}

const internalAuthRecovery$ = state<Promise<AuthRecovery> | undefined>(
  undefined,
);
const internalAuthenticatedIdentity$ = state<
  Promise<AuthenticatedIdentity> | undefined
>(undefined);

export const setAuthRecovery$ = command(
  ({ set }, recovery: Promise<AuthRecovery>): void => {
    set(internalAuthRecovery$, recovery);
  },
);

export const setAuthenticatedIdentity$ = command(
  ({ set }, identity: Promise<AuthenticatedIdentity>): void => {
    set(internalAuthenticatedIdentity$, identity);
  },
);

export const authRecovery$ = computed((get): Promise<AuthRecovery> => {
  const recovery = get(internalAuthRecovery$);
  if (!recovery) {
    throw new Error("Auth recovery was not initialized during bootstrap");
  }
  return recovery;
});

export const runtimeAuthenticatedIdentity$ = computed(
  (get): Promise<AuthenticatedIdentity> => {
    const identity = get(internalAuthenticatedIdentity$);
    if (!identity) {
      throw new Error("Runtime authenticated identity was not initialized");
    }
    return identity;
  },
);
