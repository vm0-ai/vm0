import { Command, Option } from "commander";
import path from "path";
import { loadCookState, saveCookState } from "../../lib/domain/cook-state";
import { withErrorHandler } from "../../lib/command";
import {
  ARTIFACT_DIR,
  printCommand,
  execVm0RunWithCapture,
  parseRunIdsFromOutput,
  autoPullArtifact,
} from "./utils";

export const continueCommand = new Command()
  .name("continue")
  .description(
    "Continue from the last session (latest conversation and artifact)",
  )
  .argument("<prompt>", "Prompt for the continued agent")
  .option(
    "--env-file <path>",
    "Load environment variables from file (priority: CLI flags > file > env vars)",
  )
  .option("-v, --verbose", "Show full tool inputs and outputs")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(
    withErrorHandler(
      async (
        prompt: string,
        options: {
          envFile?: string;
          verbose?: boolean;
          debugNoMockClaude?: boolean;
        },
      ) => {
        const state = await loadCookState();
        if (!state.lastSessionId) {
          throw new Error("No previous session found", {
            cause: new Error("Run 'vm0 cook <prompt>' first"),
          });
        }

        const cwd = process.cwd();
        const artifactDir = path.join(cwd, ARTIFACT_DIR);

        const envFileArg = options.envFile
          ? ` --env-file ${options.envFile}`
          : "";
        printCommand(
          `vm0 run continue${envFileArg} ${state.lastSessionId} "${prompt}"`,
        );
        console.log();

        const runOutput = await execVm0RunWithCapture(
          [
            "run",
            "continue",
            ...(options.envFile ? ["--env-file", options.envFile] : []),
            ...(options.verbose ? ["--verbose"] : []),
            state.lastSessionId,
            ...(options.debugNoMockClaude ? ["--debug-no-mock-claude"] : []),
            prompt,
          ],
          { cwd },
        );

        // Update state with new IDs
        const newIds = parseRunIdsFromOutput(runOutput);
        if (newIds.runId || newIds.sessionId || newIds.checkpointId) {
          await saveCookState({
            lastRunId: newIds.runId,
            lastSessionId: newIds.sessionId,
            lastCheckpointId: newIds.checkpointId,
          });
        }

        // Auto-pull artifact
        await autoPullArtifact(runOutput, artifactDir);
      },
    ),
  );
