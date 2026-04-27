export function lazySingleton<T>(factory: () => T): {
  (): T;
  readonly peek: () => T | undefined;
  readonly reset: () => void;
} {
  let instance: T | undefined;

  const get = (): T => {
    instance ??= factory();
    return instance;
  };

  return Object.assign(get, {
    peek: (): T | undefined => {
      return instance;
    },
    reset: (): void => {
      instance = undefined;
    },
  });
}

export function testOverride<T>(factory: () => T): {
  readonly get: () => T;
  readonly set: (value: T) => void;
  readonly clear: () => void;
} {
  let init = factory();

  return {
    get: () => {
      return init;
    },
    set: (value: T) => {
      init = value;
    },
    clear: () => {
      init = factory();
    },
  };
}
