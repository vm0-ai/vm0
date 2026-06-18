import { computed, type Computed } from "ccstate";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import type { ZeroWorkflowDetailResponse } from "@vm0/api-contracts/contracts/zero-workflows";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadS3Buffer, downloadManifest } from "../external/s3";
import { settle } from "../utils";
import { env } from "../../lib/env";
import { extractFilesFromTarGz } from "../../lib/tar";
import {
  loadVisibleWorkflow,
  workflowSummary,
  type WorkflowMember,
} from "./zero-workflow-data.service";
import { loadWorkflowTriggers } from "./zero-workflow-trigger.service";

const SKILL_FILENAME = "SKILL.md";

interface WorkflowContentResult {
  readonly content: string | null;
  readonly files: { readonly path: string; readonly size: number }[] | null;
  readonly fileContents:
    | { readonly path: string; readonly content: string }[]
    | null;
}

function emptyWorkflowContent(): WorkflowContentResult {
  return {
    content: null,
    files: null,
    fileContents: null,
  };
}

function isMissingS3ObjectError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly Code?: string;
    readonly code?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  const code = candidate.Code ?? candidate.code ?? candidate.name;
  return (
    code === "NoSuchKey" ||
    code === "NotFound" ||
    (candidate.name === "NotFound" &&
      candidate.$metadata?.httpStatusCode === 404)
  );
}

export function zeroWorkflowDetail(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowName: string;
}): Computed<Promise<ZeroWorkflowDetailResponse | null>> {
  return computed(async (get): Promise<ZeroWorkflowDetailResponse | null> => {
    const db = get(db$);
    const workflow = await loadVisibleWorkflow(db, {
      orgId: args.orgId,
      userId: args.member.userId,
      name: args.workflowName,
    });

    if (!workflow) {
      return null;
    }

    const summary = await workflowSummary(db, {
      workflow,
      member: args.member,
    });

    const content = await loadWorkflowContent(get, {
      orgId: args.orgId,
      workflowName: args.workflowName,
    });

    const triggers = await loadWorkflowTriggers(db, {
      orgId: args.orgId,
      workflowId: workflow.id,
    });

    return { ...summary, ...content, triggers: [...triggers] };
  });
}

async function loadWorkflowContent(
  get: <T>(computedValue: Computed<T>) => T,
  args: { readonly orgId: string; readonly workflowName: string },
): Promise<WorkflowContentResult> {
  const storageName = getCustomSkillStorageName(args.workflowName);
  const [storage] = await get(db$)
    .select({ headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);

  if (!storage?.headVersionId) {
    return emptyWorkflowContent();
  }

  const [version] = await get(db$)
    .select({ s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(eq(storageVersions.id, storage.headVersionId))
    .limit(1);

  if (!version) {
    return emptyWorkflowContent();
  }

  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return emptyWorkflowContent();
  }

  const manifestResult = await settle(
    get(downloadManifest(bucket, version.s3Key)),
  );
  if (!manifestResult.ok) {
    if (isMissingS3ObjectError(manifestResult.error)) {
      return emptyWorkflowContent();
    }
    throw manifestResult.error;
  }
  const manifest = manifestResult.value;
  const normalize = (p: string): string => {
    return p.replace(/^\.\//, "");
  };

  const filesList = manifest.files.map((f) => {
    return {
      path: normalize(f.path),
      size: f.size,
    };
  });

  const archiveKey = `${version.s3Key}/archive.tar.gz`;
  const archiveResult = await settle(get(downloadS3Buffer(bucket, archiveKey)));
  if (!archiveResult.ok) {
    if (isMissingS3ObjectError(archiveResult.error)) {
      return emptyWorkflowContent();
    }
    throw archiveResult.error;
  }
  const archiveBuffer = archiveResult.value;
  const fileContents = extractFilesFromTarGz(
    archiveBuffer,
    filesList.map((file) => {
      return file.path;
    }),
  );
  const skillFileContent = fileContents.find((file) => {
    return normalize(file.path) === SKILL_FILENAME;
  });

  return {
    content: skillFileContent?.content ?? null,
    files: filesList,
    fileContents: [...fileContents],
  };
}
