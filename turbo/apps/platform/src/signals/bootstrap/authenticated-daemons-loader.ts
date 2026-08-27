import { command } from "ccstate";
import { clerk$ } from "../auth.ts";

/** Load authenticated background services only after Clerk resolves a session. */
export const loadAuthenticatedDaemons$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }

    const { setupAuthenticatedDaemons$ } =
      await import("../authenticated-daemons.ts");
    signal.throwIfAborted();
    await set(setupAuthenticatedDaemons$, signal);
  },
);
