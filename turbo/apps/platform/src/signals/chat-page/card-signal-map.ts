import { command, computed, state, type Command, type Computed } from "ccstate";

/**
 * A thread-owned registry giving every card a stable signal identity across
 * transcript recomputations. The map is a `state` written only by `register$`,
 * so creating signals is always a command and never a side effect of reading
 * the graph; reads go through `signalsByKey$`.
 */
export interface CardSignalsRegistry<Descriptor, Signals> {
  /** Get-or-create by the descriptor's key; idempotent per key. */
  readonly register$: Command<Signals, [Descriptor]>;
  readonly signalsByKey$: Computed<ReadonlyMap<string, Signals>>;
}

export function createCardSignalsRegistry<Descriptor, Signals>(
  keyOf: (descriptor: Descriptor) => string,
  create: (descriptor: Descriptor) => Signals,
): CardSignalsRegistry<Descriptor, Signals> {
  const internalSignalsByKey$ = state<ReadonlyMap<string, Signals>>(new Map());

  const register$ = command(({ get, set }, descriptor: Descriptor): Signals => {
    const current = get(internalSignalsByKey$);
    const key = keyOf(descriptor);
    const existing = current.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const signals = create(descriptor);
    const next = new Map(current);
    next.set(key, signals);
    set(internalSignalsByKey$, next);
    return signals;
  });

  return {
    register$,
    signalsByKey$: computed((get) => {
      return get(internalSignalsByKey$);
    }),
  };
}
