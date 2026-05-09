import {
  SUPPORTED_FRAMEWORKS,
  getInstructionsFilename,
} from "@vm0/core/frameworks";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { uploadStorageServerSide } from "./upload-storage";
import { logger } from "../../shared/logger";

const log = logger("storage:instruction-upload");

/**
 * Upload instructions directly to S3 from the server side.
 *
 * Bypasses the CLI's prepare -> presigned URL -> commit flow by writing
 * archive.tar.gz and manifest.json directly via putS3Object().
 * Used by server-side compose to upload instructions without a sandbox.
 */
export async function uploadInstructionsServerSide(params: {
  orgId: string;
  agentName: string;
  content: string;
  framework?: string;
}): Promise<{ storageName: string; versionId: string }> {
  const { orgId, agentName, content, framework } = params;

  const filename = getInstructionsFilename(framework);
  const filenames = [
    filename,
    ...SUPPORTED_FRAMEWORKS.map((supported) => {
      return getInstructionsFilename(supported);
    }),
  ].filter((entry, index, all) => {
    return all.indexOf(entry) === index;
  });
  const storageName = getInstructionsStorageName(agentName.toLowerCase());

  const result = await uploadStorageServerSide({
    orgId,
    storageName,
    files: filenames.map((name) => {
      return { filename: name, content };
    }),
    log,
  });

  log.debug(`Uploaded instructions for ${agentName}: ${result.versionId}`);
  return result;
}
