import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  disconnectPersonalOAuthCredential$,
  personalActionPromise$,
  personalConfiguredProviders$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import { setClaudeCodeDeviceAuthDialogStatePersonal$ } from "../../../../signals/zero-page/settings/claude-code-device-auth.ts";
import { setCodexDeviceAuthDialogStatePersonal$ } from "../../../../signals/zero-page/settings/codex-device-auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "../settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "../settings/codex-device-auth-dialog.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";

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

function OAuthCredentialsSection() {
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const openClaudeCodeDeviceAuthDialog = useSet(
    setClaudeCodeDeviceAuthDialogStatePersonal$,
  );
  const openCodexDeviceAuthDialog = useSet(
    setCodexDeviceAuthDialogStatePersonal$,
  );
  const disconnectCredential = useSet(disconnectPersonalOAuthCredential$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const pageSignal = useGet(pageSignal$);

  const isLoading = providersLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const claudeCode = findProvider(providers, "claude-code-oauth-token");
  const openAI = findProvider(providers, "codex-oauth-token");
  const openAIStatus = getOpenAIStatus(openAI);
  const disconnecting = actionLoadable.state === "loading";

  const connectClaudeCode = () => {
    const next = {
      open: true,
      mode: claudeCode?.needsReconnect ? "reconnect" : "connect",
    } as const;
    openClaudeCodeDeviceAuthDialog(next);
  };
  const connectOpenAI = () => {
    const next = {
      open: true,
      mode: openAI?.needsReconnect ? "reconnect" : "connect",
    } as const;
    openCodexDeviceAuthDialog(next);
  };

  return (
    <section className="flex flex-col gap-4">
      <SettingsSectionHeading
        title="Personal"
        description="Used only in your runs, with your own credentials."
      />
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
            <OAuthCredentialRow
              type="claude-code-oauth-token"
              title="Claude Code OAuth"
              description="Connect with Claude Code login for Claude-backed model routes."
              provider={claudeCode}
              status={getOpenAIStatus(claudeCode)}
              menuItems={
                claudeCode
                  ? [
                      {
                        label: "Replace",
                        onSelect: connectClaudeCode,
                      },
                      {
                        label: "Disconnect",
                        disabled: disconnecting,
                        onSelect: () => {
                          detach(
                            disconnectCredential(
                              "claude-code-oauth-token",
                              pageSignal,
                            ),
                            Reason.DomCallback,
                          );
                        },
                      },
                    ]
                  : []
              }
              onAction={connectClaudeCode}
              testId="oauth-card-claude-code-oauth-token"
            />
            <OAuthCredentialRow
              type="codex-oauth-token"
              title="ChatGPT (Codex)"
              description="Connect with Codex device login for Codex-backed model routes."
              provider={openAI}
              status={openAIStatus}
              menuItems={
                openAI
                  ? [
                      {
                        label: "Replace",
                        onSelect: connectOpenAI,
                      },
                      {
                        label: "Disconnect",
                        disabled: disconnecting,
                        onSelect: () => {
                          detach(
                            disconnectCredential(
                              "codex-oauth-token",
                              pageSignal,
                            ),
                            Reason.DomCallback,
                          );
                        },
                      },
                    ]
                  : []
              }
              onAction={connectOpenAI}
              testId="oauth-card-codex-oauth-token"
            />
          </>
        )}
      </div>
    </section>
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

function formatUsageReset(resetAt: string | null): string | null {
  const text = resetAt?.trim();
  if (!text) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return `resets ${text}`;
  }
  return `resets ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  })}`;
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
  readonly label: string;
  readonly window: SubscriptionUsageWindow;
}[] {
  return [
    { label: "5h", window: usage?.fiveHour ?? null },
    { label: "Week", window: usage?.weekly ?? null },
  ].filter(
    (item): item is { label: string; window: SubscriptionUsageWindow } => {
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
  const windows = usageWindows(usage);

  if (windows.length === 0) {
    return null;
  }

  return (
    <div className="w-full rounded-lg bg-muted/30 px-3 py-2.5">
      <div className="space-y-2">
        {windows.map(({ label, window }) => {
          const remainingPercent =
            window.remainingPercent ??
            (window.usedPercent === null ? null : 100 - window.usedPercent);
          const displayPercent = formatUsagePercent(remainingPercent);
          const resetText = formatUsageReset(window.resetAt);
          const tone = usageTone(remainingPercent);
          return (
            <div key={label} className="space-y-1">
              <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] leading-none">
                <span className="font-medium text-foreground">{label}</span>
                {displayPercent ? (
                  <span className={`font-medium ${tone.textClassName}`}>
                    {displayPercent} left
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
              {resetText ? (
                <div className="truncate text-[10px] leading-none text-muted-foreground">
                  {resetText}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface OAuthMenuItem {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

function OAuthCredentialRow({
  type,
  title,
  description,
  provider,
  status,
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
  disabled?: boolean;
  menuItems: OAuthMenuItem[];
  onAction: () => void;
  testId: string;
}) {
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
            aria-label={`Connect ${title}`}
            disabled={disabled}
            onClick={onAction}
          >
            Connect
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
                    className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-[hsl(var(--gray-50))] hover:text-foreground"
                    aria-label="More options"
                  >
                    <IconDotsVertical size={14} stroke={1.5} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {menuItems.map((item) => {
                    return (
                      <DropdownMenuItem
                        key={item.label}
                        disabled={item.disabled}
                        onClick={item.onSelect}
                      >
                        {item.label}
                      </DropdownMenuItem>
                    );
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
  if (status === "connected") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="min-w-0 truncate">
          Connected{detail ? ` (${detail})` : ""}
        </span>
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-amber-600 dark:text-amber-400">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        Attention
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
      Connect
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
