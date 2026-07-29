import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import {
  IconBrandGoogleDrive,
  IconDownload,
  IconLoader2,
  IconShare,
} from "@tabler/icons-react";
import {
  cn,
  Popover,
  PopoverContent,
  PopoverOverlay,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { isConnectorAppOauthCallbackEnabled } from "@vm0/connectors/app-oauth-callback";
import {
  zeroConnectorOauthStartContract,
  zeroConnectorOpenIdStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import {
  OAUTH_API_BASE,
  zeroClient$,
  type ZeroClientFactory,
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
} from "../../signals/zero-page/zero-artifact-actions.ts";
import {
  syncArtifactFileToGoogleDrive,
  waitForGoogleDriveAuthorization$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import {
  getOnlyAvailableCatalogBrowserAuthMethodDetail,
  type ConnectorCatalogBrowserAuthMethodDetail,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  copyAttachmentLinkToClipboard,
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "./zero-attachment-url.ts";

const GOOGLE_DRIVE_CONNECTOR_SLUG = "google-drive";
const ARTIFACT_FLOATING_LAYER_CLASS =
  "!z-[10000] transition-[opacity,transform] duration-[180ms] ease data-[state=open]:!animate-none data-[state=closed]:!animate-none data-[state=open]:translate-y-0 data-[state=open]:opacity-100 data-[state=closed]:translate-y-2 data-[state=closed]:opacity-0";

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

function runWhenGoogleDriveReady(params: {
  agentId: string | null | undefined;
  authorizeConnected: boolean;
  pageSignal: AbortSignal;
  run: GoogleDriveReadyRun;
  waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
  description: string;
}): void {
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
        params.pageSignal,
      );
      await params.run();
    })(),
    Reason.DomCallback,
    params.description,
  );
}

function startGoogleDriveConnectAndRun(params: {
  agentId: string | null | undefined;
  authMethod: ConnectorCatalogBrowserAuthMethodDetail;
  connector: PublicConnectorCatalogStatusItem;
  createClient: ZeroClientFactory;
  pageSignal: AbortSignal;
  run: GoogleDriveReadyRun;
  waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
  description: string;
}): void {
  if (!params.agentId) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.googleDrive.agentLoading;
      }),
    );
    return;
  }
  const agentId = params.agentId;
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
        params: { connectorSlug: params.connector.connectorRef },
        body: {
          authMethod: params.authMethod.id,
          agentId,
          authorizeAgent: true as const,
        },
        fetchOptions: { signal: params.pageSignal },
      };
      const result =
        params.authMethod.grantKind === "openid-auth"
          ? await accept(
              params
                .createClient(zeroConnectorOpenIdStartContract, {
                  apiBase: "api",
                })
                .start(request),
              [200],
            )
          : await accept(
              params
                .createClient(zeroConnectorOauthStartContract, {
                  apiBase: OAUTH_API_BASE,
                })
                .start({
                  ...request,
                  body: {
                    ...request.body,
                    ...(isConnectorAppOauthCallbackEnabled(
                      params.connector.connectorRef,
                    )
                      ? { callbackTarget: "app" as const }
                      : {}),
                  },
                }),
              [200],
            );
      params.pageSignal.throwIfAborted();
      authWindow.location.href = result.body.authorizationUrl;
    })(),
    Reason.DomCallback,
    "artifact google drive oauth start",
  );
  runWhenGoogleDriveReady({
    agentId,
    authorizeConnected: false,
    pageSignal: params.pageSignal,
    run: params.run,
    waitForGoogleDriveAuthorization: params.waitForGoogleDriveAuthorization,
    description: params.description,
  });
}

function authorizeGoogleDriveAndRun(params: {
  agentId: string | null | undefined;
  pageSignal: AbortSignal;
  run: GoogleDriveReadyRun;
  waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
  description: string;
}): void {
  runWhenGoogleDriveReady({ ...params, authorizeConnected: true });
}

function iconButtonClassName(className?: string): string {
  return cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
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
  children: ReactNode;
  label: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className={ARTIFACT_FLOATING_LAYER_CLASS}>
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
        title={publicAttachmentUrl(url)}
        className={iconButtonClassName(className)}
      >
        <IconShare size={iconSize} stroke={1.5} />
      </a>
    </ArtifactActionTooltip>
  );
}

type ArtifactDownloadMenuItemProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "type"
> & {
  children: ReactNode;
};

