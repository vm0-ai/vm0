import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core";
import { Check, ChevronDown, Coins, PlusCircle, UserPlus } from "lucide-react";
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
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { slackOrgData$ } from "../../signals/okou-page/slack.ts";
import {
  billingStatusAsync$,
  usagePackCreditsAsync$,
} from "../../signals/okou-page/billing.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const slackIconImg = settingsIconAssetUrl("slack");
const telegramIconImg = settingsIconAssetUrl("telegram");

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
function useSlackInstalled(): boolean | null {
  const loadable = useLastLoadable(slackOrgData$);
  if (loadable.state !== "hasData") {
    return null;
  }
  return loadable.data.isInstalled || loadable.data.isConnected;
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
  if (orgCredits === null || packCredits === null) {
    return null;
  }
  return formatLocalizedNumber(orgCredits + packCredits);
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

function CombinedCreditMenuItem({ openCredits }: { openCredits: () => void }) {
  const creditLabel = useCombinedCreditLabel();
  return <CreditMenuItem creditLabel={creditLabel} openCredits={openCredits} />;
}

function GrowthCreditMenuItem({ openCredits }: { openCredits: () => void }) {
  return <CombinedCreditMenuItem openCredits={openCredits} />;
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
function GrowthEntry({ slackInstalled }: { slackInstalled: boolean }) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const { openWorks, openInvite, openCredits } = useGrowthActions();

  const leadIsSlack = !slackInstalled;

  return (
    <DropdownMenu>
      <div
        // 12px, not the Button default 8px: the split control and the menu it
        // opens read as one object when their outer radii agree.
        className="inline-flex h-8 items-stretch rounded-[12px] border-[0.7px] border-[hsl(var(--gray-400))] bg-card shadow-[var(--zero-card-shadow)]"
      >
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="h-full gap-[9px] rounded-l-[11px] rounded-r-none px-[11px] pr-[9px] text-foreground"
          onClick={leadIsSlack ? openWorks : openInvite}
          data-testid="growth-entry"
        >
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
        </Button>

        <DropdownMenuTrigger asChild>
          <Button
            showTooltip
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-label={t(($) => {
              return $.chat.actions.more;
            })}
            className="h-full w-9 rounded-l-none rounded-r-[11px] border-l-[0.7px] border-[hsl(var(--gray-300))] data-popup-open:bg-state-hover data-popup-open:text-foreground"
            data-testid="growth-entry-menu"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
      </div>

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
          <img src={telegramIconImg} alt="" className="h-4 w-4 shrink-0" />
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

        {/* Content is unmounted while closed, so credit requests stay lazy. */}
        <GrowthCreditMenuItem openCredits={openCredits} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InviteButton({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const openSettings = useSet(openSettingsDialogAt$);
  const handleInvite = () => {
    detach(openSettings("people", pageSignal), Reason.DomCallback);
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleInvite}
      className={`zero-btn-morandi gap-1.5${isAdmin ? "" : " invisible"}`}
      aria-hidden={isAdmin ? undefined : "true"}
      tabIndex={isAdmin ? undefined : -1}
      data-testid="invite-button"
    >
      <UserPlus size={14} />
      {t(($) => {
        return $.chat.agentPage.invitePeople;
      })}
    </Button>
  );
}

/**
 * The corner both entries sit in.
 *
 * The row spans the page rather than the 900px content column, so the entry
 * lands in the top-right corner — the position the invite button has always
 * held, and the one the menu's `align="end"` is drawn against.
 */
function CornerHeader({ children }: { children: ReactNode }) {
  return (
    <header className="hidden shrink-0 bg-transparent px-4 pb-2 pt-4 md:block sm:px-6">
      <div className="flex items-center justify-end gap-2">{children}</div>
    </header>
  );
}

function InviteHeader({ isAdmin }: { isAdmin: boolean }) {
  return (
    <CornerHeader>
      <InviteButton isAdmin={isAdmin} />
    </CornerHeader>
  );
}

function EnabledGrowthEntryHeader() {
  const slackInstalled = useSlackInstalled();
  if (slackInstalled === null) {
    return null;
  }
  return (
    <CornerHeader>
      <GrowthEntry slackInstalled={slackInstalled} />
    </CornerHeader>
  );
}

export function GrowthEntryHeader() {
  const features = useLastResolved(featureSwitch$);
  const growthEntryEnabled =
    features?.[FeatureSwitchKey.HomeGrowthEntry] ?? false;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  if (!growthEntryEnabled) {
    return <InviteHeader isAdmin={isAdmin} />;
  }
  if (!isAdmin) {
    return null;
  }
  return <EnabledGrowthEntryHeader />;
}
