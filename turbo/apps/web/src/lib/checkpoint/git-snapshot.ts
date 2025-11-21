import type { Sandbox } from "@e2b/code-interpreter";
import type { PreparedVolume } from "../volume/types";
import type { GitSnapshot } from "./types";

/**
 * Error thrown when Git snapshot operations fail
 */
export class GitSnapshotError extends Error {
  constructor(
    message: string,
    public readonly volumeName: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitSnapshotError";
  }
}

/**
 * Create a Git snapshot for a volume by committing changes and pushing to a new branch
 *
 * @param sandbox E2B sandbox instance where the volume is mounted
 * @param volume Prepared volume configuration
 * @param runId Agent run ID (used for branch naming)
 * @returns Git snapshot with branch name and commit ID
 * @throws GitSnapshotError if any Git operation fails
 */
export async function createGitSnapshot(
  sandbox: Sandbox,
  volume: PreparedVolume,
  runId: string,
): Promise<GitSnapshot> {
  const branchName = `run-${runId}`;
  const { mountPath, name: volumeName } = volume;

  try {
    console.log(
      `[Checkpoint] Creating Git snapshot for volume "${volumeName}" at ${mountPath}`,
    );

    // Configure Git user (required for commits)
    await executeGitCommand(
      sandbox,
      mountPath,
      'git config user.name "VM0 Agent"',
    );
    await executeGitCommand(
      sandbox,
      mountPath,
      'git config user.email "agent@vm0.ai"',
    );

    // Create and switch to new branch
    console.log(`[Checkpoint] Creating branch ${branchName}`);
    await executeGitCommand(
      sandbox,
      mountPath,
      `git checkout -b ${branchName}`,
    );

    // Stage all changes
    await executeGitCommand(sandbox, mountPath, "git add -A");

    // Check if there are changes to commit
    const statusResult = await sandbox.commands.run("git status --porcelain", {
      envs: { PWD: mountPath },
    });

    if (!statusResult.stdout.trim()) {
      console.log(
        `[Checkpoint] No changes to commit in volume "${volumeName}"`,
      );
      // Still return snapshot with current HEAD commit
      const commitId = await getCommitId(sandbox, mountPath);
      return { branch: branchName, commitId };
    }

    // Commit changes
    const commitMessage = `checkpoint: save state for run ${runId}`;
    console.log(`[Checkpoint] Committing changes: "${commitMessage}"`);
    await executeGitCommand(
      sandbox,
      mountPath,
      `git commit -m "${commitMessage}"`,
    );

    // Push to remote
    console.log(`[Checkpoint] Pushing branch ${branchName} to remote`);
    await executeGitCommand(
      sandbox,
      mountPath,
      `git push origin ${branchName}`,
    );

    // Get commit ID
    const commitId = await getCommitId(sandbox, mountPath);

    console.log(
      `[Checkpoint] Git snapshot created: ${branchName}@${commitId.substring(0, 7)}`,
    );

    return {
      branch: branchName,
      commitId,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `[Checkpoint] Failed to create Git snapshot for volume "${volumeName}":`,
      errorMessage,
    );
    throw new GitSnapshotError(
      `Failed to create Git snapshot: ${errorMessage}`,
      volumeName,
      error,
    );
  }
}

/**
 * Execute a Git command in the sandbox
 *
 * @param sandbox E2B sandbox instance
 * @param workingDir Working directory for the command
 * @param command Git command to execute
 * @throws Error if command fails
 */
async function executeGitCommand(
  sandbox: Sandbox,
  workingDir: string,
  command: string,
): Promise<void> {
  const result = await sandbox.commands.run(command, {
    envs: { PWD: workingDir },
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Git command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Get the current commit ID (HEAD)
 *
 * @param sandbox E2B sandbox instance
 * @param workingDir Working directory
 * @returns Full commit SHA
 * @throws Error if command fails
 */
async function getCommitId(
  sandbox: Sandbox,
  workingDir: string,
): Promise<string> {
  const result = await sandbox.commands.run("git rev-parse HEAD", {
    envs: { PWD: workingDir },
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to get commit ID: ${result.stderr || result.stdout}`,
    );
  }

  return result.stdout.trim();
}
