import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { TeamsConnectStatus } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDotsVertical,
  IconDownload,
  IconSettings,
  IconWebhook,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import { brandName$ } from "../../signals/branding.ts";
import {
  slackOrgData$,
  disconnectSlackOrg$,
  uninstallSlackOrg$,
  showUninstallDialog$,
  setShowUninstallDialog$,
} from "../../signals/zero-page/zero-slack.ts";
import {
  disconnectTeamsOrg$,
  teamsOrgData$,
  showTeamsUninstallDialog$,
  setShowTeamsUninstallDialog$,
  uninstallTeamsOrg$,
} from "../../signals/zero-page/zero-teams.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import { now } from "../../lib/time.ts";
import { AgentPhoneCard } from "./agentphone-card.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { FeishuCard } from "./feishu-card.tsx";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";

const slackIconImg = settingsIconAssetUrl("slack");
const teamsIconImg = settingsIconAssetUrl("teams");
const telegramIconImg = settingsIconAssetUrl("telegram");

/** Append a cache-busting timestamp and forward ?prompt= so the OAuth flow can
 *  carry it through to the Slack DM greeting. */
function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  const prompt = new URLSearchParams(window.location.search).get("prompt");
  if (prompt) {
    fresh.searchParams.set("prompt", prompt);
  }
  fresh.searchParams.set("_t", String(now()));
  window.open(fresh.toString(), "_blank");
}

function ConnectedIndicator({
  testId,
  connectedDetail,
}: {
  testId: string;
  connectedDetail?: string | null;
}) {
  const { t } = useTranslation();

  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
    >
      <IconCircleCheck className="h-3 w-3 text-green-600" />
      <span className="min-w-0 truncate" title={connectedDetail ?? ""}>
        {connectedDetail
          ? t(
              ($) => {
                return $.works.connectedWithDetail;
              },
              { detail: connectedDetail },
            )
          : t(($) => {
              return $.works.connected;
            })}
      </span>
    </span>
  );
}

function SlackCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  installUrl,
  connectUrl,
  connectedDetail,
  onDisconnect,
  onUninstall,
  disconnecting,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  installUrl: string | null | undefined;
  connectUrl: string | null | undefined;
  connectedDetail?: string | null;
  onDisconnect: () => void;
  onUninstall: () => void;
  disconnecting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {isConnected ? (
        <ConnectedIndicator
          testId="slack-connected-indicator"
          connectedDetail={connectedDetail}
        />
      ) : null}
      {!isInstalled && isAdmin && installUrl && (
        <Button
          data-testid="slack-install-button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(installUrl);
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          {t(($) => {
            return $.works.slack.install;
          })}
        </Button>
      )}
      {isInstalled && !isConnected && connectUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(connectUrl);
          }}
        >
          {t(($) => {
            return $.works.actions.connect;
          })}
        </Button>
      )}
      {isInstalled && (isConnected || isAdmin) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={t(($) => {
                return $.works.actions.moreOptions;
              })}
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            {isConnected && (
              <button
                type="button"
                aria-label={t(($) => {
                  return $.works.actions.disconnect;
                })}
                disabled={disconnecting}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                onClick={onDisconnect}
              >
                {disconnecting
                  ? t(($) => {
                      return $.works.actions.disconnecting;
                    })
                  : t(($) => {
                      return $.works.actions.disconnect;
                    })}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                aria-label={t(($) => {
                  return $.works.actions.uninstall;
                })}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onUninstall}
              >
                {t(($) => {
                  return $.works.actions.uninstall;
                })}
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function SlackPermissionWarning({
  reinstallUrl,
}: {
  reinstallUrl: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (!reinstallUrl) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-4 py-3">
      <IconAlertTriangle size={16} className="shrink-0 text-amber-500" />
      <span className="flex-1 text-sm text-amber-600 dark:text-amber-400">
        {t(($) => {
          return $.works.slack.permissionsUpdated;
        })}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 text-xs"
        onClick={() => {
          return openFreshOAuth(reinstallUrl);
        }}
      >
        {t(($) => {
          return $.works.actions.updatePermissions;
        })}
      </Button>
    </div>
  );
}

function SlackCard({ displayName }: { displayName: string }) {
  const { t } = useTranslation();
  // useLastLoadable keeps the prior resolved value during the polling refetch
  // so the card text doesn't flicker back to defaults on every poll cycle.
  const slackDataLoadable = useLastLoadable(slackOrgData$);
  const slackData =
    slackDataLoadable.state === "hasData" ? slackDataLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectSlackOrg$);
  const disconnecting = disconnectLoadable.state === "loading";
  const [uninstallLoadable, uninstall] = useLoadableSet(uninstallSlackOrg$);
  const uninstalling = uninstallLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const showUninstallDialog = useGet(showUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowUninstallDialog$);

  const isConnected = slackData?.isConnected ?? false;
  const isInstalled = slackData?.isInstalled ?? isConnected;
  const isAdmin = slackData?.isAdmin ?? false;
  const scopeMismatch = slackData?.scopeMismatch === true;
  const reinstallUrl = slackData?.reinstallUrl;

  return (
    <>
      <div className="zero-card flex flex-col">
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={slackIconImg} alt="" className="h-7 w-7 scale-[2.2]" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">Slack</div>
            <div className="text-sm text-muted-foreground">
              {!isInstalled && !isAdmin
                ? t(($) => {
                    return $.works.slack.adminInstall;
                  })
                : t(($) => {
                    return $.works.slack.description;
                  })}
            </div>
          </div>
          <SlackCardActions
            isConnected={isConnected}
            isInstalled={isInstalled}
            isAdmin={isAdmin}
            installUrl={slackData?.installUrl}
            connectUrl={slackData?.connectUrl}
            connectedDetail={slackData?.workspaceName}
            disconnecting={disconnecting}
            onDisconnect={() => {
              return detach(disconnect(pageSignal), Reason.DomCallback);
            }}
            onUninstall={() => {
              return setShowUninstallDialog(true);
            }}
          />
        </div>

        <SlackPermissionWarning
          reinstallUrl={scopeMismatch && isAdmin ? reinstallUrl : null}
        />
      </div>

      <Dialog
        open={showUninstallDialog}
        onOpenChange={(v) => {
          if (!uninstalling) {
            setShowUninstallDialog(v);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.works.slack.uninstallTitle;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                ($) => {
                  return $.works.slack.uninstallDescription;
                },
                { displayName },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={uninstalling}
              onClick={() => {
                return setShowUninstallDialog(false);
              }}
            >
              {t(($) => {
                return $.works.actions.cancel;
              })}
            </Button>
            <Button
              variant="destructive"
              disabled={uninstalling}
              onClick={() => {
                detach(
                  (async () => {
                    await uninstall(pageSignal);
                    setShowUninstallDialog(false);
                  })(),
                  Reason.DomCallback,
                );
              }}
            >
              {uninstalling
                ? t(($) => {
                    return $.works.actions.uninstalling;
                  })
                : t(($) => {
                    return $.works.actions.uninstall;
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TeamsConnectedIndicator({
  connectedDetail,
}: {
  connectedDetail?: string | null;
}) {
  return (
    <ConnectedIndicator
      testId="teams-connected-indicator"
      connectedDetail={connectedDetail}
    />
  );
}

function TeamsCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  installUrl,
  connectUrl,
  connectedDetail,
  onDisconnect,
  onUninstall,
  disconnecting,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  installUrl: string | null | undefined;
  connectUrl: string | null | undefined;
  connectedDetail?: string | null;
  onDisconnect: () => void;
  onUninstall: () => void;
  disconnecting: boolean;
}) {
  const { t } = useTranslation();
  const installActionUrl = connectUrl ?? installUrl;
  return (
    <>
      {isConnected ? (
        <TeamsConnectedIndicator connectedDetail={connectedDetail} />
      ) : null}
      {!isInstalled && isAdmin && installActionUrl && (
        <Button
          data-testid="teams-install-button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(installActionUrl);
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          {t(($) => {
            return $.works.teams.install;
          })}
        </Button>
      )}
      {isInstalled && !isConnected && connectUrl && (
        <Button
          data-testid="teams-connect-button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(connectUrl);
          }}
        >
          {t(($) => {
            return $.works.actions.connect;
          })}
        </Button>
      )}
      {isInstalled && (isConnected || isAdmin) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={t(($) => {
                return $.works.teams.moreOptions;
              })}
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            {isConnected && (
              <button
                type="button"
                aria-label={t(($) => {
                  return $.works.teams.disconnect;
                })}
                disabled={disconnecting}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                onClick={onDisconnect}
              >
                {disconnecting
                  ? t(($) => {
                      return $.works.actions.disconnecting;
                    })
                  : t(($) => {
                      return $.works.actions.disconnect;
                    })}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                aria-label={t(($) => {
                  return $.works.teams.uninstall;
                })}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onUninstall}
              >
                {t(($) => {
                  return $.works.actions.uninstall;
                })}
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function teamsPermissionReinstallUrl(args: {
  isAdmin: boolean;
  permissionMismatch: boolean;
  reinstallUrl: string | null | undefined;
}): string | null {
  if (!args.isAdmin || !args.permissionMismatch || !args.reinstallUrl) {
    return null;
  }
  return args.reinstallUrl;
}

function TeamsPermissionWarning({
  reinstallUrl,
}: {
  reinstallUrl: string | null;
}) {
  const { t } = useTranslation();
  if (!reinstallUrl) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-4 py-3">
      <IconAlertTriangle size={16} className="shrink-0 text-amber-500" />
      <span className="flex-1 text-sm text-amber-600 dark:text-amber-400">
        {t(($) => {
          return $.works.teams.permissionsUpdated;
        })}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 text-xs"
        onClick={() => {
          return openFreshOAuth(reinstallUrl);
        }}
      >
        {t(($) => {
          return $.works.actions.updatePermissions;
        })}
      </Button>
    </div>
  );
}

function teamsConnectedDetail(
  teamsData: TeamsConnectStatus | null,
): string | null | undefined {
  return teamsData?.teamName ?? teamsData?.tenantName;
}

function teamsCardDescription(args: {
  isInstalled: boolean;
  isConnected: boolean;
  isAdmin: boolean;
}): string {
  if (!args.isInstalled && !args.isAdmin) {
    return i18n.t(($) => {
      return $.works.teams.adminInstall;
    });
  }
  if (!args.isInstalled && args.isAdmin) {
    return i18n.t(($) => {
      return $.works.teams.connectThenInstall;
    });
  }
  if (args.isInstalled && !args.isConnected) {
    return i18n.t(($) => {
      return $.works.teams.connectAccount;
    });
  }
  return i18n.t(($) => {
    return $.works.teams.description;
  });
}

function TeamsCard({ displayName }: { displayName: string }) {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const teamsDataLoadable = useLastLoadable(teamsOrgData$);
  const teamsData =
    teamsDataLoadable.state === "hasData" ? teamsDataLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectTeamsOrg$);
  const disconnecting = disconnectLoadable.state === "loading";
  const [uninstallLoadable, uninstall] = useLoadableSet(uninstallTeamsOrg$);
  const uninstalling = uninstallLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const showUninstallDialog = useGet(showTeamsUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowTeamsUninstallDialog$);

  const isConnected = teamsData?.isConnected ?? false;
  const isInstalled = teamsData?.isInstalled ?? false;
  const isAdmin = teamsData?.isAdmin ?? false;
  const connectedDetail = teamsConnectedDetail(teamsData);
  const permissionMismatch = teamsData?.permissionMismatch === true;
  const reinstallUrl = teamsPermissionReinstallUrl({
    isAdmin,
    permissionMismatch,
    reinstallUrl: teamsData?.reinstallUrl,
  });
  const description = teamsCardDescription({
    isInstalled,
    isConnected,
    isAdmin,
  });

  return (
    <>
      <div className="zero-card flex flex-col">
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={teamsIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              Microsoft Teams
            </div>
            <div className="text-sm text-muted-foreground">{description}</div>
          </div>
          <TeamsCardActions
            isConnected={isConnected}
            isInstalled={isInstalled}
            isAdmin={isAdmin}
            installUrl={teamsData?.installUrl}
            connectUrl={teamsData?.connectUrl}
            connectedDetail={connectedDetail}
            disconnecting={disconnecting}
            onDisconnect={() => {
              return detach(disconnect(pageSignal), Reason.DomCallback);
            }}
            onUninstall={() => {
              return setShowUninstallDialog(true);
            }}
          />
        </div>

        <TeamsPermissionWarning reinstallUrl={reinstallUrl} />
      </div>

      <Dialog
        open={showUninstallDialog}
        onOpenChange={(v) => {
          if (!uninstalling) {
            setShowUninstallDialog(v);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.works.teams.uninstallTitle;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                ($) => {
                  return $.works.teams.uninstallDescription;
                },
                { brandName, displayName },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={uninstalling}
              onClick={() => {
                return setShowUninstallDialog(false);
              }}
            >
              {t(($) => {
                return $.works.actions.cancel;
              })}
            </Button>
            <Button
              variant="destructive"
              disabled={uninstalling}
              onClick={() => {
                detach(
                  (async () => {
                    await uninstall(pageSignal);
                    setShowUninstallDialog(false);
                  })(),
                  Reason.DomCallback,
                );
              }}
            >
              {uninstalling
                ? t(($) => {
                    return $.works.actions.uninstalling;
                  })
                : t(($) => {
                    return $.works.actions.uninstall;
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TelegramCard() {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.settingsTelegram}
      className="zero-card flex flex-col text-inherit no-underline transition-colors hover:bg-muted/30"
      aria-label={t(($) => {
        return $.works.telegram.openSettings;
      })}
    >
      <div className="flex items-center gap-4 p-4">
        <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
          <img src={telegramIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              Telegram
            </div>
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {t(($) => {
              return $.works.telegram.description;
            })}
          </div>
        </div>
        <span className="shrink-0 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-secondary-foreground">
          <IconSettings size={14} stroke={1.5} />
          {t(($) => {
            return $.works.actions.manage;
          })}
        </span>
      </div>
    </Link>
  );
}

function StrapiCard() {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.settingsStrapi}
      className="zero-card flex flex-col transition-colors hover:bg-accent/40"
    >
      <div className="flex items-center gap-4 p-4">
        <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#4945ff]/10 text-[#4945ff]">
          <IconWebhook size={18} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-sm font-medium text-foreground">
            Strapi
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {t(($) => {
              return $.works.strapi.description;
            })}
          </div>
        </div>
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-secondary-foreground">
          <IconSettings size={14} stroke={1.5} />
          {t(($) => {
            return $.works.actions.manage;
          })}
        </span>
      </div>
    </Link>
  );
}

export function ZeroWorksPage() {
  const { t } = useTranslation();
  const features = useGet(featureSwitch$);
  const teamsEnabled = features[FeatureSwitchKey.TeamsIntegration] ?? false;
  const feishuEnabled = features[FeatureSwitchKey.FeishuIntegration] ?? false;
  const strapiEnabled = features[FeatureSwitchKey.StrapiIntegration] ?? false;
  const displayNameLoadable = useLoadable(currentChatAgentDisplayName$);
  const displayName =
    displayNameLoadable.state === "hasData"
      ? (displayNameLoadable.data ?? "Zero")
      : "Zero";

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="hidden md:block text-lg font-semibold tracking-tight text-foreground">
            {t(
              ($) => {
                return $.works.header.title;
              },
              { displayName },
            )}
          </h1>
          <p className="hidden md:block mt-0.5 text-sm text-muted-foreground">
            {t(
              ($) => {
                return $.works.header.description;
              },
              { displayName },
            )}
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <SlackCard displayName={displayName} />
          {teamsEnabled ? <TeamsCard displayName={displayName} /> : null}
          {feishuEnabled ? <FeishuCard /> : null}
          {strapiEnabled ? <StrapiCard /> : null}
          <TelegramCard />
          <AgentPhoneCard />
        </div>
      </main>
    </div>
  );
}
