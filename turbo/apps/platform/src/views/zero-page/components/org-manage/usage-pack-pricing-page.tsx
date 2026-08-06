import {
  IconArrowLeft,
  IconCheck,
  IconCrown,
  IconPlus,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";
import { currentUserInfo$ } from "../../../../signals/auth.ts";
import {
  orgMembers$,
  type OrgMember,
} from "../../../../signals/external/org-members.ts";
import {
  addMemberUsageConfiguration$,
  memberUsageSelections$,
  PAY_AS_YOU_GO,
  removeMemberUsageConfiguration$,
  setMemberUsageSelection$,
  USAGE_PACKS_USD,
  type MemberUsageSelection,
  type UsagePackUsd,
} from "../../../../signals/zero-page/settings/usage-pack-pricing-state.ts";
import { planProImg, planTeamImg } from "../../platform-assets.ts";

const CREDITS_PER_DOLLAR = 1000;

const USAGE_PACK_PRICE_PERCENT: Readonly<Record<UsagePackUsd, number>> = {
  20: 98,
  50: 95,
  100: 92,
  200: 90,
};

type UsagePackPlanTier = "pro" | "team";

interface UsagePackPlan {
  readonly tier: UsagePackPlanTier;
  readonly basePriceUsd: number;
  readonly image: string;
  readonly popular: boolean;
}

interface MemberDisplay {
  readonly id: string;
  readonly email: string | undefined;
  readonly imageUrl: string | undefined;
  readonly isCurrent: boolean;
  readonly name: string;
}

const USAGE_PACK_PLANS: readonly UsagePackPlan[] = [
  {
    tier: "pro",
    basePriceUsd: 0,
    image: planProImg,
    popular: true,
  },
  {
    tier: "team",
    basePriceUsd: 160,
    image: planTeamImg,
    popular: false,
  },
];

function planName(tier: UsagePackPlanTier): string {
  return tier === "pro"
    ? i18n.t(($) => {
        return $.billing.plans.pro.name;
      })
    : i18n.t(($) => {
        return $.billing.plans.team.name;
      });
}

function planDescription(tier: UsagePackPlanTier): string {
  return tier === "pro"
    ? i18n.t(($) => {
        return $.billing.plans.pro.description;
      })
    : i18n.t(($) => {
        return $.billing.plans.team.description;
      });
}

function planFeatures(tier: UsagePackPlanTier): readonly string[] {
  return [
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.twoConcurrentRuns;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.tenConcurrentRuns;
        }),
    i18n.t(($) => {
      return $.billing.plans.features.unlimitedAgents;
    }),
    i18n.t(($) => {
      return $.billing.plans.features.byok;
    }),
    i18n.t(($) => {
      return $.billing.plans.features.voiceInput;
    }),
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.emailSupport;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.prioritySupport;
        }),
  ];
}

function usagePackDetails(dollars: UsagePackUsd) {
  const baseCredits = dollars * CREDITS_PER_DOLLAR;
  const pricePercent = USAGE_PACK_PRICE_PERCENT[dollars];
  const rawCredits = (baseCredits * 100) / pricePercent;
  const credits = Math.round(rawCredits / 100) * 100;
  return {
    bonusCredits: credits - baseCredits,
    credits,
    discountPercent: 100 - pricePercent,
  };
}

function usageSelectionLabel(selection: MemberUsageSelection): string {
  if (selection === PAY_AS_YOU_GO) {
    return i18n.t(($) => {
      return $.billing.plans.usagePacks.payAsYouGo;
    });
  }
  const details = usagePackDetails(selection);
  return i18n.t(
    ($) => {
      return $.billing.plans.usagePacks.packOption;
    },
    {
      credits: formatLocalizedNumber(details.credits),
      discount: details.discountPercent,
      price: formatUsd(selection, 0),
    },
  );
}

function parseUsageSelection(value: string): MemberUsageSelection {
  if (value === PAY_AS_YOU_GO) {
    return PAY_AS_YOU_GO;
  }
  const pack = USAGE_PACKS_USD.find((candidate) => {
    return String(candidate) === value;
  });
  if (pack === undefined) {
    throw new Error(`Unknown member usage selection: ${value}`);
  }
  return pack;
}

function memberName(member: OrgMember): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return name || member.email;
}

function MemberIdentity({ member }: { readonly member: MemberDisplay }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground">
        {member.imageUrl ? (
          <img
            src={member.imageUrl}
            alt={member.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <IconUser size={15} stroke={1.8} />
        )}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {member.name}
          </span>
          {member.isCurrent && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground zero-badge">
              {i18n.t(($) => {
                return $.settings.workspace.members.you;
              })}
            </span>
          )}
        </span>
        {member.email && member.email !== member.name && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {member.email}
          </span>
        )}
      </span>
    </div>
  );
}

