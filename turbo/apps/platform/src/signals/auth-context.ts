import { command, computed, state } from "ccstate";

interface AuthenticatedIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly email?: string;
}

const internalAuthenticatedIdentity$ = state<
  Promise<AuthenticatedIdentity> | undefined
>(undefined);

export const setAuthenticatedIdentity$ = command(
  ({ set }, identity: Promise<AuthenticatedIdentity>): void => {
    set(internalAuthenticatedIdentity$, identity);
  },
);

export const runtimeAuthenticatedIdentity$ = computed(
  (get): Promise<AuthenticatedIdentity> => {
    const identity = get(internalAuthenticatedIdentity$);
    if (!identity) {
      throw new Error("Runtime authenticated identity was not initialized");
    }
    return identity;
  },
);
