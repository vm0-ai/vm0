import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../../env";

let s3Client: S3Client | null = null;
let publicS3Client: S3Client | null = null;
let userArtifactsS3Client: S3Client | null = null;
let userArtifactsPublicS3Client: S3Client | null = null;

interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function createS3Client(
  endpoint: string,
  credentials: S3Credentials,
): S3Client {
  const envVars = env();
  const region = envVars.S3_REGION || "auto";
  const forcePathStyle = envVars.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    endpoint,
    credentials,
    forcePathStyle,
  });
}

function defaultS3Endpoint(): string {
  const envVars = env();
  return (
    envVars.S3_ENDPOINT ||
    `https://${envVars.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  );
}

function defaultS3Credentials(): S3Credentials {
  const envVars = env();
  return {
    accessKeyId: envVars.R2_ACCESS_KEY_ID,
    secretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
  };
}

function userArtifactsS3Credentials(): S3Credentials {
  const envVars = env();
  return {
    accessKeyId: envVars.R2_USER_ARTIFACTS_ACCESS_KEY_ID,
    secretAccessKey: envVars.R2_USER_ARTIFACTS_SECRET_ACCESS_KEY,
  };
}

/**
 * Get S3 client singleton for server-to-S3 operations.
 * Uses S3_ENDPOINT which may be a container-internal address (e.g. http://minio:9000).
 */
function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  s3Client = createS3Client(defaultS3Endpoint(), defaultS3Credentials());
  return s3Client;
}

/**
 * Get S3 client singleton for generating presigned URLs consumed by external clients
 * (CLI, browsers). Uses S3_PUBLIC_ENDPOINT so the resulting URLs
 * are reachable from outside the Docker network. Falls back to the internal
 * endpoint when S3_PUBLIC_ENDPOINT is not set (e.g. SaaS / R2).
 */
function getPublicS3Client(): S3Client {
  if (publicS3Client) return publicS3Client;

  const envVars = env();

  const publicEndpoint = envVars.S3_PUBLIC_ENDPOINT;
  if (!publicEndpoint) {
    publicS3Client = getS3Client();
    return publicS3Client;
  }

  publicS3Client = createS3Client(publicEndpoint, defaultS3Credentials());
  return publicS3Client;
}

function getUserArtifactsS3Client(): S3Client {
  if (userArtifactsS3Client) return userArtifactsS3Client;

  userArtifactsS3Client = createS3Client(
    defaultS3Endpoint(),
    userArtifactsS3Credentials(),
  );
  return userArtifactsS3Client;
}

function getUserArtifactsPublicS3Client(): S3Client {
  if (userArtifactsPublicS3Client) return userArtifactsPublicS3Client;

  const publicEndpoint = env().S3_PUBLIC_ENDPOINT;
  if (!publicEndpoint) {
    userArtifactsPublicS3Client = getUserArtifactsS3Client();
    return userArtifactsPublicS3Client;
  }

  userArtifactsPublicS3Client = createS3Client(
    publicEndpoint,
    userArtifactsS3Credentials(),
  );
  return userArtifactsPublicS3Client;
}

function getS3ClientForBucket(
  bucket: string,
  usePublicEndpoint = false,
): S3Client {
  if (bucket === env().R2_USER_ARTIFACTS_BUCKET_NAME) {
    return usePublicEndpoint
      ? getUserArtifactsPublicS3Client()
      : getUserArtifactsS3Client();
  }
  return usePublicEndpoint ? getPublicS3Client() : getS3Client();
}

/**
 * Generate presigned URL for downloading a single S3 object.
 * Set usePublicEndpoint=true when the URL is consumed by external clients
 * (CLI, browsers) rather than by sandbox containers in the Docker network.
 */
export async function generatePresignedUrl(
  bucket: string,
  key: string,
  expiresIn: number = 86400,
  filename?: string,
  usePublicEndpoint: boolean = false,
): Promise<string> {
  const client = getS3ClientForBucket(bucket, usePublicEndpoint);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(filename && {
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Check if an S3 object exists using HeadObject
 * Does not download the object content, only checks metadata
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @returns true if object exists, false if not found
 * @throws Error for other S3 errors (permissions, etc.)
 */
export async function s3ObjectExists(
  bucket: string,
  key: string,
): Promise<boolean> {
  const client = getS3ClientForBucket(bucket);

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return true;
  } catch (error) {
    // NotFound is the expected error when object doesn't exist
    if ((error as { name?: string }).name === "NotFound") {
      return false;
    }
    // Re-throw other errors (permissions, etc.)
    throw error;
  }
}