function MemberUsageRow({
  member,
  onRemove,
  onSelect,
  selection,
}: {
  readonly member: MemberDisplay;
  readonly onRemove: (() => void) | undefined;
  readonly onSelect: (selection: MemberUsageSelection) => void;
  readonly selection: MemberUsageSelection;
}) {
  const summary =
    selection === PAY_AS_YOU_GO
      ? i18n.t(($) => {
          return $.billing.plans.usagePacks.payAsYouGoDescription;
        })
      : i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.bonusCredits;
          },
          {
            value: formatLocalizedNumber(
              usagePackDetails(selection).bonusCredits,
            ),
          },
        );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(15rem,18rem)_2rem] items-center gap-3 px-4 py-3">
      <MemberIdentity member={member} />
      <div className="min-w-0">
        <Select
          value={String(selection)}
          onValueChange={(value) => {
            onSelect(parseUsageSelection(value));
          }}
        >
          <SelectTrigger
            className="h-9 w-full bg-background text-xs"
            aria-label={i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.selectUsage;
              },
              { name: member.name },
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PAY_AS_YOU_GO}>
              {usageSelectionLabel(PAY_AS_YOU_GO)}
            </SelectItem>
            {USAGE_PACKS_USD.map((pack) => {
              return (
                <SelectItem key={pack} value={String(pack)}>
                  {usageSelectionLabel(pack)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <p className="mt-1 truncate text-[10px] text-muted-foreground">
          {summary}
        </p>
      </div>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={i18n.t(
            ($) => {
              return $.billing.plans.usagePacks.removeMember;
            },
            { name: member.name },
          )}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconX size={15} stroke={1.8} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function MemberUsageHeader({
  usagePackTotalUsd,
}: {
  readonly usagePackTotalUsd: number;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.memberUsage;
          })}
        </h4>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.description;
          })}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.memberUsageTotal;
          })}
        </p>
        <p className="mt-0.5 text-sm font-semibold text-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.pricePerMonth;
            },
            { price: formatUsd(usagePackTotalUsd, 0) },
          )}
        </p>
      </div>
    </div>
  );
}

