import { command, computed, state } from "ccstate";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { resolveApiBase } from "./api-base.ts";
import { isAuthenticatedAttachmentUrl } from "./attachment-resource-url.ts";
import { pageVersion$ } from "./page-signal.ts";

function artifactSharingTarget(url: string): ArtifactShareTarget | null {
  const id = privateHostedDeploymentId(url, resolveApiBase());
  if (id) {
    return { kind: "html", id };
  }
  if (!isAuthenticatedAttachmentUrl(url)) {
    return null;
  }
  const fileId = new URL(url).searchParams.get("file_id");
  return fileId ? { kind: "file", id: fileId } : null;
}

export function isShareableArtifactReference(url: string): boolean {
  return (
    parseArtifactReference(url, location.origin) !== null ||
    artifactSharingTarget(url) !== null
  );
}

const resolveSharingTarget$ = command(
  async ({ get }, url: string, signal: AbortSignal) => {
    const reference = parseArtifactReference(url, location.origin);
    if (!reference) {
      return artifactSharingTarget(url);
    }
    const response = await accept(
      get(apiClient$)(artifactReferencesContract).resolve({
        params: { reference: `${reference.hash}${reference.extension}` },
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200],
      signal,
    );
    return response.body.target;
  },
);

interface PageArtifactShareStatuses {
  readonly pageVersion: number;
  readonly statuses: Readonly<Record<string, ArtifactShareStatus>>;
}

const pageStatusState$ = state<PageArtifactShareStatuses>({
  pageVersion: -1,
  statuses: {},
});
export const artifactShareStatuses$ = computed((get) => {
  const current = get(pageStatusState$);
  return current.pageVersion === get(pageVersion$) ? current.statuses : {};
});

function withArtifactShareStatus(
  current: PageArtifactShareStatuses,
  pageVersion: number,
  url: string,
  status: ArtifactShareStatus,
): PageArtifactShareStatuses {
  return {
    pageVersion,
    statuses: {
      ...(current.pageVersion === pageVersion ? current.statuses : {}),
      [url]: status,
    },
  };
}

export const loadArtifactShare$ = command(
  async ({ get, set }, url: string, signal: AbortSignal) => {
    const pageVersion = get(pageVersion$);
    const target = await set(resolveSharingTarget$, url, signal);
    if (!target) {
      return;
    }
    const response = await accept(
      get(apiClient$)(artifactSharesContract).status({
        body: target,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    if (get(pageVersion$) !== pageVersion) {
      return;
    }
    set(pageStatusState$, (current) => {
      return withArtifactShareStatus(current, pageVersion, url, response.body);
    });
  },
);

export const shareArtifact$ = command(
  async (
    { get, set },
    args: {
      readonly url: string;
      readonly audience: Exclude<ArtifactShareStatus["audience"], "private">;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const pageVersion = get(pageVersion$);
    const status = get(artifactShareStatuses$)[args.url];
    if (
      status?.url &&
      status.audience === args.audience &&
      status.selectedTarget &&
      status.selectedVersion === status.candidateVersion
    ) {
      return status.url;
    }
    const target = await set(resolveSharingTarget$, args.url, signal);
    if (!target) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(artifactSharesContract).update({
        body: { target, audience: args.audience },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (get(pageVersion$) !== pageVersion) {
      return null;
    }
    set(pageStatusState$, (current) => {
      return withArtifactShareStatus(
        current,
        pageVersion,
        args.url,
        response.body,
      );
    });
    return response.body.url;
  },
);
