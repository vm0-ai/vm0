import { command, computed, state } from "ccstate";
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
import { pageSignal$ } from "./page-signal.ts";

export function artifactSharingTarget(url: string): ArtifactShareTarget | null {
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

const pageStatusState$ = computed((get) => {
  get(pageSignal$);
  return state<Readonly<Record<string, ArtifactShareStatus>>>({});
});
export const artifactShareStatuses$ = computed((get) => {
  return get(get(pageStatusState$));
});

export const loadArtifactShare$ = command(
  async ({ get, set }, url: string, signal: AbortSignal) => {
    const target = artifactSharingTarget(url);
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
    set(get(pageStatusState$), (previous) => {
      return {
        ...previous,
        [url]: response.body,
      };
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
    const target = artifactSharingTarget(args.url);
    if (!target) {
      return null;
    }
    const status = get(artifactShareStatuses$)[args.url];
    if (
      status?.url &&
      status.audience === args.audience &&
      status.selectedTarget?.kind === target.kind &&
      status.selectedTarget.id === target.id
    ) {
      return status.url;
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
    set(get(pageStatusState$), (previous) => {
      return {
        ...previous,
        [args.url]: response.body,
      };
    });
    return response.body.url;
  },
);
