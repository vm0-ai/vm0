import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const skillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  vm0_secrets: z.array(z.string()).optional(),
  vm0_vars: z.array(z.string()).optional(),
});

const resolvedSkillSchema = z.object({
  storageName: z.string(),
  versionHash: z.string(),
  frontmatter: skillFrontmatterSchema,
});

export const skillsResolveContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/skills/resolve",
    headers: authHeadersSchema,
    body: z.object({
      skills: z.array(z.url()).min(1).max(100),
    }),
    responses: {
      200: z.object({
        resolved: z.record(z.string(), resolvedSkillSchema),
        unresolved: z.array(z.string()),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Batch resolve skill URLs to cached version info",
  },
});

export type SkillsResolveContract = typeof skillsResolveContract;
