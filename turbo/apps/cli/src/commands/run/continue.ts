import { Command, Option } from "commander";
import { getSession, createRun } from "../../lib/api";
import {
  collectKeyValue,
  collectMounts,
  collectArtifacts,
  isUUID,
  loadValues,
  parsePermissionPolicies,
  pollEvents,
  showNextSteps,
  renderRunCreated,
} from "./shared";
import { withErrorHandler } from "../../lib/command";

/**
 * Pick the first truthy value, falling back to `undefined`. Used to merge
 * commander.js subcommand options with parent options when a flag can land
 * on either depending on argv ordering. Extracted to keep the action
 * handler's cyclomatic complexity below the lint threshold.
 */
function pickOpt<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a || b || undefined;
}

export const continueCommand = new Command()
  .name("continue")
  .description(
    "Continue an agent run from a session (uses latest artifact version)",
  )
  .argument("<agentSessionId>", "Agent session ID to continue from")
  .argument("<prompt>", "Prompt for the continued agent")
  .option(
    "--env-file <path>",
    "Load environment variables from file (priority: CLI flags > file > env vars)",
  )
  .option(
    "--vars <KEY=value>",
    "Variables for ${{ vars.xxx }} (repeatable, falls back to --env-file or env vars)",
    collectKeyValue,
    {},
  )
  .option(
    "--secrets <KEY=value>",
    "Secrets for ${{ secrets.xxx }} (repeatable, falls back to --env-file or env vars)",
    collectKeyValue,
    {},
  )
  .option(
    "--artifact <artifact>",
    "Mount an artifact (repeatable, format: name:/path or name:version:/path)",
    collectArtifacts,
    [],
  )
  .option(
    "--volume <volume>",
    "Mount a volume (repeatable, format: name:/path or name:version:/path)",
    collectMounts,
    [],
  )
  .option(
    "--append-system-prompt <text>",
    "Append text to the agent's system prompt",
  )
  .option(
    "--disallowed-tools <tools...>",
    "Tools to disable in Claude CLI (e.g., CronCreate WebSearch)",
  )
  .option(
    "--tools <tools...>",
    "Built-in tools to make available in Claude CLI (e.g., Bash Edit Read)",
  )
  .option(
    "--settings <json>",
    "Settings JSON to pass to Claude CLI (e.g., hooks, permissions)",
  )
  .option(
    "--permission-policies <json>",
    'Permission policies JSON (e.g., \'{"github": {"actions:read": "allow"}}\')',
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .addOption(new Option("--debug-no-mock-codex").hideHelp())
  .action(
    withErrorHandler(
      async (
        agentSessionId: string,
        prompt: string,
        options: {
          envFile?: string;
          vars: Record<string, string>;
          secrets: Record<string, string>;
          artifact: Array<{
            name: string;
            version?: string;
            mountPath: string;
          }>;
          appendSystemPrompt?: string;
          disallowedTools?: string[];
          tools?: string[];
          settings?: string;
          permissionPolicies?: string;
          verbose?: boolean;
          debugNoMockClaude?: boolean;
          debugNoMockCodex?: boolean;
        },
        command: { optsWithGlobals: () => Record<string, unknown> },
      ) => {
        // Commander.js quirk: when parent command has same option name,
        // the option value goes to parent. Use optsWithGlobals() to get all options.
        const allOpts = command.optsWithGlobals() as {
          envFile?: string;
          vars: Record<string, string>;
          secrets: Record<string, string>;
          artifact: Array<{
            name: string;
            version?: string;
            mountPath: string;
          }>;
          volume: Array<{ name: string; version?: string; mountPath: string }>;
          appendSystemPrompt?: string;
          disallowedTools?: string[];
          tools?: string[];
          settings?: string;
          permissionPolicies?: string;
          verbose?: boolean;
          debugNoMockClaude?: boolean;
          debugNoMockCodex?: boolean;
        };

        // Merge vars and secrets from command options
        const vars = { ...allOpts.vars, ...options.vars };
        const secrets = { ...allOpts.secrets, ...options.secrets };

        // 1. Validate session ID format
        if (!isUUID(agentSessionId)) {
          throw new Error(
            `Invalid agent session ID format: ${agentSessionId}`,
            { cause: new Error("Agent session ID must be a valid UUID") },
          );
        }

        // 2. Fetch session info to get required secret names
        // This allows loading secrets from environment variables
        const sessionInfo = await getSession(agentSessionId);
        const requiredSecretNames = sessionInfo.secretNames || [];

        // 3. Load secrets from CLI options + --env-file + environment variables
        // Priority: CLI flags > --env-file > env vars
        const envFile = options.envFile || allOpts.envFile;
        const loadedSecrets = loadValues(secrets, requiredSecretNames, envFile);

        // 4. Prepare optional fields
        // Commander routes the repeatable --artifact to either the subcommand's
        // own options or the parent's, depending on where the user put the flag.
        // Prefer the one with entries; fall back to the other.
        const artifactsInput =
          options.artifact.length > 0 ? options.artifact : allOpts.artifact;
        const artifacts =
          artifactsInput.length > 0 ? artifactsInput : undefined;

        // 5. Call unified API with sessionId
        const response = await createRun({
          sessionId: agentSessionId,
          prompt,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
          secrets: loadedSecrets,
          artifacts,
          additionalVolumes:
            allOpts.volume.length > 0 ? allOpts.volume : undefined,
          appendSystemPrompt:
            options.appendSystemPrompt || allOpts.appendSystemPrompt,
          disallowedTools: options.disallowedTools || allOpts.disallowedTools,
          tools: options.tools || allOpts.tools,
          settings: options.settings || allOpts.settings,
          permissionPolicies: parsePermissionPolicies(
            options.permissionPolicies || allOpts.permissionPolicies,
          ),
          debugNoMockClaude: pickOpt(
            options.debugNoMockClaude,
            allOpts.debugNoMockClaude,
          ),
          debugNoMockCodex: pickOpt(
            options.debugNoMockCodex,
            allOpts.debugNoMockCodex,
          ),
        });

        // 4. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          throw new Error(
            "Run preparation failed",
            response.error ? { cause: new Error(response.error) } : undefined,
          );
        }

        // 5. Display run started/queued info
        renderRunCreated(response);

        // 6. Poll for events and exit with appropriate code
        const verbose = options.verbose || allOpts.verbose;
        const result = await pollEvents(response.runId, { verbose });
        if (!result.succeeded) {
          throw new Error("Run failed");
        }
        showNextSteps(result);
      },
    ),
  );
