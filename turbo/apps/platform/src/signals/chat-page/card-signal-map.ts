export function getOrCreateCardSignals<T>(
  signalsByResourceKey: Map<string, T>,
  resourceKey: string,
  create: () => T,
): T {
  const existing = signalsByResourceKey.get(resourceKey);
  if (existing !== undefined) {
    return existing;
  }
  const signals = create();
  signalsByResourceKey.set(resourceKey, signals);
  return signals;
}

export function registeredCardSignals<T>(
  signalsByResourceKey: ReadonlyMap<string, T>,
  resourceKey: string,
): T {
  const signals = signalsByResourceKey.get(resourceKey);
  if (signals === undefined) {
    throw new Error(`Card signals were not registered: ${resourceKey}`);
  }
  return signals;
}
