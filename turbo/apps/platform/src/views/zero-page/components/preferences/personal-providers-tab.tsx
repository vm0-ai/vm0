import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, EllipsisVertical, Plus } from "lucide-react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vm0/ui";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  activatePersonalOAuthCredentialAccount$,
  deletePersonalOAuthCredentialAccount$,
  disconnectPersonalOAuthCredential$,
  personalActionPromise$,
  personalConfiguredProviders$,
  resetPersonalCodexAccountSubscriptionUsage$,
  resetPersonalCodexSubscriptionUsage$,
  setSettingsCodexResetDialog$,
  settingsCodexResetDialog$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import { modelPlanCapabilities$ } from "../../../../signals/zero-page/model-plan-capabilities.ts";
import { openSettingsBillingPlans$ } from "../../../../signals/zero-page/settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "../../../../signals/zero-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "../../../../signals/zero-page/settings/codex-device-auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "../settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "../settings/codex-device-auth-dialog.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { formatSubscriptionUsageReset } from "../../subscription-usage-format.ts";
import {
  CodexResetUsageDialog,
  formatCodexResetCredits,
} from "./codex-reset-usage-dialog.tsx";

type OAuthStatus = "connected" | "stale" | "missing";
type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

export function PersonalProvidersTab() {
  return (
    <div className="flex flex-col gap-8">
      <OAuthCredentialsSection />
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </div>
  );
}

function PersonalModelsHeading() {
  const { t } = useTranslation();
  return (
    <SettingsSectionHeading
      title={t(($) => {
        return $.settings.models.personal.sectionTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.description;
      })}
    />
  );
}

function OAuthCredentialsSection() {
  const featureSwitches = useGet(featureSwitch$);
  return featureSwitches[FeatureSwitchKey.PersonalModelProviderAccounts] ? (
    <OAuthAccountGroupsSection />
  ) : (
    <LegacyOAuthCredentialsSection />
  );
}

const PERSONAL_ACCOUNT_PROVIDER_TYPES = [
  "claude-code-oauth-token",
  "codex-oauth-token",
] as const satisfies readonly ModelProviderType[];

