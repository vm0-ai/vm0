import { useLastResolved } from "ccstate-react";
import { IconArrowLeft } from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { AgentPhoneCard } from "./agentphone-card.tsx";

export function ZeroAgentPhoneSettingsPage() {
  const features = useLastResolved(featureSwitch$);
  const enabled = features?.[FeatureSwitchKey.AgentPhoneAppUi];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <Link
            pathname={ROUTES.works}
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconArrowLeft size={14} stroke={1.5} />
            Channels
          </Link>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            AgentPhone
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Manage text-message access to Zero.
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px]">
          {enabled === true ? (
            <AgentPhoneCard />
          ) : enabled === false ? (
            <div className="zero-card p-5 text-sm text-muted-foreground">
              AgentPhone is not enabled for this workspace.
            </div>
          ) : (
            <div className="zero-card p-5 text-sm text-muted-foreground">
              Loading AgentPhone...
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
