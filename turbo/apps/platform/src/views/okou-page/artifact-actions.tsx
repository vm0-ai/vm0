import type { ComponentPropsWithRef, MouseEvent, ReactElement } from "react";
import { Download, Loader2, Share2 } from "lucide-react";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  BrandGoogleDrive,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { isConnectorAppOauthCallbackEnabled } from "@okouai/connectors/app-oauth-callback";
import {
  connectorOauthStartContract,
  connectorOpenIdStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import {
  OAUTH_API_BASE,
  apiClient$,
  type ApiClientFactory,
} from "../../signals/api-client.ts";
import {
  connectorCatalogStatusBySlug$,
  connectors$,
} from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason, withCleanup } from "../../signals/utils.ts";
import {
  artifactDownloadMenuOpenKey$,
  artifactDownloadPendingKey$,
  closeArtifactDownloadMenu$,
  finishArtifactDownload$,
  openArtifactDownloadMenu$,
  startArtifactDownload$,
} from "../../signals/okou-page/artifact-actions.ts";
import {
  syncArtifactFileToGoogleDrive,
  waitForGoogleDriveAuthorization$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import {
  getOnlyAvailableCatalogBrowserAuthMethodDetail,
  type ConnectorCatalogBrowserAuthMethodDetail,
} from "../../signals/okou-page/settings/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  connectorAccountMutationFor,
  defaultBuiltinConnectorAccountMode,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import {
  copyAttachmentLinkToClipboard,
  publicAttachmentUrl,
} from "./attachment-url.ts";

const GOOGLE_DRIVE_CONNECTOR_SLUG = "google-drive";
const ARTIFACT_FLOATING_TRANSITION_CLASS =
  "transition-[opacity,transform] duration-[180ms] ease data-open:!animate-none data-closed:!animate-none data-open:translate-y-0 data-open:opacity-100 data-closed:translate-y-2 data-closed:opacity-0";

function siteSlugFromUrl(value: string): string | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const slug = new URL(value).hostname.split(".")[0];
  return slug && slug.length > 0 ? slug : null;
}

function htmlDownloadFilename(filename: string, url: string): string {
  const trimmed = filename.trim();
  const candidate =
    siteSlugFromUrl(trimmed) ??
    (trimmed === url ? siteSlugFromUrl(url) : null) ??
    trimmed;
  const pathSafe = candidate.replace(/[\\/]/g, "-").trim();
  const withoutHtml = pathSafe.replace(/\.(?:html?|xhtml)$/iu, "");
  const base =
    withoutHtml === pathSafe ? pathSafe.replace(/\.[^/.]+$/u, "") : withoutHtml;
  return `${base || siteSlugFromUrl(url) || "site"}.html`;
}

function artifactDownloadFilename(
  artifactKind: ChatThreadArtifactFile["artifactKind"] | undefined,
  filename: string,
  url: string,
): string {
  return artifactKind === "hosted-site" || artifactKind === "presentation-html"
    ? htmlDownloadFilename(filename, url)
    : filename;
}

type WaitForGoogleDriveAuthorizationFn = (
  params: {
    readonly agentId: string;
    readonly authorizeConnected?: boolean;
  },
  signal: AbortSignal,
) => Promise<unknown>;

type GoogleDriveReadyRun = () => Promise<void>;

export type ArtifactDownloadSyncTarget = {
  readonly agentId: string | null | undefined;
  readonly disconnected: boolean;
  readonly fileId: string;
  readonly filename: string;
  readonly onSyncSuccess: () => void;
  readonly runId: string;
  readonly synced: boolean;
  readonly threadId: string;
};

async function shareArtifactUrl(url: string): Promise<void> {
  await copyAttachmentLinkToClipboard(url);
}

function isPlainPrimaryLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function runWhenGoogleDriveReady(
  params: {
    agentId: string | null | undefined;
    authorizeConnected: boolean;
    run: GoogleDriveReadyRun;
    waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
    operation: string;
  },
  pageSignal: AbortSignal,
): void {
  if (!params.agentId) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.googleDrive.agentLoading;
      }),
    );
    return;
  }
  const agentId = params.agentId;
  detach(
    (async () => {
      await params.waitForGoogleDriveAuthorization(
        { agentId, authorizeConnected: params.authorizeConnected },
        pageSignal,
      );
      await params.run();
    })(),
    Reason.DomCallback,
    params.operation,
  );
}

