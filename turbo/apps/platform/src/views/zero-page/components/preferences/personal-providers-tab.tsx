import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { IconDotsVertical, IconPlus } from "@tabler/icons-react";
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
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  connectPersonalCodexOAuth$,
  disconnectPersonalOAuthCredential$,
  personalActionPromise$,
  personalConfiguredProviders$,
  personalOpenOAuthCredentialDialog$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalProviderDialog } from "../settings/personal-provider-dialog.tsx";
import { PersonalCodexAuthPasteDialog } from "../settings/codex-auth-paste-dialog.tsx";

type OAuthStatus = "connected" | "stale" | "missing";

export function PersonalProvidersTab() {
  return (
    <div className="flex flex-col gap-8">
      <OAuthCredentialsSection />
      <PersonalProviderDialog />
      <PersonalCodexAuthPasteDialog />
    </div>
  );
}

function OAuthCredentialsSection() {
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const features = useLastResolved(featureSwitch$);
  const openCredentialDialog = useSet(personalOpenOAuthCredentialDialog$);
  const connectCodexOAuth = useSet(connectPersonalCodexOAuth$);
  const disconnectCredential = useSet(disconnectPersonalOAuthCredential$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const pageSignal = useGet(pageSignal$);

  const isLoading = providersLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const codexOauthEnabled =
    features?.[FeatureSwitchKey.CodexOauthProvider] ?? false;
  const claudeCode = findProvider(providers, "claude-code-oauth-token");
  const openAI = findProvider(providers, "codex-oauth-token");
  const openAIStatus = getOpenAIStatus(openAI);
  const disconnecting = actionLoadable.state === "loading";
  const connectOpenAI = () => {
    detach(connectCodexOAuth(pageSignal), Reason.DomCallback);
  };

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Manage OAuth access used when workspace model routes require your
        personal Claude Code
        {codexOauthEnabled ? " or ChatGPT" : ""} authorization.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {isLoading ? (
          <>
            <OAuthCardSkeleton />
            {codexOauthEnabled && <OAuthCardSkeleton />}
          </>
        ) : (
          <>
            <OAuthCredentialCard
              type="claude-code-oauth-token"
              title="Claude Code OAuth"
              description="Paste the Claude Code OAuth token used by workspace model routes."
              status={claudeCode ? "connected" : "missing"}
              menuItems={
                claudeCode
                  ? [
                      {
                        label: "Replace",
                        onSelect: () => {
                          openCredentialDialog("claude-code-oauth-token");
                        },
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
              onAction={() => {
                openCredentialDialog("claude-code-oauth-token");
              }}
              testId="oauth-card-claude-code-oauth-token"
            />
            {codexOauthEnabled && (
              <OAuthCredentialCard
                type="codex-oauth-token"
                title="ChatGPT (Codex)"
                description="Connect a ChatGPT account for Codex-backed model routes."
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
            )}
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

interface OAuthMenuItem {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

function OAuthCredentialCard({
  type,
  title,
  description,
  status,
  disabled = false,
  menuItems,
  onAction,
  testId,
}: {
  type: ModelProviderType;
  title: string;
  description: string;
  status: OAuthStatus;
  disabled?: boolean;
  menuItems: OAuthMenuItem[];
  onAction: () => void;
  testId: string;
}) {
  if (status === "missing") {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Connect ${title}`}
        className="zero-card cursor-pointer overflow-hidden"
        data-testid={testId}
        onClick={() => {
          if (!disabled) {
            onAction();
          }
        }}
        onKeyDown={(event) => {
          if (disabled) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onAction();
          }
        }}
      >
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <ProviderIcon type={type} size={20} />
          </span>
          <span
            data-testid="connector-card-label"
            className="min-w-0 flex-1 text-sm font-medium text-foreground truncate"
          >
            {title}
          </span>
          <OAuthConnectIcon />
        </div>
        <div className="px-5 pb-4 pt-1">
          <div
            data-testid="connector-help-text"
            className="text-xs text-muted-foreground line-clamp-2"
          >
            {description}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="zero-card flex flex-col" data-testid={testId}>
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ProviderIcon type={type} size={20} />
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 text-sm font-medium text-foreground truncate"
        >
          {title}
        </span>
      </div>
      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex items-center gap-2 min-w-0">
          <OAuthFooterStatus status={status} />
        </div>
        {menuItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
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
    </div>
  );
}

function OAuthConnectIcon() {
  return (
    <span
      className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
      aria-hidden="true"
    >
      <IconPlus size={14} stroke={1.5} />
    </span>
  );
}

function OAuthFooterStatus({ status }: { status: OAuthStatus }) {
  if (status === "connected") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        Connected
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

function OAuthCardSkeleton() {
  return (
    <div
      data-testid="oauth-card-skeleton"
      className="zero-card flex flex-col overflow-hidden animate-pulse"
    >
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="h-5 w-5 shrink-0 rounded bg-muted/50" />
        <span className="h-4 w-28 rounded bg-muted/50" />
      </div>
      <div className="flex h-11 items-center px-5 zero-border-t">
        <span className="h-3 w-16 rounded bg-muted/30" />
      </div>
    </div>
  );
}
