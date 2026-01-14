import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { apiClient, type ApiError } from "../../lib/api/api-client";
import { scheduleYamlSchema } from "@vm0/core";
import { toISODateTime } from "../../lib/domain/schedule-utils";

/**
 * Schedule definition type - matches what's in the YAML
 */
interface ScheduleDefinition {
  on: {
    cron?: string;
    at?: string;
    timezone?: string;
  };
  run: {
    agent: string;
    prompt: string;
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    artifactName?: string;
    artifactVersion?: string;
    volumeVersions?: Record<string, string>;
  };
}

/**
 * Schedule response from API
 */
interface ScheduleResponse {
  id: string;
  name: string;
  cronExpression: string | null;
  atTime: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  composeName: string;
  scopeSlug: string;
}

interface DeployResponse {
  schedule: ScheduleResponse;
  created: boolean;
}

/**
 * Expand environment variables in a string
 * Supports ${VAR} syntax
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(
        chalk.yellow(`  Warning: Environment variable ${varName} not set`),
      );
      return match; // Keep original if not set
    }
    return envValue;
  });
}

/**
 * Expand env vars in an object recursively
 */
function expandEnvVarsInObject(
  obj: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!obj) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = expandEnvVars(value);
  }
  return result;
}

export const deployCommand = new Command()
  .name("deploy")
  .description("Deploy a schedule from schedule.yaml (create or update)")
  .argument("[file]", "Path to schedule.yaml", "schedule.yaml")
  .action(async (file: string) => {
    try {
      // Check if file exists
      if (!existsSync(file)) {
        console.error(chalk.red(`✗ File not found: ${file}`));
        console.error(chalk.dim("  Create a schedule.yaml file first"));
        process.exit(1);
      }

      // Read and parse YAML
      const content = readFileSync(file, "utf-8");
      let parsed: unknown;
      try {
        parsed = parseYaml(content);
      } catch (err) {
        console.error(chalk.red("✗ Invalid YAML syntax"));
        if (err instanceof Error) {
          console.error(chalk.dim(`  ${err.message}`));
        }
        process.exit(1);
      }

      // Validate schema
      const result = scheduleYamlSchema.safeParse(parsed);
      if (!result.success) {
        console.error(chalk.red("✗ Invalid schedule.yaml format"));
        for (const issue of result.error.issues) {
          console.error(
            chalk.dim(`  ${issue.path.join(".")}: ${issue.message}`),
          );
        }
        process.exit(1);
      }

      const scheduleYaml = result.data;

      // Process each schedule
      const scheduleEntries = Object.entries(scheduleYaml.schedules) as [
        string,
        ScheduleDefinition,
      ][];

      if (scheduleEntries.length === 0) {
        console.error(chalk.red("✗ No schedules defined in file"));
        process.exit(1);
      }

      if (scheduleEntries.length > 1) {
        console.error(
          chalk.red("✗ Multiple schedules per file not supported yet"),
        );
        console.error(chalk.dim("  Please use one schedule per file"));
        process.exit(1);
      }

      const [scheduleName, schedule] = scheduleEntries[0]!;

      console.log(`Deploying schedule ${chalk.cyan(scheduleName)}...`);

      // Resolve agent reference to compose ID
      const agentRef = schedule.run.agent;
      let composeId: string;

      try {
        // Parse agent reference: [scope/]name[:version]
        // For now, just use the name part
        const namePart = agentRef.includes("/")
          ? agentRef.split("/").pop()!
          : agentRef;
        const agentName = namePart.includes(":")
          ? namePart.split(":")[0]!
          : namePart;

        const compose = await apiClient.getComposeByName(agentName);
        composeId = compose.id;
      } catch {
        console.error(chalk.red(`✗ Agent not found: ${agentRef}`));
        console.error(chalk.dim("  Make sure the agent is pushed first"));
        process.exit(1);
      }

      // Expand environment variables
      const expandedVars = expandEnvVarsInObject(schedule.run.vars);
      const expandedSecrets = expandEnvVarsInObject(schedule.run.secrets);

      // Build deploy request
      // Convert human-readable "YYYY-MM-DD HH:MM" format to ISO for the API
      const atTime = schedule.on.at ? toISODateTime(schedule.on.at) : undefined;

      const body = {
        name: scheduleName,
        composeId,
        cronExpression: schedule.on.cron,
        atTime,
        timezone: schedule.on.timezone || "UTC",
        prompt: schedule.run.prompt,
        vars: expandedVars,
        secrets: expandedSecrets,
        artifactName: schedule.run.artifactName,
        artifactVersion: schedule.run.artifactVersion,
        volumeVersions: schedule.run.volumeVersions,
      };

      // Call API
      const response = await apiClient.post("/api/agent/schedules", {
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Deploy failed");
      }

      const deployResult = (await response.json()) as DeployResponse;

      // Display result
      if (deployResult.created) {
        console.log(
          chalk.green(`✓ Created schedule ${chalk.cyan(scheduleName)}`),
        );
      } else {
        console.log(
          chalk.green(`✓ Updated schedule ${chalk.cyan(scheduleName)}`),
        );
      }

      // Show next run time
      if (deployResult.schedule.nextRunAt) {
        const nextRun = new Date(deployResult.schedule.nextRunAt);
        console.log(chalk.dim(`  Next run: ${nextRun.toLocaleString()}`));
      }

      if (deployResult.schedule.cronExpression) {
        console.log(
          chalk.dim(
            `  Cron: ${deployResult.schedule.cronExpression} (${deployResult.schedule.timezone})`,
          ),
        );
      } else if (deployResult.schedule.atTime) {
        console.log(chalk.dim(`  At: ${deployResult.schedule.atTime}`));
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to deploy schedule"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