function startGoogleDriveConnectAndRun(
  params: {
    agentId: string | null | undefined;
    authMethod: ConnectorCatalogBrowserAuthMethodDetail;
    connector: PlatformConnectorCatalogStatusItem;
    createClient: ApiClientFactory;
    run: GoogleDriveReadyRun;
    waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
    operation: string;
  },
  pageSignal: AbortSignal,
): void {
  if (!params.agentId) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.googleDrive.agentLoading;
      }),
    );
    return;
  }
  const agentId = params.agentId;
  const accountMode = defaultBuiltinConnectorAccountMode(params.connector);
  if (!accountMode) {
    return;
  }
  const account = connectorAccountMutationFor(accountMode);
  if (!account) {
    return;
  }
  const authWindow = window.open(
    "about:blank",
    "_blank",
    "width=600,height=700",
  );
  if (!authWindow) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.googleDrive.failedToOpenConnect;
      }),
    );
    return;
  }
  detach(
    (async () => {
      const request = {
        params: { connectorSlug: params.connector.slug },
        body: {
          account,
          authMethod: params.authMethod.id,
          agentId,
          authorizeAgent: true as const,
        },
        fetchOptions: { signal: pageSignal },
      };
      const result =
        params.authMethod.grantKind === "openid-auth"
          ? await accept(
              params
                .createClient(connectorOpenIdStartContract, {
                  apiBase: "api",
                })
                .start(request),
              [200],
            )
          : await accept(
              params
                .createClient(connectorOauthStartContract, {
                  apiBase: OAUTH_API_BASE,
                })
                .start({
                  ...request,
                  body: {
                    ...request.body,
                    ...(isConnectorAppOauthCallbackEnabled(
                      params.connector.slug,
                    )
                      ? { callbackTarget: "app" as const }
                      : {}),
                  },
                }),
              [200],
            );
      pageSignal.throwIfAborted();
      authWindow.location.href = result.body.authorizationUrl;
    })(),
    Reason.DomCallback,
    "artifact google drive oauth start",
  );
  runWhenGoogleDriveReady(
    {
      agentId,
      authorizeConnected: false,
      run: params.run,
      waitForGoogleDriveAuthorization: params.waitForGoogleDriveAuthorization,
      operation: params.operation,
    },
    pageSignal,
  );
}

function authorizeGoogleDriveAndRun(
  params: {
    agentId: string | null | undefined;
    run: GoogleDriveReadyRun;
    waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
    operation: string;
  },
  pageSignal: AbortSignal,
): void {
  runWhenGoogleDriveReady({ ...params, authorizeConnected: true }, pageSignal);
}

function iconButtonClassName(className?: string): string {
  return cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
    className,
  );
}

export function ArtifactActionSeparator() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />;
}

export function ArtifactActionTooltip({
  children,
  label,
  side = "bottom",
}: {
  children: ReactElement;
  label: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const trigger = (children.props as { disabled?: boolean }).disabled ? (
    <span className="inline-flex">{children}</span>
  ) : (
    children
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent
          side={side}
          className={ARTIFACT_FLOATING_TRANSITION_CLASS}
        >
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ArtifactShareButton({
  ariaLabel,
  className,
  iconSize = 16,
  url,
}: {
  ariaLabel?: string;
  className?: string;
  iconSize?: number;
  url: string;
}) {
  const { t } = useTranslation();
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.share;
    });
  return (
    <ArtifactActionTooltip label={label}>
      <a
        href={publicAttachmentUrl(url)}
        onClick={(event) => {
          if (!isPlainPrimaryLinkClick(event)) {
            return;
          }
          event.preventDefault();
          detach(shareArtifactUrl(url), Reason.DomCallback, "artifact share");
        }}
        aria-label={label}
        className={iconButtonClassName(className)}
      >
        <Share2 size={iconSize} />
      </a>
    </ArtifactActionTooltip>
  );
}

function useGoogleDriveAvailability(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
) {
  const connectorListLoadable = useLoadable(connectors$);
  const lastConnectorList = useLastResolved(connectors$);
  const catalogBySlugLoadable = useLoadable(connectorCatalogStatusBySlug$);
  const lastCatalogBySlug = useLastResolved(connectorCatalogStatusBySlug$);
  const connectorList =
    connectorListLoadable.state === "hasData"
      ? connectorListLoadable.data
      : connectorListLoadable.state === "loading"
        ? lastConnectorList
        : undefined;
  const catalogBySlug =
    catalogBySlugLoadable.state === "hasData"
      ? catalogBySlugLoadable.data
      : catalogBySlugLoadable.state === "loading"
        ? lastCatalogBySlug
        : undefined;
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return (
        connector.slug === GOOGLE_DRIVE_CONNECTOR_SLUG &&
        connector.connectionStatus === "connected"
      );
    }) ?? false;
  const googleDriveConnector =
    catalogBySlug?.get(GOOGLE_DRIVE_CONNECTOR_SLUG) ?? null;
  const googleDriveAuthMethod =
    googleDriveConnector === null
      ? null
      : getOnlyAvailableCatalogBrowserAuthMethodDetail(googleDriveConnector);

  return {
    connectorListLoaded:
      connectorList !== undefined &&
      (googleDriveConnected || catalogBySlug !== undefined),
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady: googleDriveConnected && syncTarget?.disconnected !== true,
  };
}

