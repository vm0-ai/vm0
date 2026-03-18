/**
 * Extract the display name from a compose content object.
 * The display name lives at content.agents[firstAgent].metadata.displayName.
 */
export function extractDisplayName(content: unknown): string | null {
  const c = content as {
    agents?: Record<string, { metadata?: { displayName?: string } }>;
  } | null;
  const agentNames = c?.agents ? Object.keys(c.agents) : [];
  const firstAgent = agentNames.length > 0 ? c?.agents?.[agentNames[0]!] : null;
  const displayName = firstAgent?.metadata?.displayName;
  return typeof displayName === "string" ? displayName : null;
}
