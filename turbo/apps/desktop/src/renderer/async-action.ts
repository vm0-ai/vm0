/** DOM callbacks hand finite IPC work to main; track their settlement in the view. */
export enum Reason {
  DomCallback = "dom_callback",
}

const pending = new Set<Promise<void>>();

export function detach(work: Promise<unknown>, reason: Reason): void {
  const settled = work.then(
    () => {},
    () => {
      // Expected action failures live in useLoadableSet. Never log IPC payloads.
      console.warn("Desktop action could not complete", reason);
    },
  );
  pending.add(settled);
  settled.then(() => pending.delete(settled));
}

export async function settleDesktopActions(): Promise<void> {
  await Promise.all([...pending]);
}
