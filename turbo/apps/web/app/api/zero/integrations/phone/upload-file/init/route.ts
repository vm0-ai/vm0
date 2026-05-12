import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsPhoneUploadInitContract } from "@vm0/api-contracts/contracts/integrations";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { generatePresignedPutUrl } from "../../../../../../../src/lib/infra/s3/s3-client";
import { buildFileUrl } from "../../../../../../../src/lib/zero/uploads/file-url";
import { env } from "../../../../../../../src/env";

const PUT_URL_TTL_SECONDS = 3600;

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const router = tsr.router(integrationsPhoneUploadInitContract, {
  init: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "phone:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const uploadId = crypto.randomUUID();
    const filename = sanitizeFilename(body.filename);
    const s3Key = `uploads/${authCtx.userId}/${uploadId}/${filename}`;
    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
    const uploadUrl = await generatePresignedPutUrl(
      bucket,
      s3Key,
      body.contentType,
      PUT_URL_TTL_SECONDS,
      true,
    );

    return {
      status: 200 as const,
      body: {
        uploadId,
        uploadUrl,
        fileUrl: buildFileUrl(authCtx.userId, uploadId, filename),
        filename,
        contentType: body.contentType,
        size: body.length,
      },
    };
  },
});

const handler = createHandler(integrationsPhoneUploadInitContract, router, {
  routeName: "zero.integrations.phone.upload-file.init",
});

export { handler as POST };
