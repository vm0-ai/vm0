import Docker from "dockerode";
import os from "os";
import { PassThrough } from "stream";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("docker-sandbox");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const DEFAULT_SANDBOX_IMAGE = "vm0-sandbox:latest";

let cachedNetwork: string | null | undefined;

/**
 * Detect the Docker Compose network this process is running in.
 *
 * When the web container is part of a Compose stack, sandbox containers
 * should join the same network so they can reach `web:3000` by service name.
 *
 * Returns null when running on the host (not inside Docker).
 */
async function detectDockerNetwork(): Promise<string | null> {
  if (cachedNetwork !== undefined) return cachedNetwork;

  const envNetwork = env().DOCKER_NETWORK;
  if (envNetwork) {
    cachedNetwork = envNetwork;
    log.debug(`Using explicit Docker network: ${cachedNetwork}`);
    return cachedNetwork;
  }

  try {
    const hostname = os.hostname();
    const container = docker.getContainer(hostname);
    const info = await container.inspect();
    const networks = info.NetworkSettings.Networks;

    for (const [name] of Object.entries(networks)) {
      if (name !== "bridge" && name !== "host" && name !== "none") {
        cachedNetwork = name;
        log.debug(`Detected Docker Compose network: ${cachedNetwork}`);
        return cachedNetwork;
      }
    }
  } catch {
    // Not running in Docker or socket not accessible
  }

  cachedNetwork = null;
  log.debug("No Docker Compose network detected (host mode)");
  return null;
}

/**
 * Resolve the API URL that sandbox containers should use to reach the Web API.
 *
 * Priority:
 * 1. Explicit VM0_API_URL env var
 * 2. Docker Compose service name (if running in Compose)
 * 3. host.docker.internal (when web runs on host)
 */
export async function resolveApiUrlForSandbox(): Promise<string> {
  const explicit = env().VM0_API_URL;
  if (explicit) return explicit;

  const network = await detectDockerNetwork();
  if (network) return "http://web:3000";

  return "http://host.docker.internal:3000";
}

/**
 * Minimal sandbox interface matching the subset of E2B Sandbox we actually use.
 */
