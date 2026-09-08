import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Share2, Users, Globe, Link, Lock } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  artifactShareStatuses$,
  changeArtifactShare$,
  loadArtifactShare$,
} from "../../signals/artifact-sharing.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { copyAttachmentLinkToClipboard } from "./attachment-url.ts";

function ArtifactSharingSummary({
  status,
}: {
  readonly status: ArtifactShareStatus | undefined;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        {!status
          ? t(($) => {
              return $.artifacts.sharing.loading;
            })
          : status.audience === "private"
            ? t(($) => {
                return $.artifacts.sharing.private;
              })
            : status.audience === "public"
              ? t(($) => {
                  return $.artifacts.sharing.public;
                })
              : t(
                  ($) => {
                    return $.artifacts.sharing.organization;
                  },
                  {
                    name: status.organization.name,
                  },
                )}
      </div>
      {status && status.selectedVersion !== null && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.sharing.sharedVersion;
            },
            {
              version: status.selectedVersion,
            },
          )}
        </div>
      )}
      <DropdownMenuSeparator />
      {status && status.candidateVersion !== null && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.sharing.selectedVersion;
            },
            {
              version: status.candidateVersion,
            },
          )}
        </div>
      )}
    </>
  );
}

export function ArtifactShareMenu({
  url,
  className,
  iconSize = 16,
  ariaLabel,
}: {
  readonly url: string;
  readonly className?: string;
  readonly iconSize?: number;
  readonly ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const states = useLastResolved(artifactShareStatuses$);
  const status = states?.[url];
  const [loading, load] = useLoadableSet(loadArtifactShare$);
  const [changing, change] = useLoadableSet(changeArtifactShare$);
  const ready =
    loading.state === "hasData" && changing.state !== "loading" && status;
  const copy = status?.url;
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          detach(
            load(url, signal),
            Reason.DomCallback,
            "read artifact sharing",
          );
        }
      }}
    >
      <DropdownMenuTrigger
        disabled={changing.state === "loading"}
        aria-label={
          ariaLabel ??
          t(($) => {
            return $.artifacts.actions.share;
          })
        }
        render={<Button variant="quiet" size="icon-sm" className={className} />}
      >
        <Share2 size={iconSize} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <ArtifactSharingSummary status={ready ? status : undefined} />
        <DropdownMenuItem
          disabled={!ready}
          onClick={() => {
            return detach(
              change({ url, audience: "organization" }, signal),
              Reason.DomCallback,
              "share artifact to organization",
            );
          }}
        >
          <Users size={14} />
          {t(($) => {
            return $.artifacts.sharing.shareOrganization;
          })}
        </DropdownMenuItem>
        {ready && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {status.organization.name}
          </div>
        )}
        <DropdownMenuItem
          disabled={!ready}
          onClick={() => {
            return detach(
              change({ url, audience: "public" }, signal),
              Reason.DomCallback,
              "make artifact public",
            );
          }}
        >
          <Globe size={14} />
          {t(($) => {
            return $.artifacts.sharing.sharePublic;
          })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!ready || !copy}
          onClick={() => {
            if (copy) {
              detach(
                copyAttachmentLinkToClipboard(copy),
                Reason.DomCallback,
                "copy artifact share link",
              );
            }
          }}
        >
          <Link size={14} />
          {t(($) => {
            return $.artifacts.sharing.copy;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!ready || status.audience === "private"}
          onClick={() => {
            return detach(
              change({ url, audience: "private" }, signal),
              Reason.DomCallback,
              "stop artifact sharing",
            );
          }}
        >
          <Lock size={14} />
          {t(($) => {
            return $.artifacts.sharing.stop;
          })}
        </DropdownMenuItem>
        <div className="px-2 py-1.5 text-xs text-muted-foreground whitespace-normal">
          {t(($) => {
            return $.artifacts.sharing.expiry;
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
