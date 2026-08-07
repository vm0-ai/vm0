import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { billingStatusAsync$ } from "../../signals/zero-page/billing.ts";
import { planProImg, planTeamImg } from "./platform-assets.ts";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../signals/zero-page/settings/settings-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";

function nextTierInfo(
  tier: string,
): { tier: "pro" | "team"; img: string } | null {
  if (tier === "free" || tier === "limited-free-1" || tier === "pro-suspend") {
    return { tier: "pro", img: planProImg };
  }
  if (tier === "pro") {
    return { tier: "team", img: planTeamImg };
  }
  return null;
}

export function SidebarUpgradeCard() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);

  if (!isAdmin) {
    return null;
  }

  if (!billing) {
    return null;
  }
  const next = nextTierInfo(billing.tier);
  if (!next) {
    return null;
  }

  const handleClick = () => {
    openBillingPlans();
    detach(openSettings(true, pageSignal), Reason.DomCallback);
  };
  const nextLabel =
    next.tier === "pro"
      ? t(($) => {
          return $.billing.plans.pro.name;
        })
      : t(($) => {
          return $.billing.plans.team.name;
        });

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center gap-3 p-2.5 text-left transition-colors hover:bg-muted/30 zero-card shadow-[0_1px_2px_hsl(220_12%_20%/0.04),0_4px_12px_hsl(220_12%_20%/0.03)]"
      style={{ borderRadius: "12px" }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {t(
            ($) => {
              return $.billing.sidebar.getPlan;
            },
            { plan: nextLabel },
          )}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {t(($) => {
            return $.billing.sidebar.description;
          })}
        </p>
      </div>
      <img
        src={next.img}
        alt={nextLabel}
        className="h-14 w-14 shrink-0 object-contain -my-3"
      />
    </button>
  );
}
