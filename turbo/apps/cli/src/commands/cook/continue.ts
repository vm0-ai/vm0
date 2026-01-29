import { Command, Option } from "commander";
import chalk from "chalk";
import path from "path";
import { loadCookState, saveCookState } from "../../lib/domain/cook-state";
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
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(
    async (
      prompt: string,
      options: { envFile?: string; debugNoMockClaude?: boolean },
    ) => {
      const state = await loadCookState();
      if (!state.lastSessionId) {
        console.error(chalk.red("✗ No previous session found"));
        console.error(chalk.dim("  Run 'vm0 cook <prompt>' first"));
        process.exit(1);
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

      let runOutput: string;
      try {
        runOutput = await execVm0RunWithCapture(
          [
            "run",
            "continue",
            ...(options.envFile ? ["--env-file", options.envFile] : []),
            state.lastSessionId,
            ...(options.debugNoMockClaude ? ["--debug-no-mock-claude"] : []),
            prompt,
          ],
          { cwd },
        );
      } catch {
        // Error already displayed by vm0 run
        process.exit(1);
      }

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
  );
