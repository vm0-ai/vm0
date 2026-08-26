import { Button } from "@okouai/ui";
import { useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { agents$ } from "../../signals/agent.ts";
import { retryAgentChatValidation$ } from "../../signals/okou-page/agent-chat-validation.ts";

export function AgentChatValidationPage() {
  const { t } = useTranslation();
  const agentsLoadable = useLoadable(agents$);
  const retry = useSet(retryAgentChatValidation$);

  return (
    <main
      className="flex min-h-dvh w-full items-center justify-center bg-background px-6"
      data-testid="agent-chat-validation"
    >
      {agentsLoadable.state === "hasError" ? (
        <div
          className="zero-card flex max-w-sm flex-col items-center gap-4 px-6 py-8 text-center"
          role="alert"
        >
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.authorization.permission.errors.loadAgent;
            })}
          </p>
          <Button type="button" variant="outline" onClick={retry}>
            {t(($) => {
              return $.chat.errors.recovery.tryAgain;
            })}
          </Button>
        </div>
      ) : (
        <div
          className="flex w-full max-w-3xl flex-col items-center"
          role="status"
          aria-label={t(($) => {
            return $.connectors.access.loading;
          })}
        >
          <div className="h-8 w-64 animate-pulse rounded-lg bg-muted" />
          <div className="mt-8 h-32 w-full animate-pulse rounded-3xl border border-border bg-muted/40" />
        </div>
      )}
    </main>
  );
}
