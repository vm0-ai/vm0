import { NextRequest } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { successResponse, errorResponse } from "../../../src/lib/api-response";
import {
  BadRequestError,
  UnauthorizedError,
  NotFoundError,
} from "../../../src/lib/errors";
import {
  upsertSecret,
  listSecrets,
  deleteSecret,
} from "../../../src/lib/secrets/secrets-service";

interface SetSecretRequest {
  name: string;
  value: string;
}

/**
 * GET /api/secrets
 * List all secrets for the authenticated user (names only)
 */
export async function GET() {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const secrets = await listSecrets(userId);

    return successResponse({ secrets });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/secrets
 * Create or update a secret
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const body: SetSecretRequest = await request.json();

    if (!body.name || typeof body.name !== "string") {
      throw new BadRequestError("Missing or invalid name");
    }

    if (!body.value || typeof body.value !== "string") {
      throw new BadRequestError("Missing or invalid value");
    }

    // Validate secret name format: alphanumeric and underscores, start with letter
    const nameRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
    if (!nameRegex.test(body.name)) {
      throw new BadRequestError(
        "Invalid secret name. Must start with a letter and contain only letters, numbers, and underscores.",
      );
    }

    if (body.name.length > 255) {
      throw new BadRequestError("Secret name must be 255 characters or less");
    }

    // 48 KB limit (same as GitHub Actions secrets)
    const MAX_SECRET_VALUE_BYTES = 48 * 1024;
    if (Buffer.byteLength(body.value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new BadRequestError("Secret value must be 48 KB or less");
    }

    const result = await upsertSecret(userId, body.name, body.value);

    return successResponse(
      {
        name: body.name,
        action: result.action,
      },
      result.action === "created" ? 201 : 200,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/secrets?name={name}
 * Delete a secret by name
 */
export async function DELETE(request: NextRequest) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");

    if (!name) {
      throw new BadRequestError("Missing name query parameter");
    }

    const deleted = await deleteSecret(userId, name);

    if (!deleted) {
      throw new NotFoundError(`Secret not found: ${name}`);
    }

    return successResponse({ name, deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
