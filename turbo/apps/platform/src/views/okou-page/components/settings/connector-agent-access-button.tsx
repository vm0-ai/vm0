import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";

const AGENT_NAME_LIMIT = 2;
const AGENT_NAME_MAX_CHARS = 12;

function truncateAgentName(name: string): string {
  if (name.length <= AGENT_NAME_MAX_CHARS) {
    return name;
  }
  return `${name.slice(0, AGENT_NAME_MAX_CHARS - 1)}…`;
}

export function ConnectorAgentAccessButton({
  agents,
  loading,
  connectorLabel,
  onClick,
}: {
  readonly agents: readonly AgentResponse[];
  readonly loading: boolean;
  readonly connectorLabel: string;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  const unnamed = t(($) => {
    return $.connectors.catalog.unnamedAgent;
  });
  const agentNames = agents.map((agent) => {
    return agent.displayName ?? unnamed;
  });
  const visibleNames = agentNames.slice(0, AGENT_NAME_LIMIT).map((name) => {
    return truncateAgentName(name);
  });
  const overflowCount = agents.length - visibleNames.length;

  return (
    <Button
      type="button"
      variant="quiet"
      size="xs"
      className="min-w-0 gap-0 px-2 text-xs"
      aria-label={t(
        ($) => {
          return $.connectors.catalog.access.manage;
        },
        { connector: connectorLabel },
      )}
      data-testid="connector-card-agent-access"
      title={agentNames.length > 0 ? agentNames.join(", ") : undefined}
      onClick={onClick}
    >
      {loading ? (
        <span className="block h-3 w-20 animate-pulse rounded bg-muted" />
      ) : agents.length === 0 ? (
        <span
          className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
          data-testid="connector-card-access-empty"
        >
          {t(($) => {
            return $.connectors.catalog.access.add;
          })}
        </span>
      ) : (
        <>
          <span className="shrink-0">
            {t(($) => {
              return $.connectors.catalog.access.usedBy;
            }).trimEnd()}
            {"\u00a0"}
          </span>
          <span
            className="min-w-0 truncate underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
            data-testid="connector-card-access-names"
          >
            {visibleNames.join(", ")}
          </span>
          {overflowCount > 0 ? (
            <span className="shrink-0 text-muted-foreground/70">
              {"\u00a0"}+{overflowCount}
            </span>
          ) : null}
        </>
      )}
    </Button>
  );
}