function GoogleDriveDisabledMenuItem({
  kind,
  muted = false,
}: {
  kind: "connect" | "synced" | "upload";
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const text =
    kind === "connect"
      ? t(($) => {
          return $.artifacts.googleDrive.connect;
        })
      : kind === "synced"
        ? t(($) => {
            return $.artifacts.googleDrive.synced;
          })
        : t(($) => {
            return $.artifacts.googleDrive.upload;
          });
  return (
    <DropdownMenuItem className={muted ? "text-muted-foreground" : ""} disabled>
      <BrandGoogleDrive size={14} />
      {text}
    </DropdownMenuItem>
  );
}

function GoogleDriveMenuItem({
  syncTarget,
}: {
  syncTarget?: ArtifactDownloadSyncTarget;
}) {
  const { t } = useTranslation();
  const {
    connectorListLoaded,
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady,
  } = useGoogleDriveAvailability(syncTarget);
  const createClient = useGet(apiClient$);
  const pageSignal = useGet(pageSignal$);
  const waitForGoogleDriveAuthorization = useSet(
    waitForGoogleDriveAuthorization$,
  );

  if (!syncTarget) {
    return <GoogleDriveDisabledMenuItem kind="upload" />;
  }

  if (syncTarget.synced) {
    return <GoogleDriveDisabledMenuItem kind="synced" />;
  }

  if (!connectorListLoaded) {
    return (
      <GoogleDriveDisabledMenuItem
        kind={syncTarget.disconnected ? "connect" : "upload"}
        muted={syncTarget.disconnected}
      />
    );
  }

  const syncOrConnect = () => {
    const run = async () => {
      const success = await syncArtifactFileToGoogleDrive(
        {
          createClient,
          threadId: syncTarget.threadId,
          runId: syncTarget.runId,
          fileId: syncTarget.fileId,
          filename: syncTarget.filename,
        },
        pageSignal,
      );
      if (success) {
        syncTarget.onSyncSuccess();
      }
    };
    if (googleDriveReady) {
      detach(run(), Reason.DomCallback, "artifact google drive sync");
      return;
    }
    if (googleDriveConnected) {
      authorizeGoogleDriveAndRun(
        {
          agentId: syncTarget.agentId,
          run,
          waitForGoogleDriveAuthorization,
          operation: "artifact google drive authorize sync",
        },
        pageSignal,
      );
      return;
    }
    if (!googleDriveConnector || !googleDriveAuthMethod) {
      return;
    }
    startGoogleDriveConnectAndRun(
      {
        agentId: syncTarget.agentId,
        authMethod: googleDriveAuthMethod,
        connector: googleDriveConnector,
        createClient,
        run,
        waitForGoogleDriveAuthorization,
        operation: "artifact google drive connect sync",
      },
      pageSignal,
    );
  };

  if (googleDriveReady) {
    return (
      <DropdownMenuItem onClick={syncOrConnect}>
        <BrandGoogleDrive size={14} />
        {t(($) => {
          return $.artifacts.googleDrive.upload;
        })}
      </DropdownMenuItem>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuItem
              disabled={
                !googleDriveConnected &&
                (!googleDriveConnector || !googleDriveAuthMethod)
              }
              onClick={syncOrConnect}
            >
              <BrandGoogleDrive size={14} />
              {t(($) => {
                return $.artifacts.googleDrive.connect;
              })}
            </DropdownMenuItem>
          }
        />
        <TooltipContent
          side="left"
          className={ARTIFACT_FLOATING_TRANSITION_CLASS}
        >
          {t(($) => {
            return $.artifacts.googleDrive.connectTooltip;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type ArtifactDownloadMenuProps = {
  align?: "center" | "end" | "start";
  ariaLabel?: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  className?: string;
  filename: string;
  iconSize?: number;
  menuInstanceKey: string;
  syncTarget?: ArtifactDownloadSyncTarget;
  url: string;
};

function ArtifactDownloadTrigger({
  ariaLabel,
  className,
  downloadPending,
  iconSize,
  open,
  ref,
  ...props
}: ComponentPropsWithRef<"button"> & {
  ariaLabel: string;
  downloadPending: boolean;
  iconSize: number;
  open: boolean;
}) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      aria-busy={downloadPending ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={downloadPending}
      className={iconButtonClassName(
        cn(
          "data-popup-open:bg-state-hover data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-70",
          className,
        ),
      )}
    >
      {downloadPending ? (
        <Loader2 size={iconSize} className="animate-spin" />
      ) : (
        <Download size={iconSize} />
      )}
    </button>
  );
}

function setArtifactDownloadMenuOpen(params: {
  readonly closeMenu: () => void;
  readonly nextOpen: boolean;
  readonly openMenu: (key: string) => void;
  readonly menuKey: string;
}): void {
  if (params.nextOpen) {
    params.openMenu(params.menuKey);
    return;
  }
  params.closeMenu();
}

function startArtifactDownloadWithCleanup(params: {
  readonly operation: string;
  readonly download: Promise<void>;
  readonly downloadKey: string;
  readonly finish: (key: string) => void;
  readonly start: (key: string) => void;
}): void {
  params.start(params.downloadKey);
  detach(
    withCleanup(params.download, () => {
      params.finish(params.downloadKey);
    }),
    Reason.DomCallback,
    params.operation,
  );
}

export function ArtifactDownloadMenu({
  align = "end",
  ariaLabel,
  artifactKind,
  className,
  filename,
  iconSize = 16,
  menuInstanceKey,
  syncTarget,
  url,
}: ArtifactDownloadMenuProps) {
  const { t } = useTranslation();
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.downloadOptions;
    });
  const artifactDownloadKey = `${url}:${filename}`;
  const openKey = useGet(artifactDownloadMenuOpenKey$);
  const pendingKey = useGet(artifactDownloadPendingKey$);
  const openMenu = useSet(openArtifactDownloadMenu$);
  const closeMenu = useSet(closeArtifactDownloadMenu$);
  const startArtifactDownload = useSet(startArtifactDownload$);
  const finishArtifactDownload = useSet(finishArtifactDownload$);
  const downloadAttachment = useSet(downloadAttachment$);
  const pageSignal = useGet(pageSignal$);
  const open = openKey === `${menuInstanceKey}:${artifactDownloadKey}`;
  const downloadPending = pendingKey === artifactDownloadKey;
  const downloadName = artifactDownloadFilename(artifactKind, filename, url);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setArtifactDownloadMenuOpen({
          closeMenu,
          menuKey: `${menuInstanceKey}:${artifactDownloadKey}`,
          nextOpen,
          openMenu,
        });
      }}
    >
      <ArtifactActionTooltip label={label}>
        <DropdownMenuTrigger
          render={
            <ArtifactDownloadTrigger
              ariaLabel={label}
              className={className}
              downloadPending={downloadPending}
              iconSize={iconSize}
              open={open}
            />
          }
        />
      </ArtifactActionTooltip>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        className={cn("w-56", ARTIFACT_FLOATING_TRANSITION_CLASS)}
      >
        <DropdownMenuItem
          onClick={() => {
            startArtifactDownloadWithCleanup({
              operation: "artifact download",
              download: downloadAttachment(
                { filename: downloadName, url },
                pageSignal,
              ),
              downloadKey: artifactDownloadKey,
              finish: finishArtifactDownload,
              start: startArtifactDownload,
            });
          }}
        >
          <Download size={14} />
          {t(($) => {
            return $.artifacts.actions.download;
          })}
        </DropdownMenuItem>
        <GoogleDriveMenuItem syncTarget={syncTarget} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
