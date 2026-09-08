import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  isUserImageReferenceId,
  parseUserImageReferenceId,
} from "@okouai/core/image-reference-selection";

import type { ReadonlyDb } from "../external/db";
import { loadAccessibleImageReferencesById } from "./image-reference-data.service";

interface SelectedImageReferences {
  readonly ids: readonly string[];
  readonly malformed: boolean;
}

function selectedImageReferences(
  generationTemplates: readonly GenerationTemplateRequest[],
): SelectedImageReferences {
  const ids = new Set<string>();
  let malformed = false;
  for (const template of generationTemplates) {
    if (template.type !== "illustration") {
      continue;
    }
    const selectionId = template.selection.illustrationStyleId;
    if (!isUserImageReferenceId(selectionId)) {
      continue;
    }
    const referenceId = parseUserImageReferenceId(selectionId);
    if (referenceId === undefined) {
      malformed = true;
      continue;
    }
    ids.add(referenceId);
  }
  return { ids: [...ids], malformed };
}

/**
 * Re-authorize every saved reference carried by a message at the current
 * dispatch boundary. Missing and inaccessible rows deliberately share one
 * result so callers cannot use chat submission as an existence oracle.
 */
export async function imageReferenceSelectionsAreAvailable(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly generationTemplates: readonly GenerationTemplateRequest[];
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<boolean> {
  const selected = selectedImageReferences(args.generationTemplates);
  if (selected.ids.length === 0 && !selected.malformed) {
    return true;
  }
  if (
    selected.malformed ||
    !isFeatureEnabled(
      FeatureSwitchKey.ReferenceImages,
      args.featureSwitchContext,
    )
  ) {
    return false;
  }
  const rows = await loadAccessibleImageReferencesById(db, {
    orgId: args.orgId,
    userId: args.userId,
    referenceIds: selected.ids,
  });
  return rows.length === selected.ids.length;
}
