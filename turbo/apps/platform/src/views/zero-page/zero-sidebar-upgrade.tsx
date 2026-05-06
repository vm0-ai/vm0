import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { billingStatusAsync$ } from "../../signals/zero-page/billing.ts";
import planProImg from "./components/org-manage/assets/plan-pro.webp";
import planTeamImg from "./components/org-manage/assets/plan-team.webp";
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";

function nextTierInfo(tier: string): { label: string; img: string } | null {
  if (tier === "free") {
    return { label: "Pro", img: planProImg };
  }
  if (tier === "pro") {
    return { label: "Team", img: planTeamImg };
  }
  return null;
}

export function SidebarUpgradeCard() {
  const pageSignal = useGet(pageSignal$);
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const setTab = useSet(setActiveOrgManageTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const openManage = useSet(setOrgManageDialogOpen$);

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
    setTab("billing");
    setSubPage(true);
    detach(openManage(true, pageSignal), Reason.DomCallback);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center gap-3 p-2.5 text-left transition-colors hover:bg-muted/30 zero-card shadow-[0_1px_2px_hsl(220_12%_20%/0.04),0_4px_12px_hsl(220_12%_20%/0.03)]"
      style={{ borderRadius: "12px" }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Get {next.label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          More credits & concurrent runs
        </p>
      </div>
      <img
        src={next.img}
        alt={next.label}
        className="h-14 w-14 shrink-0 object-contain -my-3"
      />
    </button>
  );
}