function ArtifactDownloadMenuItem({
  children,
  className,
  disabled = false,
  ...props
}: ArtifactDownloadMenuItemProps) {
  return (
    <button
      {...props}
      type="button"
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      disabled={disabled}
      className={cn(
        "relative flex w-full select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        disabled ? "cursor-default" : "cursor-pointer",
        className,
      )}
    >
      {children}
    </button>
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
        connector.type === GOOGLE_DRIVE_CONNECTOR_SLUG &&
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
  label,
  muted = false,
}: {
  label: "connect" | "synced" | "upload";
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const text =
    label === "connect"
      ? t(($) => {
          return $.artifacts.googleDrive.connect;
        })
      : label === "synced"
        ? t(($) => {
            return $.artifacts.googleDrive.synced;
          })
        : t(($) => {
            return $.artifacts.googleDrive.upload;
          });
  return (
    <ArtifactDownloadMenuItem
      className={muted ? "text-muted-foreground" : ""}
      disabled
    >
      <IconBrandGoogleDrive size={14} stroke={1.5} />
      {text}
    </ArtifactDownloadMenuItem>
  );
}

function GoogleDriveMenuItem({
  closeMenu,
  syncTarget,
}: {
  closeMenu: () => void;
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
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);
  const waitForGoogleDriveAuthorization = useSet(
    waitForGoogleDriveAuthorization$,
  );

  if (!syncTarget) {
    return <GoogleDriveDisabledMenuItem label="upload" />;
  }

  if (syncTarget.synced) {
    return <GoogleDriveDisabledMenuItem label="synced" />;
  }

  if (!connectorListLoaded) {
    return (
      <GoogleDriveDisabledMenuItem
        label={syncTarget.disconnected ? "connect" : "upload"}
        muted={syncTarget.disconnected}
      />
    );
  }

  const syncOrConnect = () => {
    closeMenu();
    const run = async () => {
      const success = await syncArtifactFileToGoogleDrive({
        createClient,
        threadId: syncTarget.threadId,
        runId: syncTarget.runId,
        fileId: syncTarget.fileId,
        filename: syncTarget.filename,
        signal: pageSignal,
      });
      if (success) {
        syncTarget.onSyncSuccess();
      }
    };
    if (googleDriveReady) {
      detach(run(), Reason.DomCallback, "artifact google drive sync");
      return;
    }
    if (googleDriveConnected) {
      authorizeGoogleDriveAndRun({
        agentId: syncTarget.agentId,
        pageSignal,
        run,
        waitForGoogleDriveAuthorization,
        description: "artifact google drive authorize sync",
      });
      return;
    }
    if (!googleDriveConnector || !googleDriveAuthMethod) {
      return;
    }
    startGoogleDriveConnectAndRun({
      agentId: syncTarget.agentId,
      authMethod: googleDriveAuthMethod,
      connector: googleDriveConnector,
      createClient,
      pageSignal,
      run,
      waitForGoogleDriveAuthorization,
      description: "artifact google drive connect sync",
    });
  };

  if (googleDriveReady) {
    return (
      <ArtifactDownloadMenuItem onClick={syncOrConnect}>
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        {t(($) => {
          return $.artifacts.googleDrive.upload;
        })}
      </ArtifactDownloadMenuItem>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ArtifactDownloadMenuItem
            disabled={
              !googleDriveConnected &&
              (!googleDriveConnector || !googleDriveAuthMethod)
            }
            onClick={syncOrConnect}
          >
            <IconBrandGoogleDrive size={14} stroke={1.5} />
            {t(($) => {
              return $.artifacts.googleDrive.connect;
            })}
          </ArtifactDownloadMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left" className={ARTIFACT_FLOATING_LAYER_CLASS}>
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
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  ariaLabel: string;
  downloadPending: boolean;
  iconSize: number;
  open: boolean;
}) {
  return (
    <button
      {...props}
      type="button"
      aria-label={ariaLabel}
      aria-busy={downloadPending ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={downloadPending}
      className={iconButtonClassName(
        cn(
          "data-[state=open]:bg-muted/60 data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-70",
          className,
        ),
      )}
    >
      {downloadPending ? (
        <IconLoader2 size={iconSize} stroke={1.5} className="animate-spin" />
      ) : (
        <IconDownload size={iconSize} stroke={1.5} />
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
  readonly closeMenu: () => void;
  readonly description: string;
  readonly download: Promise<void>;
  readonly downloadKey: string;
  readonly finish: (key: string) => void;
  readonly start: (key: string) => void;
}): void {
  params.closeMenu();
  params.start(params.downloadKey);
  detach(
    withCleanup(params.download, () => {
      params.finish(params.downloadKey);
    }),
    Reason.DomCallback,
    params.description,
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
  const pageSignal = useGet(pageSignal$);
  const open = openKey === `${menuInstanceKey}:${artifactDownloadKey}`;
  const downloadPending = pendingKey === artifactDownloadKey;
  const downloadName = artifactDownloadFilename(artifactKind, filename, url);
  return (
    <Popover
      modal={false}
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
        <PopoverTrigger asChild>
          <ArtifactDownloadTrigger
            ariaLabel={label}
            className={className}
            downloadPending={downloadPending}
            iconSize={iconSize}
            open={open}
          />
        </PopoverTrigger>
      </ArtifactActionTooltip>
      {open && (
        <PopoverOverlay
          data-testid="artifact-download-menu-dismiss-layer"
          aria-label={t(($) => {
            return $.artifacts.actions.closeDownloadMenu;
          })}
          className="z-[9999]"
        />
      )}
      <PopoverContent
        role="menu"
        align={align}
        sideOffset={6}
        style={{ pointerEvents: "auto" }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        className={cn(
          "pointer-events-auto w-56 p-1",
          ARTIFACT_FLOATING_LAYER_CLASS,
        )}
      >
        <ArtifactDownloadMenuItem
          onClick={() => {
            startArtifactDownloadWithCleanup({
              closeMenu,
              description: "artifact download",
              download: downloadAttachmentUrl(url, pageSignal, downloadName),
              downloadKey: artifactDownloadKey,
              finish: finishArtifactDownload,
              start: startArtifactDownload,
            });
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          {t(($) => {
            return $.artifacts.actions.download;
          })}
        </ArtifactDownloadMenuItem>
        <GoogleDriveMenuItem closeMenu={closeMenu} syncTarget={syncTarget} />
      </PopoverContent>
    </Popover>
  );
}
