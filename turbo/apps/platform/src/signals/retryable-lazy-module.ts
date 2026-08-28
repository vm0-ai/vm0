import { onRejection } from "./utils.ts";

export interface RetryableLazyModule<T> {
  /** One promise identity per attempt; a rejected attempt is not retained. */
  readonly load: () => Promise<T>;
  /** The successful module, when it is already safe to render synchronously. */
  readonly getLoaded: () => T | undefined;
}

/**
 * Keeps concurrent dynamic-import consumers on one promise while allowing a
 * later user action to retry after a transient chunk failure.
 */
export function createRetryableLazyModule<T>(
  importer: () => Promise<T>,
): RetryableLazyModule<T> {
  let active: Promise<T> | undefined;
  let loaded: T | undefined;
  let attemptId = 0;

  const rememberLoaded = async (promise: Promise<T>): Promise<T> => {
    const module = await promise;
    loaded = module;
    return module;
  };

  return {
    getLoaded: (): T | undefined => {
      return loaded;
    },
    load: (): Promise<T> => {
      if (active !== undefined) {
        return active;
      }
      const currentAttemptId = ++attemptId;
      const attempt = onRejection(rememberLoaded(importer()), () => {
        if (attemptId === currentAttemptId) {
          active = undefined;
        }
      });
      active = attempt;
      return attempt;
    },
  };
}
