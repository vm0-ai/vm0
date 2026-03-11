import { ZeroAppShell } from "./zero-app-shell.tsx";

interface ZeroPageProps {
  initialJobAgent?: string | null;
}

/**
 * Zero is a standalone product at /zero. It uses its own app shell and
 * sidebar; platform layout (navbar, sidebar) is not used here.
 */
export function ZeroPage({ initialJobAgent }: ZeroPageProps) {
  return <ZeroAppShell initialJobAgent={initialJobAgent} />;
}
