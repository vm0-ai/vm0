import { useState } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core";
import {
  Check,
  ChevronDown,
  Coins,
  MessageSquare,
  PlusCircle,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { openSettingsDialogAt$ } from "../../signals/zero-page/settings/settings-dialog.ts";
import { slackOrgData$ } from "../../signals/zero-page/zero-slack.ts";
import {
  billingStatusAsync$,
  usagePackCreditsAsync$,
} from "../../signals/zero-page/billing.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const slackIconImg = settingsIconAssetUrl("slack");

// The nav rail draws this asset the same way: the artwork carries its own
// padding, so it is scaled up inside a box the size we actually want.
//
// 16px everywhere, because Button and DropdownMenuItem both enforce
// `[&_svg]:size-4` on their descendants and the marks have to agree with it.
function SlackMark({ size }: { size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <img
        src={slackIconImg}
        alt=""
        className="scale-[2.2]"
        style={{ width: size, height: size }}
      />
    </span>
  );
}

/** Whether the org-scoped Slack app is installed. */
function useSlackInstalled(): boolean {
  const loadable = useLastLoadable(slackOrgData$);
  if (loadable.state !== "hasData" || !loadable.data) {
    return false;
  }
  return loadable.data.isInstalled || loadable.data.isConnected;
}

/** Organization credits without usage-pack credits. */
function useOrganizationCreditLabel(): string | null {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const orgCredits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  return orgCredits === null ? null : formatLocalizedNumber(orgCredits);
}

function useCombinedCreditLabel(): string | null {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const usagePackLoadable = useLastLoadable(usagePackCreditsAsync$);
  const orgCredits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  const packCredits =
    usagePackLoadable.state === "hasData"
      ? usagePackLoadable.data.totalCredits
      : null;
  if (orgCredits === null || usagePackLoadable.state === "loading") {
    return null;
  }
  return formatLocalizedNumber(orgCredits + (packCredits ?? 0));
}

function CreditMenuItem({
  creditLabel,
  openCredits,
}: {
  creditLabel: string | null;
  openCredits: () => void;
}) {
  const { t } = useTranslation();
  if (creditLabel === null) {
    return null;
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuModalItem
        className="gap-3 px-3 py-2.5"
        onModalSelect={openCredits}
        data-testid="growth-credits"
      >
        <Coins className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {t(($) => {
            return $.chat.agentPage.growth.credits;
          })}
        </span>
        <span className="shrink-0 font-semibold tabular-nums">
          {creditLabel}
        </span>
      </DropdownMenuModalItem>
    </>
  );
}

function OrganizationCreditMenuItem({
  openCredits,
}: {
  openCredits: () => void;
}) {
  const creditLabel = useOrganizationCreditLabel();
  return (
    <CreditMenuItem creditLabel={creditLabel} openCredits={openCredits} />
  );
}

function CombinedCreditMenuItem({
  openCredits,
}: {
  openCredits: () => void;
}) {
  const creditLabel = useCombinedCreditLabel();
  return (
    <CreditMenuItem creditLabel={creditLabel} openCredits={openCredits} />
  );
}

function GrowthCreditMenuItem({
  openCredits,
}: {
  openCredits: () => void;
}) {
  const features = useLastResolved(featureSwitch$);
  const usagePackPlansEnabled =
    features?.[FeatureSwitchKey.UsagePackPlans] ?? false;
  return usagePackPlansEnabled ? (
    <CombinedCreditMenuItem openCredits={openCredits} />
  ) : (
    <OrganizationCreditMenuItem openCredits={openCredits} />
  );
}

function useGrowthActions() {
  const pageSignal = useGet(pageSignal$);
  const openSettings = useSet(openSettingsDialogAt$);
  const navigate = useSet(detachedNavigateTo$);
  return {
    openWorks: () => {
      navigate("/works");
    },
    openInvite: () => {
      detach(openSettings("people", pageSignal), Reason.DomCallback);
    },
    openCredits: () => {
      detach(openSettings("usage", pageSignal), Reason.DomCallback);
    },
  };
}

/**
 * The home page's growth entry.
 *
 * The corner names one thing — whichever growth step is still worth taking —
 * and the panel carries the rest. Slack is a one-time setup so it can be
 * finished; inviting never finishes, so it is the resting state and the entry
 * always has something to say.
 */
function GrowthEntry() {
  const [creditsRequested, setCreditsRequested] = useState(false);
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const slackInstalled = useSlackInstalled();
  const { openWorks, openInvite, openCredits } = useGrowthActions();

  const leadIsSlack = !slackInstalled;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          setCreditsRequested(true);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          // 12px, not the Button default 8px: this trigger is one half of a
          // pair with the 12px menu it opens, so they read as one object.
          className="h-8 gap-0 rounded-[12px] bg-card px-[11px] shadow-[var(--zero-card-shadow)]"
          data-testid="growth-entry"
        >
          <span className="flex items-center gap-[9px]">
            {leadIsSlack ? (
              <SlackMark size={16} />
            ) : (
              <PlusCircle className="text-primary" />
            )}
            <span className="text-[13px] font-medium">
              {leadIsSlack
                ? t(
                    ($) => {
                      return $.chat.agentPage.growth.addInSlack;
                    },
                    { assistantName },
                  )
                : t(($) => {
                    return $.chat.agentPage.growth.inviteMember;
                  })}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="mx-[9px] h-4 w-[0.7px] shrink-0 bg-[hsl(var(--gray-300))]"
          />
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[268px]">
        <DropdownMenuItem
          className="gap-3 px-3 py-2.5"
          onClick={openWorks}
          data-testid="growth-slack"
        >
          <SlackMark size={16} />
          <span className="min-w-0 flex-1 truncate">
            {slackInstalled
              ? t(
                  ($) => {
                    return $.chat.agentPage.growth.inSlack;
                  },
                  { assistantName },
                )
              : t(
                  ($) => {
                    return $.chat.agentPage.growth.addInSlack;
                  },
                  { assistantName },
                )}
          </span>
          {slackInstalled ? (
            <Check className="shrink-0 text-[#2EB67D]" />
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.agentPage.growth.connect;
              })}
            </span>
          )}
        </DropdownMenuItem>

        <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={openWorks}>
          <MessageSquare className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {t(($) => {
              return $.chat.agentPage.growth.otherChannels;
            })}
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuModalItem
          className="gap-3 px-3 py-2.5"
          onModalSelect={openInvite}
          data-testid="growth-invite"
        >
          <PlusCircle className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {t(($) => {
              return $.chat.agentPage.growth.inviteMember;
            })}
          </span>
        </DropdownMenuModalItem>

        {creditsRequested ? (
          <GrowthCreditMenuItem openCredits={openCredits} />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function GrowthEntryHeader() {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  if (!isAdmin) {
    return null;
  }
  return (
    <header className="hidden shrink-0 bg-transparent px-4 pb-2 pt-4 md:block sm:px-6">
      <div className="mx-auto flex w-full max-w-[900px] items-center justify-end gap-2">
        <GrowthEntry />
      </div>
    </header>
  );
}
