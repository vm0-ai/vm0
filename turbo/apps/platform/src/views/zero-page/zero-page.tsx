import { ZeroAppShell } from "./zero-app-shell.tsx";

/**
 * Zero is a standalone product at /zero. It uses its own app shell and
 * sidebar; platform layout (navbar, sidebar) is not used here.
 */
export function ZeroPage() {
  return <ZeroAppShell />;
}
