import { command, state } from "ccstate";

interface SignalHolder {
  readonly signal: AbortSignal;
}

const innerRootSignal$ = state<SignalHolder | undefined>(undefined);

export const setRootSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerRootSignal$, { signal });
});
