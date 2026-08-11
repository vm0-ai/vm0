import type { ReactNode } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { OrgMember } from "@vm0/api-contracts/contracts/org-members";
import type { UsagePackCreditsResponse } from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { ChevronDown, History, Users } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import {
  CreditAdditionList,
  CreditBalanceCard,
  formatCreditDate,
  type CreditAddition,
} from "../../org-manage/org-usage-tab.tsx";
import {
  PersonalUsageRecord,
  TeamUsageRecord,
  UsageRangeSelect,
} from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { orgMembers$ } from "../../../../../signals/external/org-members.ts";
import { usagePackCreditsAsync$ } from "../../../../../signals/zero-page/billing.ts";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { setBillingSubPage$ } from "../../../../../signals/zero-page/settings/workspace-settings-state.ts";
import {
  creditBalanceTab$,
  myUsageRange$,
  setCreditBalanceTab$,
  setMyUsageRange$,
  setTeamUsageRange$,
  setUsagePackMembersDialogOpen$,
  teamUsageRange$,
  toggleUsagePackMemberAdditions$,
  type CreditBalanceTab,
  usagePackMemberAdditionsExpandedMemberId$,
  usagePackMembersDialogOpen$,
} from "../../../../../signals/zero-page/settings/personal-usage-record.ts";
import { formatLocalizedNumber } from "../../../../../i18n/format.ts";

interface UsagePackSegment {
  readonly key: "purchased" | "bonus";
  readonly credits: number;
  readonly label: string;
  readonly color: string;
  readonly expiresAt: string | undefined;
}

type UsagePackMemberCredit = NonNullable<
  UsagePackCreditsResponse["memberCredits"]
>[number];

function earliestExpiry(
  data: UsagePackCreditsResponse,
  grantType: UsagePackSegment["key"],
): string | undefined {
  return data.creditGrants
    .filter((grant) => {
      return grant.grantType === grantType;
    })
    .map((grant) => {
      return grant.expiresAt;
    })
    .sort()[0];
}

function usagePackSegments(
  data: UsagePackCreditsResponse,
  purchasedLabel: string,
  bonusLabel: string,
): readonly UsagePackSegment[] {
  const segments: readonly UsagePackSegment[] = [
    {
      key: "purchased",
      credits: data.purchasedCredits,
      label: purchasedLabel,
      color: "bg-credit-plan-pro",
      expiresAt: earliestExpiry(data, "purchased"),
    },
    {
      key: "bonus",
      credits: data.bonusCredits,
      label: bonusLabel,
      color: "bg-credit-promotional",
      expiresAt: earliestExpiry(data, "bonus"),
    },
  ];
  return segments.filter((segment) => {
    return segment.credits > 0;
  });
}

function usagePackCreditAdditions(
  data: UsagePackCreditsResponse,
  purchasedLabel: string,
  bonusLabel: string,
): readonly CreditAddition[] {
  return data.creditGrants.map((grant) => {
    return {
      ...grant,
      label: grant.grantType === "purchased" ? purchasedLabel : bonusLabel,
    };
  });
}

