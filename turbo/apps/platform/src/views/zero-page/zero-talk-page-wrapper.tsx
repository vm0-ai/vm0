import { ZeroAppShell } from "./zero-app-shell.tsx";

/**
 * Wrapper for the /talk/:name route.
 * Renders the same chat UI as the root page — agent resolution
 * is handled by the dedicated setup function.
 */
export function ZeroTalkPageWrapper() {
  return <ZeroAppShell />;
}