function OAuthAccountGroupsSection() {
  const { t } = useTranslation();
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const modelCapabilitiesLoadable = useLastLoadable(modelPlanCapabilities$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openClaudeCodeDeviceAuthDialog = useSet(
    openClaudeCodeDeviceAuthDialogPersonal$,
  );
  const openCodexDeviceAuthDialog = useSet(openCodexDeviceAuthDialogPersonal$);
  const activateAccount = useSet(activatePersonalOAuthCredentialAccount$);
  const deleteAccount = useSet(deletePersonalOAuthCredentialAccount$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const pageSignal = useGet(pageSignal$);

  const isLoading =
    providersLoadable.state === "loading" ||
    modelCapabilitiesLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const supportByok =
    modelCapabilitiesLoadable.state !== "hasData" ||
    modelCapabilitiesLoadable.data.supportByok;
  const actionPending = actionLoadable.state === "loading";

  const openAccountAuth = (
    type: ModelProviderType,
    modelProviderId?: string,
  ) => {
    if (!supportByok) {
      openBillingPlans();
      return;
    }
    const args = modelProviderId
      ? { mode: "reconnect" as const, modelProviderId }
      : { mode: "connect" as const };
    const request =
      type === "codex-oauth-token"
        ? openCodexDeviceAuthDialog(args, pageSignal)
        : openClaudeCodeDeviceAuthDialog(args, pageSignal);
    detach(request, Reason.DomCallback);
  };

  return (
    <section className="flex flex-col gap-4">
      <PersonalModelsHeading />
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        {isLoading ? (
          <>
            <OAuthCredentialRowSkeleton />
            <OAuthCredentialRowSkeleton />
          </>
        ) : (
          PERSONAL_ACCOUNT_PROVIDER_TYPES.map((type) => {
            return (
              <OAuthAccountGroup
                key={type}
                type={type}
                accounts={providers.filter((provider) => {
                  return provider.type === type;
                })}
                actionPending={actionPending}
                actionLabel={
                  supportByok
                    ? t(($) => {
                        return $.settings.models.personal.addAccount;
                      })
                    : t(($) => {
                        return $.settings.models.actions.upgradePro;
                      })
                }
                onAdd={() => {
                  openAccountAuth(type);
                }}
                onActivate={(id) => {
                  detach(activateAccount(id, pageSignal), Reason.DomCallback);
                }}
                onReconnect={(id) => {
                  openAccountAuth(type, id);
                }}
                onRemove={(id) => {
                  detach(deleteAccount(id, pageSignal), Reason.DomCallback);
                }}
                onReset={(account) => {
                  setResetDialog({
                    open: true,
                    resetCredits: account.subscriptionResetCredits ?? null,
                    accountId: account.id,
                  });
                }}
              />
            );
          })
        )}
      </div>
      <CodexResetDialogController
        actionPending={actionPending}
        mode="account"
      />
    </section>
  );
}

function OAuthAccountGroup({
  type,
  accounts,
  actionPending,
  actionLabel,
  onAdd,
  onActivate,
  onReconnect,
  onRemove,
  onReset,
}: {
  readonly type: ModelProviderType;
  readonly accounts: readonly ModelProviderResponse[];
  readonly actionPending: boolean;
  readonly actionLabel: string;
  readonly onAdd: () => void;
  readonly onActivate: (id: string) => void;
  readonly onReconnect: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onReset: (account: ModelProviderResponse) => void;
}) {
  const { t } = useTranslation();
  const isCodex = type === "codex-oauth-token";
  const title = isCodex
    ? t(($) => {
        return $.settings.models.personal.codexTitle;
      })
    : t(($) => {
        return $.settings.models.personal.claudeTitle;
      });
  const description = isCodex
    ? t(($) => {
        return $.settings.models.personal.codexDescription;
      })
    : t(($) => {
        return $.settings.models.personal.claudeDescription;
      });

  return (
    <div className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50">
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ProviderIcon type={type} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {title}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {description}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="zero-btn-morandi h-9 shrink-0 gap-1.5 rounded-lg border"
          disabled={actionPending || accounts.length >= 10}
          onClick={onAdd}
        >
          <Plus size={14} />
          {actionLabel}
        </Button>
      </div>
      {accounts.length === 0 ? (
        <p className="border-t border-border/50 px-5 py-4 text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.models.personal.noAccounts;
          })}
        </p>
      ) : (
        <div className="border-t border-border/50">
          {accounts.map((account, index) => {
            return (
              <OAuthAccountRow
                key={account.id}
                account={account}
                fallbackIndex={index + 1}
                actionPending={actionPending}
                onActivate={() => {
                  onActivate(account.id);
                }}
                onReconnect={() => {
                  onReconnect(account.id);
                }}
                onRemove={() => {
                  onRemove(account.id);
                }}
                onReset={() => {
                  onReset(account);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function OAuthAccountRow({
  account,
  fallbackIndex,
  actionPending,
  onActivate,
  onReconnect,
  onRemove,
  onReset,
}: {
  readonly account: ModelProviderResponse;
  readonly fallbackIndex: number;
  readonly actionPending: boolean;
  readonly onActivate: () => void;
  readonly onReconnect: () => void;
  readonly onRemove: () => void;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation();
  const usage = fallbackSubscriptionUsage(account);
  const identity =
    account.accountEmail ??
    account.workspaceName ??
    t(
      ($) => {
        return $.settings.models.personal.accountFallback;
      },
      { number: fallbackIndex },
    );
  const details = [
    account.workspaceName === identity ? null : account.workspaceName,
    formatSubscriptionPlan(account),
  ].filter((value): value is string => {
    return Boolean(value);
  });
  return (
    <div
      data-testid={`oauth-account-${account.id}`}
      className="px-5 py-3.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/40"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground enabled:hover:border-foreground/40 enabled:hover:text-foreground disabled:cursor-default"
          aria-label={
            account.isActive
              ? t(($) => {
                  return $.settings.models.personal.activeAccount;
                })
              : t(($) => {
                  return $.settings.models.personal.useAccount;
                })
          }
          aria-pressed={account.isActive}
          disabled={account.isActive || actionPending}
          onClick={onActivate}
        >
          {account.isActive ? <Check size={14} /> : null}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">
              {identity}
            </p>
            {account.isActive ? (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                {t(($) => {
                  return $.settings.models.personal.activeAccount;
                })}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {account.needsReconnect
              ? t(($) => {
                  return $.settings.models.personal.status.stale;
                })
              : details.join(" · ") ||
                t(($) => {
                  return $.settings.models.personal.status.connected;
                })}
          </p>
        </div>
        {!account.isActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 rounded-lg"
            disabled={actionPending}
            onClick={onActivate}
          >
            {t(($) => {
              return $.settings.models.personal.useAccount;
            })}
          </Button>
        ) : null}
        <OAuthAccountMenu
          account={account}
          actionPending={actionPending}
          onReconnect={onReconnect}
          onRemove={onRemove}
          onReset={onReset}
        />
      </div>
      {!account.needsReconnect && usageWindows(usage).length > 0 ? (
        <div className="mt-3 pl-10">
          <SubscriptionUsageMeter usage={usage} />
        </div>
      ) : null}
    </div>
  );
}

function OAuthAccountMenu({
  account,
  actionPending,
  onReconnect,
  onRemove,
  onReset,
}: {
  readonly account: ModelProviderResponse;
  readonly actionPending: boolean;
  readonly onReconnect: () => void;
  readonly onRemove: () => void;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation();
  const resetCredits = account.subscriptionResetCredits ?? null;
  const menuItems: OAuthMenuItem[] = [
    ...(account.type === "codex-oauth-token"
      ? [
          {
            kind: "status" as const,
            label: formatCodexResetCredits(resetCredits),
          },
          { kind: "separator" as const },
          {
            label: t(($) => {
              return $.settings.models.actions.resetUsage;
            }),
            disabled: actionPending || resetCredits === 0,
            onSelect: onReset,
            opensModal: true,
          },
        ]
      : []),
    {
      label: t(($) => {
        return $.settings.models.personal.reconnectAccount;
      }),
      disabled: actionPending,
      onSelect: onReconnect,
      opensModal: true,
    },
    ...(!account.isActive
      ? [
          {
            label: t(($) => {
              return $.settings.models.personal.removeAccount;
            }),
            disabled: actionPending,
            onSelect: onRemove,
          },
        ]
      : []),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label={t(($) => {
            return $.settings.shared.moreOptions;
          })}
        >
          <EllipsisVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {menuItems.map((item, index) => {
          const key =
            item.kind === "separator"
              ? `separator-${index}`
              : `${item.kind ?? "item"}-${item.label}`;
          return <OAuthMenuEntry key={key} item={item} />;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LegacyOAuthCredentialsSection() {
  const { t } = useTranslation();
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const modelCapabilitiesLoadable = useLastLoadable(modelPlanCapabilities$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openClaudeCodeDeviceAuthDialog = useSet(
    openClaudeCodeDeviceAuthDialogPersonal$,
  );
  const openCodexDeviceAuthDialog = useSet(openCodexDeviceAuthDialogPersonal$);
  const disconnectCredential = useSet(disconnectPersonalOAuthCredential$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const pageSignal = useGet(pageSignal$);

  const isLoading =
    providersLoadable.state === "loading" ||
    modelCapabilitiesLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const supportByok =
    modelCapabilitiesLoadable.state !== "hasData" ||
    modelCapabilitiesLoadable.data.supportByok;
  const claudeCode = findProvider(providers, "claude-code-oauth-token");
  const openAI = findProvider(providers, "codex-oauth-token");
  const openAIStatus = getOpenAIStatus(openAI);
  const actionPending = actionLoadable.state === "loading";
  const codexResetCredits = openAI?.subscriptionResetCredits ?? null;
  const providerActionLabel = supportByok
    ? t(($) => {
        return $.settings.shared.connect;
      })
    : t(($) => {
        return $.settings.models.actions.upgradePro;
      });

  const connectClaudeCode = () => {
    if (!supportByok) {
      openBillingPlans();
      return;
    }
    const mode = claudeCode?.needsReconnect ? "reconnect" : "connect";
    detach(
      openClaudeCodeDeviceAuthDialog({ mode }, pageSignal),
      Reason.DomCallback,
    );
  };
  const connectOpenAI = () => {
    if (!supportByok) {
      openBillingPlans();
      return;
    }
    const mode = openAI?.needsReconnect ? "reconnect" : "connect";
    detach(openCodexDeviceAuthDialog({ mode }, pageSignal), Reason.DomCallback);
  };

  return (
    <section className="flex flex-col gap-4">
      <PersonalModelsHeading />
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        {isLoading ? (
          <>
            <OAuthCredentialRowSkeleton />
            <OAuthCredentialRowSkeleton />
          </>
        ) : (
          <>
            <ClaudeOAuthCredentialRow
              actionPending={actionPending}
              actionLabel={providerActionLabel}
              provider={claudeCode}
              status={getOpenAIStatus(claudeCode)}
              onAction={connectClaudeCode}
              onDisconnect={() => {
                detach(
                  disconnectCredential("claude-code-oauth-token", pageSignal),
                  Reason.DomCallback,
                );
              }}
            />
            <CodexOAuthCredentialRow
              actionPending={actionPending}
              actionLabel={providerActionLabel}
              provider={openAI}
              resetCredits={codexResetCredits}
              status={openAIStatus}
              onAction={connectOpenAI}
              onDisconnect={() => {
                detach(
                  disconnectCredential("codex-oauth-token", pageSignal),
                  Reason.DomCallback,
                );
              }}
              onOpenReset={() => {
                setResetDialog({
                  open: true,
                  resetCredits: codexResetCredits,
                  accountId: null,
                });
              }}
            />
            <CodexResetDialogController
              actionPending={actionPending}
              mode="legacy"
            />
          </>
        )}
      </div>
    </section>
  );
}

function CodexResetDialogController({
  actionPending,
  mode,
}: {
  readonly actionPending: boolean;
  readonly mode: "account" | "legacy";
}) {
  const resetDialog = useGet(settingsCodexResetDialog$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const resetCodexAccount = useSet(resetPersonalCodexAccountSubscriptionUsage$);
  const resetCodexSubscriptionUsage = useSet(
    resetPersonalCodexSubscriptionUsage$,
  );
  const pageSignal = useGet(pageSignal$);

  const confirmReset = () => {
    const resetPromise =
      mode === "account"
        ? resetDialog.accountId
          ? resetCodexAccount(resetDialog.accountId, pageSignal)
          : null
        : resetCodexSubscriptionUsage(pageSignal);
    if (!resetPromise) {
      return;
    }
    detach(
      (async () => {
        await resetPromise;
        setResetDialog({
          open: false,
          resetCredits: null,
          accountId: null,
        });
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <CodexResetUsageDialog
      open={resetDialog.open}
      resetCredits={resetDialog.resetCredits}
      resetting={actionPending}
      onOpenChange={(open) => {
        setResetDialog({
          open,
          resetCredits: open ? resetDialog.resetCredits : null,
          accountId: open && mode === "account" ? resetDialog.accountId : null,
        });
      }}
      onConfirm={confirmReset}
    />
  );
}

function ClaudeOAuthCredentialRow({
  actionPending,
  actionLabel,
  provider,
  status,
  onAction,
  onDisconnect,
}: {
  actionPending: boolean;
  actionLabel: string;
  provider: ModelProviderResponse | undefined;
  status: OAuthStatus;
  onAction: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <OAuthCredentialRow
      type="claude-code-oauth-token"
      title={t(($) => {
        return $.settings.models.personal.claudeTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.claudeDescription;
      })}
      provider={provider}
      status={status}
      actionLabel={actionLabel}
      menuItems={
        provider
          ? [
              {
                label: t(($) => {
                  return $.settings.shared.replace;
                }),
                onSelect: onAction,
                opensModal: true,
              },
              {
                label: t(($) => {
                  return $.settings.shared.disconnect;
                }),
                disabled: actionPending,
                onSelect: onDisconnect,
              },
            ]
          : []
      }
      onAction={onAction}
      testId="oauth-card-claude-code-oauth-token"
    />
  );
}

function CodexOAuthCredentialRow({
  actionPending,
  actionLabel,
  provider,
  resetCredits,
  status,
  onAction,
  onDisconnect,
  onOpenReset,
}: {
  actionPending: boolean;
  actionLabel: string;
  provider: ModelProviderResponse | undefined;
  resetCredits: number | null;
  status: OAuthStatus;
  onAction: () => void;
  onDisconnect: () => void;
  onOpenReset: () => void;
}) {
  const { t } = useTranslation();
  const resetCreditLabel = formatCodexResetCredits(resetCredits);
  return (
    <OAuthCredentialRow
      type="codex-oauth-token"
      title={t(($) => {
        return $.settings.models.personal.codexTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.codexDescription;
      })}
      provider={provider}
      status={status}
      actionLabel={actionLabel}
      menuItems={
        provider
          ? [
              {
                kind: "status",
                label: resetCreditLabel,
              },
              {
                kind: "separator",
              },
              {
                label: t(($) => {
                  return $.settings.models.actions.resetUsage;
                }),
                disabled: actionPending || resetCredits === 0,
                onSelect: onOpenReset,
                opensModal: true,
              },
              {
                label: t(($) => {
                  return $.settings.shared.replace;
                }),
                onSelect: onAction,
                opensModal: true,
              },
              {
                label: t(($) => {
                  return $.settings.shared.disconnect;
                }),
                disabled: actionPending,
                onSelect: onDisconnect,
              },
            ]
          : []
      }
      onAction={onAction}
      testId="oauth-card-codex-oauth-token"
    />
  );
}

function findProvider(
  providers: ModelProviderResponse[],
  type: ModelProviderType,
): ModelProviderResponse | undefined {
  return providers.find((provider) => {
    return provider.type === type;
  });
}

function getOpenAIStatus(
  provider: ModelProviderResponse | undefined,
): OAuthStatus {
  if (provider?.needsReconnect) {
    return "stale";
  }
  return provider ? "connected" : "missing";
}

function formatSubscriptionPlan(
  provider: ModelProviderResponse,
): string | null {
  const plan = provider.planType?.trim();
  if (!plan) {
    return null;
  }
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatConnectedStatusDetail(
  provider: ModelProviderResponse,
): string | null {
  const details = [formatSubscriptionPlan(provider)].filter(
    (detail): detail is string => {
      return detail !== null;
    },
  );

  if (details.length === 0) {
    return null;
  }
  return details.join(", ");
}

function hasUsageWindow(
  window: SubscriptionUsage["fiveHour"],
): window is SubscriptionUsageWindow {
  return (
    window !== null &&
    (window.remainingPercent !== null ||
      window.usedPercent !== null ||
      window.resetAt !== null)
  );
}

function formatUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function fallbackSubscriptionUsage(
  provider: ModelProviderResponse,
): SubscriptionUsage | null {
  if (usageWindows(provider.subscriptionUsage).length > 0) {
    return provider.subscriptionUsage ?? null;
  }

  const resetAt = provider.subscriptionNextResetAt?.trim();
  if (!resetAt) {
    return null;
  }

  const resetPeriod = provider.subscriptionResetPeriod?.trim().toLowerCase();
  const window = {
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    windowSeconds: resetPeriod?.includes("5") ? 18_000 : 604_800,
  };

  return resetPeriod?.includes("5")
    ? { fiveHour: window, weekly: null }
    : { fiveHour: null, weekly: window };
}

function usageWindows(usage: SubscriptionUsage | null | undefined): readonly {
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
}[] {
  return [
    { kind: "fiveHour" as const, window: usage?.fiveHour ?? null },
    { kind: "week" as const, window: usage?.weekly ?? null },
  ].filter(
    (
      item,
    ): item is {
      kind: "fiveHour" | "week";
      window: SubscriptionUsageWindow;
    } => {
      return hasUsageWindow(item.window);
    },
  );
}

function usageTone(remainingPercent: number | null): {
  readonly barClassName: string;
  readonly textClassName: string;
  readonly trackClassName: string;
} {
  if (remainingPercent !== null && remainingPercent < 20) {
    return {
      barClassName: "bg-red-500",
      textClassName: "text-red-600 dark:text-red-400",
      trackClassName: "bg-red-500/15",
    };
  }
  if (remainingPercent !== null && remainingPercent < 50) {
    return {
      barClassName: "bg-amber-500",
      textClassName: "text-amber-600 dark:text-amber-400",
      trackClassName: "bg-amber-500/15",
    };
  }
  return {
    barClassName: "bg-emerald-500",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    trackClassName: "bg-emerald-500/15",
  };
}

function SubscriptionUsageMeter({
  usage,
}: {
  usage: SubscriptionUsage | null | undefined;
}) {
  const { t } = useTranslation();
  const windows = usageWindows(usage);

  if (windows.length === 0) {
    return null;
  }

  return (
    <div className="w-full rounded-lg bg-muted/30 px-3 py-2.5">
      <div className="space-y-2">
        {windows.map(({ kind, window }) => {
          const windowLabel =
            kind === "week"
              ? t(($) => {
                  return $.settings.models.personal.status.week;
                })
              : t(($) => {
                  return $.settings.models.personal.status.fiveHour;
                });
          const remainingPercent =
            window.remainingPercent ??
            (window.usedPercent === null ? null : 100 - window.usedPercent);
          const displayPercent = formatUsagePercent(remainingPercent);
          const reset = formatSubscriptionUsageReset(window.resetAt);
          const tone = usageTone(remainingPercent);
          return (
            <div key={kind} className="space-y-1">
              <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] leading-none">
                <span className="font-medium text-foreground">
                  {windowLabel}
                </span>
                {displayPercent ? (
                  <span className={`font-medium ${tone.textClassName}`}>
                    {t(
                      ($) => {
                        return $.settings.models.personal.status.left;
                      },
                      {
                        percent: displayPercent,
                      },
                    )}
                  </span>
                ) : null}
              </div>
              <div
                className={`h-1.5 overflow-hidden rounded-full ${tone.trackClassName}`}
              >
                <span
                  className={`block h-full rounded-full transition-[width] ${tone.barClassName}`}
                  style={{
                    width:
                      remainingPercent === null
                        ? "0%"
                        : `${Math.min(100, Math.max(0, remainingPercent))}%`,
                  }}
                />
              </div>
              {reset !== null ? (
                "fallbackText" in reset ? (
                  <div className="truncate text-[10px] leading-none text-muted-foreground">
                    {reset.fallbackText}
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center justify-between gap-2 text-[10px] leading-none text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {reset.absoluteResetText}
                    </span>
                    <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">
                      {reset.relativeText}
                    </span>
                  </div>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type OAuthMenuItem =
  | {
      readonly kind: "separator";
    }
  | {
      readonly kind: "status";
      readonly label: string;
    }
  | {
      readonly kind?: "item";
      readonly label: string;
      readonly disabled?: boolean;
      readonly onSelect?: () => void;
      readonly opensModal?: boolean;
    };

function OAuthMenuEntry({ item }: { item: OAuthMenuItem }) {
  if (item.kind === "separator") {
    return <DropdownMenuSeparator />;
  }
  if (item.kind === "status") {
    return (
      <DropdownMenuItem
        disabled
        className="text-xs text-muted-foreground data-[disabled]:opacity-100"
      >
        {item.label}
      </DropdownMenuItem>
    );
  }
  if (item.opensModal && item.onSelect) {
    return (
      <DropdownMenuModalItem
        disabled={item.disabled}
        onModalSelect={item.onSelect}
      >
        {item.label}
      </DropdownMenuModalItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={item.disabled}
      onSelect={() => {
        item.onSelect?.();
      }}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

function OAuthCredentialRow({
  type,
  title,
  description,
  provider,
  status,
  actionLabel,
  disabled = false,
  menuItems,
  onAction,
  testId,
}: {
  type: ModelProviderType;
  title: string;
  description: string;
  provider: ModelProviderResponse | undefined;
  status: OAuthStatus;
  actionLabel: string;
  disabled?: boolean;
  menuItems: OAuthMenuItem[];
  onAction: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const connectedDetail = provider
    ? formatConnectedStatusDetail(provider)
    : null;
  const usage = provider ? fallbackSubscriptionUsage(provider) : null;
  return (
    <div
      data-testid={testId}
      className="px-5 py-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ProviderIcon type={type} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            data-testid="connector-card-label"
            className="truncate text-sm font-medium text-foreground"
          >
            {title}
          </p>
          <p
            data-testid="connector-help-text"
            className="mt-0.5 truncate text-xs text-muted-foreground"
          >
            {description}
          </p>
        </div>
        {status === "missing" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-9 shrink-0 rounded-lg border"
            aria-label={t(
              ($) => {
                return $.settings.models.personal.actionForProvider;
              },
              {
                action: actionLabel,
                provider: title,
              },
            )}
            disabled={disabled}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        ) : (
          <div className="ml-auto flex items-center justify-end gap-1.5">
            <OAuthFooterStatus
              status={status}
              detail={status === "connected" ? connectedDetail : null}
            />
            {menuItems.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-hover hover:text-foreground"
                    aria-label={t(($) => {
                      return $.settings.shared.moreOptions;
                    })}
                  >
                    <EllipsisVertical size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {menuItems.map((item) => {
                    const key =
                      item.kind === "separator" ? "separator" : item.label;
                    return <OAuthMenuEntry key={key} item={item} />;
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
      {status === "connected" && usageWindows(usage).length > 0 ? (
        <div className="mt-3">
          <SubscriptionUsageMeter usage={usage} />
        </div>
      ) : null}
    </div>
  );
}

function OAuthFooterStatus({
  status,
  detail,
}: {
  status: OAuthStatus;
  detail: string | null;
}) {
  const { t } = useTranslation();
  if (status === "connected") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="min-w-0 truncate">
          {detail
            ? t(
                ($) => {
                  return $.settings.models.personal.status.connectedWithDetail;
                },
                {
                  detail,
                },
              )
            : t(($) => {
                return $.settings.models.personal.status.connected;
              })}
        </span>
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-amber-600 dark:text-amber-400">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        {t(($) => {
          return $.settings.models.personal.status.stale;
        })}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
      {t(($) => {
        return $.settings.shared.connect;
      })}
    </span>
  );
}

function OAuthCredentialRowSkeleton() {
  return (
    <div
      data-testid="oauth-card-skeleton"
      className="flex animate-pulse items-center gap-3 px-5 py-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
    >
      <span className="h-5 w-5 shrink-0 rounded bg-muted/50" />
      <div className="min-w-0 flex-1">
        <span className="block h-4 w-32 rounded bg-muted/50" />
        <span className="mt-1.5 block h-3 w-48 rounded bg-muted/30" />
      </div>
      <span className="h-9 w-20 shrink-0 rounded bg-muted/30" />
    </div>
  );
}
