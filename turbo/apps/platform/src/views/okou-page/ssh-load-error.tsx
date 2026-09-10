import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { invalidateSsh$ } from "../../signals/ssh.ts";

export function SshLoadError() {
  const { t } = useTranslation();
  const retry = useSet(invalidateSsh$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <p>
        {t(($) => {
          return $.ssh.loadFailed;
        })}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          return retry();
        }}
      >
        {t(($) => {
          return $.ssh.retry;
        })}
      </Button>
    </div>
  );
}
