import { command, state, type Command } from "ccstate";

interface MountedPinDragSession {
  readonly reconcile$: Command<void, []>;
}

const mountedPinDragSessions$ = state<readonly MountedPinDragSession[]>([]);

export const registerPinnedThreadDragSession$ = command(
  ({ set }, reconcile$: Command<void, []>, signal: AbortSignal) => {
    signal.throwIfAborted();
    const session = { reconcile$ };
    set(mountedPinDragSessions$, (sessions) => {
      return [...sessions, session];
    });
    signal.addEventListener(
      "abort",
      () => {
        set(mountedPinDragSessions$, (sessions) => {
          return sessions.filter((entry) => {
            return entry !== session;
          });
        });
      },
      { once: true },
    );
  },
);

// Projection writers end invalid interactions in the same state transition.
// Each mounted list owns its registration and its own cancellation command.
export const reconcilePinnedThreadDragSessions$ = command(({ get, set }) => {
  for (const session of get(mountedPinDragSessions$)) {
    set(session.reconcile$);
  }
});
