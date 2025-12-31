import { z } from "zod";
import fs from "fs";
import yaml from "yaml";

/**
 * Runner configuration schema
 */
export const runnerConfigSchema = z.object({
  name: z.string().min(1, "Name is required"),
  group: z
    .string()
    .regex(
      /^[a-z0-9-]+\/[a-z0-9-]+$/,
      "Group must be in format 'scope/name' (lowercase, hyphens allowed)",
    ),
  sandbox: z
    .object({
      max_concurrent: z.number().int().min(1).default(1),
      vcpu: z.number().int().min(1).default(2),
      memory_mb: z.number().int().min(128).default(2048),
    })
    .default({}),
  firecracker: z.object({
    binary: z.string().min(1, "Firecracker binary path is required"),
    kernel: z.string().min(1, "Kernel path is required"),
    rootfs: z.string().min(1, "Rootfs path is required"),
  }),
});

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

/**
 * Load and validate runner configuration from YAML file
 */
export function loadConfig(configPath: string): RunnerConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`runner.yaml not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const raw: unknown = yaml.parse(content);

  const result = runnerConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return result.data;
}

/**
 * Validate that firecracker paths exist on the filesystem
 */
export function validateFirecrackerPaths(
  config: RunnerConfig["firecracker"],
): void {
  const checks = [
    { path: config.binary, name: "Firecracker binary" },
    { path: config.kernel, name: "Kernel" },
    { path: config.rootfs, name: "Rootfs" },
  ];

  for (const check of checks) {
    if (!fs.existsSync(check.path)) {
      throw new Error(`${check.name} not found: ${check.path}`);
    }
  }
}
