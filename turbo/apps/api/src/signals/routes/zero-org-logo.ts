import { command, computed } from "ccstate";
import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { safeAsync } from "../utils";
import type { RouteEntry } from "../route";

const MAX_FILE_SIZE = 2 * 1024 * 1024;

const orgLogoNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Org not found",
      code: "BAD_REQUEST",
    }),
  }),
});

function orgLogoBadRequest(message: string) {
  return {
    status: 400 as const,
    body: { error: { message, code: "BAD_REQUEST" } },
  };
}

function orgLogoForbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "BAD_REQUEST" } },
  };
}

function isOrgLookupNotFound(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "BadRequestError" || error.name === "NotFoundError")
  );
}

function isOrgLookupForbidden(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ForbiddenError" ||
      Reflect.get(error, "statusCode") === 403 ||
      Reflect.get(error, "code") === "FORBIDDEN")
  );
}

function isAllowedLogoType(type: string): boolean {
  return (
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/gif" ||
    type === "image/webp"
  );
}

const getOrgLogoInner$ = computed(async (get) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return orgLogoNotFound;
  }

  const client = get(clerk$);
  const result = await safeAsync(() => {
    return client.organizations.getOrganization({
      organizationId: auth.orgId,
    });
  });

  if ("error" in result) {
    if (isOrgLookupNotFound(result.error)) {
      return orgLogoNotFound;
    }
    throw result.error;
  }

  return {
    status: 200 as const,
    body: {
      logoUrl: result.ok.imageUrl || null,
      hasImage: result.ok.hasImage,
    },
  };
});

const postOrgLogoInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const orgId = auth.orgId;
  if (!orgId) {
    return orgLogoNotFound;
  }

  if (auth.orgRole !== "admin") {
    return orgLogoForbidden("Only admins can upload the logo");
  }

  const request = get(request$);
  const formData = await request.raw.formData();
  signal.throwIfAborted();

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return orgLogoBadRequest("No file provided");
  }

  if (file.size > MAX_FILE_SIZE) {
    return orgLogoBadRequest("File too large (max 2 MB)");
  }

  if (!isAllowedLogoType(file.type)) {
    return orgLogoBadRequest(`Unsupported file type: ${file.type}`);
  }

  const client = get(clerk$);
  const result = await safeAsync(() => {
    return client.organizations.updateOrganizationLogo(orgId, { file });
  });
  signal.throwIfAborted();

  if ("error" in result) {
    if (isOrgLookupNotFound(result.error)) {
      return orgLogoNotFound;
    }
    if (isOrgLookupForbidden(result.error)) {
      return orgLogoForbidden("Access denied");
    }
    throw result.error;
  }

  return {
    status: 200 as const,
    body: {
      logoUrl: result.ok.imageUrl || null,
      hasImage: result.ok.hasImage,
    },
  };
});

const deleteOrgLogoInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const orgId = auth.orgId;
  if (!orgId) {
    return orgLogoNotFound;
  }

  if (auth.orgRole !== "admin") {
    return orgLogoForbidden("Only admins can remove the logo");
  }

  const client = get(clerk$);
  const result = await safeAsync(() => {
    return client.organizations.deleteOrganizationLogo(orgId);
  });
  signal.throwIfAborted();

  if ("error" in result) {
    if (isOrgLookupNotFound(result.error)) {
      return orgLogoNotFound;
    }
    if (isOrgLookupForbidden(result.error)) {
      return orgLogoForbidden("Access denied");
    }
    throw result.error;
  }

  return {
    status: 200 as const,
    body: {
      logoUrl: result.ok.imageUrl || null,
      hasImage: result.ok.hasImage,
    },
  };
});

export const zeroOrgLogoRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgLogoContract.get,
    handler: authRoute({}, getOrgLogoInner$),
  },
  {
    route: zeroOrgLogoContract.post,
    handler: authRoute({}, postOrgLogoInner$),
  },
  {
    route: zeroOrgLogoContract.delete,
    handler: authRoute({}, deleteOrgLogoInner$),
  },
];
