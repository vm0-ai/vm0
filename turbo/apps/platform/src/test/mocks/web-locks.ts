import { withCleanup } from "../../signals/utils.ts";
/** Browser-boundary lock fixture shared by all Stores in one test window. */
export function createTestWebLocks(): LockManager {
  const held = new Set<string>();
  return {
    async request<T>(
      name: string,
      options: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<T> {
      if (typeof options === "function" || !options.ifAvailable || !callback) {
        throw new Error(
          "The test lock fixture requires ifAvailable and a callback",
        );
      }
      if (held.has(name)) {
        return await callback(null);
      }
      held.add(name);
      return await withCleanup(
        (async () => {
          return await callback({ name, mode: "exclusive" });
        })(),
        () => {
          held.delete(name);
        },
      );
    },
    query() {
      return Promise.resolve({
        held: [...held].map((name) => {
          return { name, mode: "exclusive" as const };
        }),
        pending: [],
      });
    },
  };
}
