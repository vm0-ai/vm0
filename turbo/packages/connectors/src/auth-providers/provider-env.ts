export interface ProviderEnv {
  readonly [name: string]: string | undefined;
}

export function providerEnvFromObject(
  values: Readonly<Record<string, unknown>>,
): ProviderEnv {
  const env: ProviderEnv = {};
  return new Proxy(env, {
    get: (_target, property) => {
      if (typeof property !== "string" || !Object.hasOwn(values, property)) {
        return undefined;
      }
      const value = values[property];
      return typeof value === "string" ? value : undefined;
    },
  });
}