export interface SandboxLike {
  sandboxId: string;
  files: {
    write(path: string, content: ArrayBuffer | string): Promise<void>;
  };
  commands: {
    run(
      cmd: string,
      opts?: { timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  kill(): Promise<void>;
}

// ============ File Operations ============

function createFileOps(containerId: string) {
  return {
    async write(
      remotePath: string,
      content: ArrayBuffer | string,
    ): Promise<void> {
      const container = docker.getContainer(containerId);
      const buffer =
        typeof content === "string"
          ? Buffer.from(content, "utf-8")
          : Buffer.from(content);

      // Ensure target directory exists
      const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
      if (dir) {
        const mkdirExec = await container.exec({
          Cmd: ["mkdir", "-p", dir],
          AttachStdout: false,
          AttachStderr: false,
        });
        await mkdirExec.start({ Detach: true });
      }

      // Upload via tar archive (no shell escaping needed)
      const fileName = remotePath.substring(remotePath.lastIndexOf("/") + 1);
      const tarDir = dir || "/";
      const tar = createSingleFileTar(fileName, buffer);
      await container.putArchive(tar, { path: tarDir });
    },
  };
}

// ============ Command Operations ============

function createCommandOps(containerId: string) {
  return {
    async run(
      cmd: string,
      options?: { timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const container = docker.getContainer(containerId);

      const exec = await container.exec({
        Cmd: ["bash", "-c", cmd],
        AttachStdout: true,
        AttachStderr: true,
      });

      return new Promise((resolve, reject) => {
        const timeout = options?.timeoutMs;
        let timer: NodeJS.Timeout | undefined;

        void exec
          .start({})
          .then((stream) => {
            if (!stream) {
              resolve({
                exitCode: 1,
                stdout: "",
                stderr: "No stream returned",
              });
              return;
            }

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            const stdoutPass = new PassThrough();
            const stderrPass = new PassThrough();

            docker.modem.demuxStream(stream, stdoutPass, stderrPass);

            stdoutPass.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
            stderrPass.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

            if (timeout) {
              timer = setTimeout(() => {
                stream.destroy();
                resolve({
                  exitCode: 124,
                  stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                  stderr: "Command timed out",
                });
              }, timeout);
            }

            stream.on("end", () => {
              if (timer) clearTimeout(timer);
              void exec.inspect().then(
                (inspectData) => {
                  resolve({
                    exitCode: inspectData.ExitCode ?? 0,
                    stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
                  });
                },
                () => {
                  resolve({
                    exitCode: 0,
                    stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
                  });
                },
              );
            });

            stream.on("error", (streamErr: Error) => {
              if (timer) clearTimeout(timer);
              reject(streamErr);
            });
          })
          .catch(reject);
      });
    },
  };
}

// ============ DockerSandbox Factory ============

/**
 * Create a new Docker sandbox container.
 */
export async function createDockerSandbox(
  image: string,
  options: { timeoutMs?: number; envs?: Record<string, string> } = {},
): Promise<SandboxLike> {
  const sandboxImage =
    env().DOCKER_SANDBOX_IMAGE || image || DEFAULT_SANDBOX_IMAGE;

  const envArray: string[] = [];
  if (options.envs) {
    for (const [key, value] of Object.entries(options.envs)) {
      envArray.push(`${key}=${value}`);
    }
  }

  const memoryBytes = parseMemory(env().DOCKER_SANDBOX_MEMORY || "2g");
  const cpuNano = parseCpus(env().DOCKER_SANDBOX_CPUS || "2");

  const network = await detectDockerNetwork();
  const isLinux = os.platform() === "linux";

  const createOptions: Docker.ContainerCreateOptions = {
    Image: sandboxImage,
    name: `vm0-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    Cmd: ["sleep", "infinity"],
    Env: envArray,
    HostConfig: {
      Memory: memoryBytes,
      NanoCpus: cpuNano,
      ExtraHosts: isLinux ? ["host.docker.internal:host-gateway"] : [],
    },
  };

  if (network) {
    createOptions.NetworkingConfig = {
      EndpointsConfig: {
        [network]: {},
      },
    };
  }

  const container = await docker.createContainer(createOptions);
  await container.start();

  const containerId = container.id.slice(0, 12);
  log.debug(
    `Sandbox container created: ${containerId} (image: ${sandboxImage}, network: ${network ?? "default"})`,
  );

  return {
    sandboxId: containerId,
    files: createFileOps(containerId),
    commands: createCommandOps(containerId),
    async kill() {
      try {
        const c = docker.getContainer(containerId);
        await c.remove({ force: true });
        log.debug(`Sandbox ${containerId} killed`);
      } catch {
        log.debug(
          `Sandbox ${containerId} kill skipped (may already be removed)`,
        );
      }
    },
  };
}

/**
 * Kill a Docker sandbox container by ID.
 */
export async function killDockerSandbox(containerId: string): Promise<void> {
  try {
    log.debug(`Killing Docker sandbox ${containerId}...`);
    const container = docker.getContainer(containerId);
    await container.remove({ force: true });
    log.debug(`Docker sandbox ${containerId} killed successfully`);
  } catch {
    log.debug(
      `Docker sandbox ${containerId} not found (may already be removed)`,
    );
  }
}

// ============ Helpers ============

/**
 * Create a minimal tar archive containing a single file.
 */
function createSingleFileTar(filename: string, content: Buffer): Buffer {
  const BLOCK_SIZE = 512;
  const blocks: Buffer[] = [];

  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(filename, 0, Math.min(filename.length, 100), "utf-8");
  header.write("0000644\0", 100, 8, "utf-8");
  header.write("0000000\0", 108, 8, "utf-8");
  header.write("0000000\0", 116, 8, "utf-8");

  const sizeOctal = content.length.toString(8).padStart(11, "0");
  header.write(sizeOctal + "\0", 124, 12, "utf-8");

  const mtime = Math.floor(Date.now() / 1000)
    .toString(8)
    .padStart(11, "0");
  header.write(mtime + "\0", 136, 12, "utf-8");

  header.write("        ", 148, 8, "utf-8");
  header.write("0", 156, 1, "utf-8");
  header.write("ustar\0", 257, 6, "utf-8");
  header.write("00", 263, 2, "utf-8");

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header.readUInt8(i);
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  blocks.push(header);
  blocks.push(content);

  const padding = BLOCK_SIZE - (content.length % BLOCK_SIZE);
  if (padding < BLOCK_SIZE) {
    blocks.push(Buffer.alloc(padding, 0));
  }

  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  return Buffer.concat(blocks);
}

function parseMemory(value: string): number {
  const match = value.match(/^(\d+)([kmg]?)$/i);
  if (!match) return 2 * 1024 * 1024 * 1024;
  const num = parseInt(match[1]!, 10);
  const unit = (match[2] ?? "").toLowerCase();
  switch (unit) {
    case "k":
      return num * 1024;
    case "m":
      return num * 1024 * 1024;
    case "g":
      return num * 1024 * 1024 * 1024;
    default:
      return num;
  }
}

function parseCpus(value: string): number {
  const num = parseFloat(value);
  if (isNaN(num)) return 2_000_000_000;
  return Math.floor(num * 1_000_000_000);
}
