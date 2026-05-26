import { command, computed, state } from "ccstate";

const internalCreatingOrg$ = state(false);

export const creatingOrg$ = computed((get) => {
  return get(internalCreatingOrg$);
});

export const setCreatingOrg$ = command(({ set }, value: boolean) => {
  set(internalCreatingOrg$, value);
});

const internalAcceptingInvitationId$ = state<string | null>(null);

export const acceptingInvitationId$ = computed((get) => {
  return get(internalAcceptingInvitationId$);
});

export const setAcceptingInvitationId$ = command(
  ({ set }, value: string | null) => {
    set(internalAcceptingInvitationId$, value);
  },
);
