import { ZeroAppShell } from "./zero-app-shell.tsx";

/**
 * Wrapper for the / (chat root) route.
 * Renders the chat UI — redirect-to-default-agent logic
 * is handled by the dedicated setup function.
 */
export function ZeroChatPageWrapper() {
  return <ZeroAppShell />;
}
