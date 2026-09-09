import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Switch } from "@okouai/ui";
import {
  currentAgentSshAccess$,
  updateCurrentAgentSshAccess$,
} from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";

export function AgentSshAccess({ agentId }: { readonly agentId: string }) {
  const { t } = useTranslation();
  const access = useLoadable(currentAgentSshAccess$);
  const [saving, update] = useLoadableSet(updateCurrentAgentSshAccess$);
  const signal = useGet(pageSignal$);
  if (
    access.state !== "hasData" ||
    !access.data ||
    access.data.agentId !== agentId
  ) {
    return null;
  }
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-5">
      <label className="flex items-center justify-between gap-4">
        <span className="font-medium">
          {t(($) => {
            return $.ssh.access;
          })}
        </span>
        <Switch
          checked={access.data.enabled}
          disabled={saving.state === "loading"}
          onCheckedChange={(enabled) => {
            return detach(update(agentId, enabled, signal), Reason.DomCallback);
          }}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.accessHelp;
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.cache;
        })}
      </p>
      <Link className="text-sm underline" pathname={ROUTES.settingsSsh}>
        {t(($) => {
          return $.ssh.manage;
        })}
      </Link>
    </section>
  );
}