function AddMemberUsageConfiguration({
  eligibleMembers,
  onAdd,
}: {
  readonly eligibleMembers: readonly OrgMember[];
  readonly onAdd: (memberId: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/60 px-4 py-3">
      <p className="text-[11px] text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.memberExclusive;
        })}
      </p>
      <Select
        value=""
        disabled={eligibleMembers.length === 0}
        onValueChange={onAdd}
      >
        <SelectTrigger
          className="h-8 w-auto min-w-32 gap-1.5 border-dashed text-xs"
          aria-label={i18n.t(($) => {
            return $.billing.plans.usagePacks.addMember;
          })}
        >
          <IconPlus size={13} stroke={1.8} />
          <SelectValue
            placeholder={i18n.t(($) => {
              return $.billing.plans.usagePacks.addMember;
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {eligibleMembers.map((member) => {
            return (
              <SelectItem key={member.userId} value={member.userId}>
                {memberName(member)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function MemberUsageConfiguration() {
  const userLoadable = useLastLoadable(currentUserInfo$);
  const membersLoadable = useLastLoadable(orgMembers$);
  const selections = useGet(memberUsageSelections$);
  const addMember = useSet(addMemberUsageConfiguration$);
  const removeMember = useSet(removeMemberUsageConfiguration$);
  const setSelection = useSet(setMemberUsageSelection$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const orgMembers =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];

  if (!user) {
    return <div className="h-36 animate-pulse rounded-xl bg-muted/40" />;
  }

  const currentMember: MemberDisplay = {
    id: user.id,
    email: user.primaryEmailAddress?.emailAddress,
    imageUrl: user.imageUrl,
    isCurrent: true,
    name:
      user.fullName ??
      user.primaryEmailAddress?.emailAddress ??
      i18n.t(($) => {
        return $.billing.plans.usagePacks.currentMember;
      }),
  };
  const orgMembersById = new Map(
    orgMembers.map((member) => {
      return [member.userId, member] as const;
    }),
  );
  const configuredMembers = Object.keys(selections)
    .filter((memberId) => {
      return memberId !== user.id && orgMembersById.has(memberId);
    })
    .map((memberId): MemberDisplay => {
      const member = orgMembersById.get(memberId);
      if (!member) {
        throw new Error(`Configured member not found: ${memberId}`);
      }
      return {
        id: member.userId,
        email: member.email,
        imageUrl: member.imageUrl,
        isCurrent: false,
        name: memberName(member),
      };
    });
  const eligibleMembers = orgMembers.filter((member) => {
    return member.userId !== user.id && selections[member.userId] === undefined;
  });
  const configuredSelections = [
    selections[user.id] ?? 20,
    ...configuredMembers.map((member) => {
      return selections[member.id] ?? 20;
    }),
  ];
  const usagePackTotalUsd = configuredSelections.reduce((total, selection) => {
    return total + (selection === PAY_AS_YOU_GO ? 0 : selection);
  }, 0);
  const memberUsageLabel = i18n.t(($) => {
    return $.billing.plans.usagePacks.memberUsage;
  });

  return (
    <section
      role="group"
      aria-label={memberUsageLabel}
      className="rounded-xl bg-card zero-border"
    >
      <MemberUsageHeader usagePackTotalUsd={usagePackTotalUsd} />

      <MemberUsageRow
        member={currentMember}
        selection={selections[user.id] ?? 20}
        onSelect={(usage) => {
          setSelection({ memberId: user.id, usage });
        }}
        onRemove={undefined}
      />
      {configuredMembers.map((member) => {
        return (
          <div key={member.id} className="border-t border-border/50">
            <MemberUsageRow
              member={member}
              selection={selections[member.id] ?? 20}
              onSelect={(usage) => {
                setSelection({ memberId: member.id, usage });
              }}
              onRemove={() => {
                removeMember(member.id);
              }}
            />
          </div>
        );
      })}

      <AddMemberUsageConfiguration
        eligibleMembers={eligibleMembers}
        onAdd={addMember}
      />
    </section>
  );
}

function PlanFeatureList({ tier }: { readonly tier: UsagePackPlanTier }) {
  return (
    <ul className="my-6 flex flex-col gap-2.5">
      {planFeatures(tier).map((feature) => {
        return (
          <li key={feature} className="flex items-center gap-2">
            <IconCheck
              size={14}
              stroke={1.8}
              className="shrink-0 text-muted-foreground/50"
            />
            <span className="text-[13px] text-muted-foreground">{feature}</span>
          </li>
        );
      })}
    </ul>
  );
}

function UsagePackPlanCard({
  memberUsageTotalUsd,
  plan,
}: {
  readonly memberUsageTotalUsd: number;
  readonly plan: UsagePackPlan;
}) {
  const name = planName(plan.tier);
  const totalUsd = plan.basePriceUsd + memberUsageTotalUsd;
  return (
    <article
      aria-label={i18n.t(
        ($) => {
          return $.billing.plans.namedPlan;
        },
        { plan: name },
      )}
      className="relative flex flex-col rounded-xl bg-card px-6 py-7 zero-border"
    >
      {plan.popular && (
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconCrown size={12} stroke={1.8} className="text-amber-500" />
          {i18n.t(($) => {
            return $.billing.plans.popular;
          })}
        </span>
      )}

      <img
        src={plan.image}
        alt=""
        loading="lazy"
        className="mb-2 h-20 w-20 object-contain"
      />
      <h3 className="text-base font-semibold text-foreground">{name}</h3>
      <p className="mt-1 min-h-[42px] text-[13px] leading-relaxed text-muted-foreground">
        {planDescription(plan.tier)}
      </p>

      <div className="mt-5">
        <p className="text-[12px] text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.monthlyTotal;
          })}
        </p>
        <p className="mt-1 text-3xl font-light tracking-tight text-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.pricePerMonth;
            },
            { price: formatUsd(totalUsd, 0) },
          )}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.usagePacks.baseAndMemberUsage;
            },
            {
              base: formatUsd(plan.basePriceUsd, 0),
              usage: formatUsd(memberUsageTotalUsd, 0),
            },
          )}
        </p>
      </div>

      <PlanFeatureList tier={plan.tier} />
      <Button className="mt-auto h-11 w-full text-sm font-medium" disabled>
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.checkoutComingSoon;
        })}
      </Button>
    </article>
  );
}

export function UsagePackPricingPage({
  onBack,
}: {
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const userLoadable = useLastLoadable(currentUserInfo$);
  const selections = useGet(memberUsageSelections$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const currentSelection = user ? (selections[user.id] ?? 20) : 20;
  const memberUsageTotalUsd = Object.entries(selections).reduce(
    (total, [memberId, selection]) => {
      if (memberId === user?.id || selection === PAY_AS_YOU_GO) {
        return total;
      }
      return total + selection;
    },
    currentSelection === PAY_AS_YOU_GO ? 0 : currentSelection,
  );

  return (
    <div
      className="flex flex-col gap-5 outline-none"
      role="group"
      tabIndex={-1}
      ref={(element) => {
        element?.focus();
      }}
    >
      <div className="flex items-center gap-3">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onBack}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={t(($) => {
                  return $.billing.common.back;
                })}
              >
                <IconArrowLeft size={16} stroke={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {t(($) => {
                  return $.billing.common.back;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.billing.plans.compare;
            })}
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {t(($) => {
              return $.billing.plans.usagePacks.description;
            })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {USAGE_PACK_PLANS.map((plan) => {
          return (
            <UsagePackPlanCard
              key={plan.tier}
              plan={plan}
              memberUsageTotalUsd={memberUsageTotalUsd}
            />
          );
        })}
      </div>

      <MemberUsageConfiguration />
    </div>
  );
}
