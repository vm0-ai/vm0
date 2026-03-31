import {
  createHandler,
  tsr,
  createSafeErrorHandler,
} from "../../../../src/lib/ts-rest-handler";
import {
  skillsResolveContract,
  skillFrontmatterSchema,
  createErrorResponse,
  getSkillStorageName,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { skills } from "../../../../src/db/schema/skill";
import { inArray } from "drizzle-orm";
import { z } from "zod";

const router = tsr.router(skillsResolveContract, {
  resolve: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    // Batch query skills by URL
    const rows = await globalThis.services.db
      .select({
        url: skills.url,
        fullPath: skills.fullPath,
        versionHash: skills.versionHash,
        frontmatter: skills.frontmatter,
      })
      .from(skills)
      .where(inArray(skills.url, body.skills));

    // Build resolved map
    const resolved: Record<
      string,
      {
        storageName: string;
        versionHash: string;
        frontmatter: z.infer<typeof skillFrontmatterSchema>;
      }
    > = {};

    const foundUrls = new Set<string>();

    for (const row of rows) {
      if (!row.versionHash) continue; // Skip skills not yet synced
      foundUrls.add(row.url);

      const fm = skillFrontmatterSchema.parse(row.frontmatter ?? {});

      resolved[row.url] = {
        storageName: getSkillStorageName(row.fullPath),
        versionHash: row.versionHash,
        frontmatter: fm,
      };
    }

    // Unresolved = requested but not found (or not yet synced)
    const unresolved = body.skills.filter((url: string) => {
      return !foundUrls.has(url);
    });

    return {
      status: 200 as const,
      body: { resolved, unresolved },
    };
  },
});

const handler = createHandler(skillsResolveContract, router, {
  errorHandler: createSafeErrorHandler("skills-resolve"),
});

export { handler as POST };