function UsagePackMemberCreditAdditionRows({
  grants,
  testIdPrefix,
}: {
  grants: readonly CreditAddition[];
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="divide-y divide-border/60">
      {grants.map((grant) => {
        const hasPartialBalance = grant.remaining !== grant.amount;
        return (
          <div
            key={grant.id}
            data-testid={`${testIdPrefix}-${grant.id}`}
            className="grid grid-cols-[minmax(0,1fr)_minmax(180px,0.8fr)_minmax(110px,auto)] items-center gap-x-6 px-4 py-2.5 transition-colors hover:bg-state-hover/60"
          >
            <span className="truncate text-xs font-medium text-foreground">
              {grant.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(
                ($) => {
                  return $.billing.usage.added;
                },
                { date: formatCreditDate(grant.createdAt) },
              )}
            </span>
            <div className="text-right">
              <div className="text-xs font-medium tabular-nums text-foreground">
                +{formatLocalizedNumber(grant.amount)}
              </div>
              {hasPartialBalance ? (
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  {t(
                    ($) => {
                      return $.billing.usage.left;
                    },
                    { value: formatLocalizedNumber(grant.remaining) },
                  )}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UsagePackSegmentBar({
  segments,
  testIdPrefix,
  totalCredits,
}: {
  segments: readonly UsagePackSegment[];
  testIdPrefix: string;
  totalCredits: number;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={100}>
      <div
        data-testid={`${testIdPrefix}-bar`}
        className="flex h-2.5 w-full rounded-full bg-muted/40"
      >
        {segments.map((segment) => {
          return (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                <div
                  data-testid={`${testIdPrefix}-${segment.key}`}
                  className={`h-2.5 ${segment.color} cursor-default first:rounded-l-full last:rounded-r-full ring-0 hover:ring-2 hover:ring-foreground/30 hover:z-10 transition-shadow`}
                  style={{
                    width: `${(segment.credits / totalCredits) * 100}%`,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                style={{
                  backgroundColor: "hsl(var(--popover))",
                  color: "hsl(var(--popover-foreground))",
                }}
                className="border shadow-md"
              >
                <div className="font-medium text-foreground">
                  {segment.label} — {formatLocalizedNumber(segment.credits)}
                </div>
                {segment.expiresAt ? (
                  <div className="mt-0.5 text-muted-foreground">
                    {t(
                      ($) => {
                        return $.billing.usage.expires;
                      },
                      { date: formatCreditDate(segment.expiresAt) },
                    )}
                  </div>
                ) : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function UsagePackCreditDetails({
  data,
  testIdPrefix = "usage-pack-credit",
}: {
  data: UsagePackCreditsResponse;
  testIdPrefix?: string;
}) {
  const { t } = useTranslation();
  const purchasedLabel = t(($) => {
    return $.billing.usage.usagePack.purchased;
  });
  const bonusLabel = t(($) => {
    return $.billing.usage.usagePack.bonus;
  });
  const segments = usagePackSegments(data, purchasedLabel, bonusLabel);
  const additions = usagePackCreditAdditions(data, purchasedLabel, bonusLabel);

  return (
    <>
      {data.totalCredits > 0 && segments.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          <UsagePackSegmentBar
            segments={segments}
            testIdPrefix={testIdPrefix}
            totalCredits={data.totalCredits}
          />
          {segments.length > 0 ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {segments.map((segment) => {
                return (
                  <div
                    key={segment.key}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${segment.color}`}
                    />
                    <span>{segment.label}</span>
                    <span className="tabular-nums">
                      {formatLocalizedNumber(segment.credits)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      <CreditAdditionList
        grants={additions}
        testIdPrefix={`${testIdPrefix}-grants`}
      />
    </>
  );
}

function UsagePackCreditTitle() {
  const { t } = useTranslation();
  return (
    <p className="text-sm font-medium text-foreground">
      {t(($) => {
        return $.billing.usage.usagePack.title;
      })}
    </p>
  );
}

function UsagePackCreditHeader({
  action,
  totalCredits,
}: {
  action?: ReactNode;
  totalCredits: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <UsagePackCreditTitle />
        {action}
      </div>
      <p className="text-sm font-medium tabular-nums text-foreground">
        {formatLocalizedNumber(totalCredits)}
      </p>
    </div>
  );
}

function usagePackMemberName(member: OrgMember): string {
  const fullName = [member.firstName, member.lastName]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join(" ");
  return fullName || member.email;
}

function usagePackNextExpiry(
  credits: UsagePackCreditsResponse,
): string | undefined {
  return credits.creditGrants
    .map((grant) => {
      return grant.expiresAt;
    })
    .sort()[0];
}

function emptyMemberCredits(memberId: string): UsagePackMemberCredit {
  return {
    memberId,
    totalCredits: 0,
    purchasedCredits: 0,
    bonusCredits: 0,
    creditGrants: [],
  };
}

interface UsagePackMemberRow {
  readonly member: OrgMember;
  readonly credits: UsagePackMemberCredit;
}

function UsagePackMemberSummary({
  rows,
}: {
  rows: readonly UsagePackMemberRow[];
}) {
  const { t } = useTranslation();
  const totalRemaining = rows.reduce((sum, row) => {
    return sum + row.credits.totalCredits;
  }, 0);
  const totalAdditions = rows.reduce((sum, row) => {
    return sum + row.credits.creditGrants.length;
  }, 0);
  const metrics = [
    {
      label: t(($) => {
        return $.billing.usage.usagePack.members;
      }),
      value: rows.length,
    },
    {
      label: t(($) => {
        return $.billing.usage.usagePack.totalRemaining;
      }),
      value: totalRemaining,
    },
    {
      label: t(($) => {
        return $.billing.usage.creditAdditions;
      }),
      value: totalAdditions,
    },
  ];
  return (
    <div
      data-testid="usage-pack-member-summary"
      className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs"
    >
      {metrics.map((metric) => {
        return (
          <div key={metric.label} className="flex items-baseline gap-1.5">
            <span className="font-semibold tabular-nums text-foreground">
              {formatLocalizedNumber(metric.value)}
            </span>
            <span className="text-muted-foreground">{metric.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function UsagePackMemberTableRow({ row }: { row: UsagePackMemberRow }) {
  const { t } = useTranslation();
  const expandedMemberId = useGet(usagePackMemberAdditionsExpandedMemberId$);
  const toggleExpanded = useSet(toggleUsagePackMemberAdditions$);
  const { member, credits } = row;
  const name = usagePackMemberName(member);
  const nextExpiry = usagePackNextExpiry(credits);
  const testIdPrefix = `usage-pack-member-${member.userId}`;
  const creditAdditionsLabel = t(($) => {
    return $.billing.usage.creditAdditions;
  });
  const grants = usagePackCreditAdditions(
    credits,
    t(($) => {
      return $.billing.usage.usagePack.purchased;
    }),
    t(($) => {
      return $.billing.usage.usagePack.bonus;
    }),
  );
  const expanded = expandedMemberId === member.userId;
  return (
    <>
      <TableRow
        data-state={expanded ? "selected" : undefined}
        data-testid={`usage-pack-member-credit-${member.userId}`}
      >
        <TableCell>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {name}
            </p>
            {name !== member.email ? (
              <p className="truncate text-xs text-muted-foreground">
                {member.email}
              </p>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="text-right font-semibold tabular-nums text-foreground">
          {formatLocalizedNumber(credits.totalCredits)}
        </TableCell>
        <TableCell className="text-right font-medium tabular-nums">
          {formatLocalizedNumber(credits.purchasedCredits)}
        </TableCell>
        <TableCell className="text-right font-medium tabular-nums">
          {formatLocalizedNumber(credits.bonusCredits)}
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {nextExpiry ? formatCreditDate(nextExpiry) : "—"}
        </TableCell>
        <TableCell className="text-right">
          {grants.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`${testIdPrefix}-grants-toggle`}
              className="h-7 gap-1.5 px-2 tabular-nums text-muted-foreground"
              aria-expanded={expanded}
              aria-label={`${creditAdditionsLabel}: ${grants.length}`}
              onClick={() => {
                toggleExpanded(member.userId);
              }}
            >
              <History size={14} />
              {formatLocalizedNumber(grants.length)}
              <ChevronDown
                size={13}
                className={`transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </Button>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow
          data-testid={`${testIdPrefix}-grants-expanded-row`}
          className="bg-muted/15 hover:bg-muted/15"
        >
          <td colSpan={6} className="p-0 align-middle">
            <UsagePackMemberCreditAdditionRows
              grants={grants}
              testIdPrefix={`${testIdPrefix}-grants`}
            />
          </td>
        </TableRow>
      ) : null}
    </>
  );
}

function UsagePackMemberTable({
  rows,
}: {
  rows: readonly UsagePackMemberRow[];
}) {
  const { t } = useTranslation();
  return (
    <Table className="min-w-[920px]">
      <TableHeader className="sticky top-0 z-10 bg-muted/70">
        <TableRow>
          <TableHead className="w-[23%]">
            {t(($) => {
              return $.billing.usage.member;
            })}
          </TableHead>
          <TableHead className="w-[16%] text-right">
            {t(($) => {
              return $.billing.usage.usagePack.remaining;
            })}
          </TableHead>
          <TableHead className="w-[14%] text-right">
            {t(($) => {
              return $.billing.usage.usagePack.purchased;
            })}
          </TableHead>
          <TableHead className="w-[11%] text-right">
            {t(($) => {
              return $.billing.usage.usagePack.bonus;
            })}
          </TableHead>
          <TableHead className="w-[17%]">
            {t(($) => {
              return $.billing.usage.usagePack.nextExpiry;
            })}
          </TableHead>
          <TableHead className="w-[19%] whitespace-nowrap text-right">
            {t(($) => {
              return $.billing.usage.creditAdditions;
            })}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          return <UsagePackMemberTableRow key={row.member.userId} row={row} />;
        })}
      </TableBody>
    </Table>
  );
}

function UsagePackMemberBalances({
  memberCredits,
  members,
}: {
  memberCredits: NonNullable<UsagePackCreditsResponse["memberCredits"]>;
  members: readonly OrgMember[];
}) {
  const creditsByMember = new Map(
    memberCredits.map((credits) => {
      return [credits.memberId, credits] as const;
    }),
  );
  const rows = members.map((member) => {
    return {
      member,
      credits:
        creditsByMember.get(member.userId) ?? emptyMemberCredits(member.userId),
    };
  });
  return (
    <div>
      <UsagePackMemberSummary rows={rows} />
      <UsagePackMemberTable rows={rows} />
    </div>
  );
}

function UsagePackMemberBalancesDialog({
  memberCredits,
}: {
  memberCredits: NonNullable<UsagePackCreditsResponse["memberCredits"]>;
}) {
  const { t } = useTranslation();
  const membersLoadable = useLoadable(orgMembers$);
  const open = useGet(usagePackMembersDialogOpen$);
  const setOpen = useSet(setUsagePackMembersDialogOpen$);
  if (membersLoadable.state !== "hasData" || membersLoadable.data.length <= 1) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={t(($) => {
                return $.billing.usage.usagePack.viewMembers;
              })}
              onClick={() => {
                setOpen(true);
              }}
            >
              <Users size={15} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t(($) => {
              return $.billing.usage.usagePack.viewMembers;
            })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
        className="zero-app flex max-h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b border-border/70 px-6 pb-4 pt-6">
          <DialogTitle>
            {t(($) => {
              return $.billing.usage.usagePack.membersTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.billing.usage.usagePack.membersDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="usage-pack-members-dialog-scroll-area"
          className="min-h-0 overflow-y-auto px-6 py-5"
        >
          <UsagePackMemberBalances
            memberCredits={memberCredits}
            members={membersLoadable.data}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UsagePackCreditCard({ isAdmin }: { isAdmin: boolean }) {
  const creditsLoadable = useLoadable(usagePackCreditsAsync$);
  if (creditsLoadable.state === "hasError") {
    return null;
  }
  const data =
    creditsLoadable.state === "hasData" ? creditsLoadable.data : null;
  if (data?.hasUsagePack === false) {
    return null;
  }

  return (
    <div
      data-testid="usage-pack-credit-card"
      className="overflow-hidden rounded-xl bg-card px-5 py-4 zero-border"
    >
      {creditsLoadable.state === "loading" && !data ? (
        <div className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-muted/50" />
          <div className="h-2.5 w-full animate-pulse rounded-full bg-muted/40" />
        </div>
      ) : data ? (
        <>
          <UsagePackCreditHeader
            action={
              isAdmin && data.memberCredits !== undefined ? (
                <UsagePackMemberBalancesDialog
                  memberCredits={data.memberCredits}
                />
              ) : undefined
            }
            totalCredits={data.totalCredits}
          />
          <UsagePackCreditDetails data={data} />
        </>
      ) : null}
    </div>
  );
}

export function CreditBalanceSection() {
  const { t } = useTranslation();
  const setActiveSection = useSet(setSettingsActiveSection$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const tab = useGet(creditBalanceTab$);
  const setTab = useSet(setCreditBalanceTab$);
  const myRange = useGet(myUsageRange$);
  const teamRange = useGet(teamUsageRange$);
  const setMyRange = useSet(setMyUsageRange$);
  const setTeamRange = useSet(setTeamUsageRange$);
  const features = useLastResolved(featureSwitch$);
  const usagePackPlansEnabled =
    features?.[FeatureSwitchKey.UsagePackPlans] ?? false;

  const goToComparePlans = () => {
    setActiveSection("billing");
    setBillingSubPage(true);
  };

  // The credit balance card stays at the section level — above the
  // My usage / Team usage tabs — so it's always visible regardless of the
  // active tab.
  const creditCard = <CreditBalanceCard onComparePlans={goToComparePlans} />;
  const usagePackCreditCard = usagePackPlansEnabled ? (
    <UsagePackCreditCard isAdmin={isAdmin} />
  ) : null;

  const activeRange = tab === "team" ? teamRange : myRange;
  const setActiveRange = tab === "team" ? setTeamRange : setMyRange;

  // Members only see credits assigned by their usage pack. Organization
  // balances and usage records remain available to organization admins.
  if (!isAdmin) {
    return <div>{usagePackCreditCard}</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      {usagePackCreditCard}
      {creditCard}
      <div className="flex flex-col gap-4">
        {/* One compact header row: tabs on the left, range filter on the right. */}
        <div className="flex items-center justify-between gap-3">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as CreditBalanceTab);
            }}
          >
            <TabsList>
              <TabsTrigger value="mine">
                {t(($) => {
                  return $.usage.records.myUsage;
                })}
              </TabsTrigger>
              <TabsTrigger value="team">
                {t(($) => {
                  return $.usage.records.teamUsage;
                })}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <UsageRangeSelect value={activeRange} onChange={setActiveRange} />
        </div>
        {tab === "mine" ? (
          <PersonalUsageRecord range={myRange} />
        ) : (
          <TeamUsageRecord range={teamRange} />
        )}
      </div>
    </div>
  );
}
