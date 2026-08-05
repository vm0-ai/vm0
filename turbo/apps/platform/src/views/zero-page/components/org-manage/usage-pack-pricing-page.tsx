import { IconArrowLeft, IconCheck, IconCrown } from "@tabler/icons-react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";
import {
  setUsagePackSelection$,
  USAGE_PACKS_USD,
  usagePackSelection$,
  type UsagePackPlanTier,
  type UsagePackUsd,
} from "../../../../signals/zero-page/settings/usage-pack-pricing-state.ts";
import { planProImg, planTeamImg } from "../../platform-assets.ts";

const CREDITS_PER_DOLLAR = 1000;

interface UsagePackPlan {
  readonly tier: UsagePackPlanTier;
  readonly basePriceUsd: number;
  readonly image: string;
  readonly popular: boolean;
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

function UsagePackOption({
  dollars,
  onSelect,
  selected,
}: {
  readonly dollars: UsagePackUsd;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) {
  const credits = dollars * CREDITS_PER_DOLLAR;
  const monthlyCredits = i18n.t(
    ($) => {
      return $.billing.plans.features.monthlyCredits;
    },
    { value: formatLocalizedNumber(credits) },
  );
  return (
    <button
      type="button"
      aria-label={`${formatUsd(dollars, 0)} ${monthlyCredits}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex min-w-0 flex-col rounded-xl bg-gray-50 px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border border-primary ring-2 ring-primary/20"
          : "zero-border hover:border-muted-foreground/30"
      }`}
    >
      <span className="text-sm font-semibold text-foreground">
        {formatUsd(dollars, 0)}
      </span>
      <span className="mt-0.5 truncate text-[12px] text-muted-foreground">
        {monthlyCredits}
      </span>
    </button>
  );
}

function UsagePackSelector({
  onSelect,
  plan,
  selected,
}: {
  readonly onSelect: (pack: UsagePackUsd) => void;
  readonly plan: UsagePackPlanTier;
  readonly selected: UsagePackUsd;
}) {
  const label = i18n.t(($) => {
    return $.billing.plans.usagePacks.monthlyUsagePack;
  });
  return (
    <div className="mt-6">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <span className="rounded-lg px-2 py-0.5 text-xs text-muted-foreground zero-badge">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.required;
          })}
        </span>
      </div>
      <div
        className="grid grid-cols-2 gap-2.5"
        role="group"
        aria-label={`${planName(plan)}: ${label}`}
      >
        {USAGE_PACKS_USD.map((pack) => {
          return (
            <UsagePackOption
              key={pack}
              dollars={pack}
              selected={selected === pack}
              onSelect={() => {
                onSelect(pack);
              }}
            />
          );
        })}
      </div>
    </div>
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

function UsagePackPlanCard({ plan }: { readonly plan: UsagePackPlan }) {
  const usagePackSelection = useGet(usagePackSelection$);
  const setUsagePackSelection = useSet(setUsagePackSelection$);
  const usagePackUsd = usagePackSelection[plan.tier];
  const name = planName(plan.tier);
  const totalUsd = plan.basePriceUsd + usagePackUsd;
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
              return $.billing.plans.usagePacks.baseAndPack;
            },
            {
              base: formatUsd(plan.basePriceUsd, 0),
              pack: formatUsd(usagePackUsd, 0),
            },
          )}
        </p>
      </div>

      <UsagePackSelector
        plan={plan.tier}
        selected={usagePackUsd}
        onSelect={(pack) => {
          setUsagePackSelection({ plan: plan.tier, pack });
        }}
      />
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
          return <UsagePackPlanCard key={plan.tier} plan={plan} />;
        })}
      </div>
    </div>
  );
}
