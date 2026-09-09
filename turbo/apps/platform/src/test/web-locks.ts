import { createDeferredPromise, withCleanup } from "../signals/utils.ts";

interface LockRequest {
  readonly grant: () => void;
  revoke: (() => void) | null;
}

/** Simulates the browser's exclusive lock queue and context termination. */
export function installWebLocks(signal: AbortSignal): void {
  const queues = new Map<string, LockRequest[]>();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const locks = {
    async request<T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | Promise<T>,
    ): Promise<T> {
      const lifetime = options.signal ?? signal;
      lifetime.throwIfAborted();
      const granted = createDeferredPromise<void>(lifetime);
      const queue = queues.get(name) ?? [];
      const request: LockRequest = {
        grant: () => {
          if (!granted.settled()) {
            granted.resolve();
          }
        },
        revoke: null,
      };
      if (options.steal) {
        queue[0]?.revoke?.();
        queue.splice(1, 0, request);
      } else {
        queue.push(request);
      }
      queues.set(name, queue);
      if (queue[0] === request) {
        request.grant();
      }
      return await withCleanup(
        (async () => {
          await granted.promise;
          lifetime.throwIfAborted();
          const revoked = createDeferredPromise<never>(lifetime);
          const reason = new DOMException("Lock released", "AbortError");
          request.revoke = () => {
            if (!revoked.settled()) {
              revoked.reject(reason);
            }
          };
          return await withCleanup(
            Promise.race([
              callback({ name, mode: "exclusive" }),
              revoked.promise,
            ]),
            () => {
              if (!revoked.settled()) {
                revoked.reject(reason);
              }
            },
          );
        })(),
        () => {
          const index = queue.indexOf(request);
          queue.splice(index, 1);
          if (queue.length === 0) {
            queues.delete(name);
          } else if (index === 0) {
            queue[0]?.grant();
          }
        },
      );
    },
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, "locks", descriptor);
      } else {
        Reflect.deleteProperty(navigator, "locks");
      }
    },
    { once: true },
  );
}
