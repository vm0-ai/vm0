import {
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_WORKING_DIR,
  type StorageProvisioningDestination,
} from "@vm0/api-contracts/contracts/runners";
import type { SupportedFramework } from "@vm0/core/frameworks";

const MNT_ROOT = "/mnt";
const CODEX_HOME_DIR = `${CANONICAL_GUEST_HOME_DIR}/.codex`;
const CLAUDE_HOME_DIR = `${CANONICAL_GUEST_HOME_DIR}/.claude`;

function splitStrictAbsoluteGuestPath(
  mountPath: string,
  label: string,
): readonly string[] {
  if (mountPath.includes("\0")) {
    throw new Error(`${label} cannot contain NUL bytes`);
  }
  if (!mountPath.startsWith("/")) {
    throw new Error(`${label} must be an absolute guest path`);
  }

  const segments = mountPath.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "") {
      continue;
    }
    if (segment === "." || segment === "..") {
      throw new Error(`${label} cannot contain traversal segments`);
    }
    normalized.push(segment);
  }
  return normalized;
}

function joinGuestPath(basePath: string, subPath: string | undefined): string {
  return subPath ? `${basePath}/${subPath}` : basePath;
}

function subPath(
  segments: readonly string[],
  start: number,
): string | undefined {
  const value = segments.slice(start).join("/");
  return value.length > 0 ? value : undefined;
}

export function legacyUserMountPathToProvisioningDestination(
  mountPath: string,
  label = "Storage mount path",
): StorageProvisioningDestination {
  const segments = splitStrictAbsoluteGuestPath(mountPath, label);
  const normalizedPath = `/${segments.join("/")}`;

  if (
    normalizedPath === CANONICAL_WORKING_DIR ||
    normalizedPath.startsWith(`${CANONICAL_WORKING_DIR}/`)
  ) {
    return {
      type: "workspace",
      subPath: subPath(segments, 3),
    };
  }

  if (segments[0] === "mnt") {
    const name = segments[1];
    if (!name) {
      throw new Error(`${label} must target /mnt/<name>, not bare /mnt`);
    }
    return {
      type: "mnt",
      name,
      subPath: subPath(segments, 2),
    };
  }

  throw new Error(
    `${label} must be under ${CANONICAL_WORKING_DIR} or /mnt/<name>`,
  );
}

export function frameworkInstructionsDestination(
  framework: SupportedFramework,
): StorageProvisioningDestination {
  return {
    type: "framework-instructions",
    framework,
  };
}

export function frameworkSkillDestination(
  framework: SupportedFramework,
  skillName: string,
): StorageProvisioningDestination {
  return {
    type: "framework-skill",
    framework,
    skillName,
  };
}

export function frameworkMemoryDestination(
  framework: SupportedFramework,
): StorageProvisioningDestination {
  return {
    type: "framework-memory",
    framework,
  };
}

export function resolveProvisioningDestinationMountPath(
  destination: StorageProvisioningDestination,
): string {
  switch (destination.type) {
    case "workspace": {
      return joinGuestPath(CANONICAL_WORKING_DIR, destination.subPath);
    }
    case "mnt": {
      if (!destination.name) {
        throw new Error("mnt provisioning destinations require name");
      }
      return joinGuestPath(
        `${MNT_ROOT}/${destination.name}`,
        destination.subPath,
      );
    }
    case "framework-instructions": {
      if (destination.framework === "codex") {
        return CODEX_HOME_DIR;
      }
      if (destination.framework === "claude-code") {
        return CLAUDE_HOME_DIR;
      }
      throw new Error("framework instructions destinations require framework");
    }
    case "framework-skill": {
      if (!destination.skillName) {
        throw new Error("framework skill destinations require skillName");
      }
      if (destination.framework === "codex") {
        return `${CODEX_HOME_DIR}/skills/${destination.skillName}`;
      }
      if (destination.framework === "claude-code") {
        return `${CLAUDE_HOME_DIR}/skills/${destination.skillName}`;
      }
      throw new Error("framework skill destinations require framework");
    }
    case "framework-memory": {
      if (destination.framework === "codex") {
        return CANONICAL_CODEX_MEMORY_MOUNT_PATH;
      }
      if (destination.framework === "claude-code") {
        return CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
      }
      throw new Error("framework memory destinations require framework");
    }
    default: {
      const exhaustive: never = destination.type;
      throw new Error(`Unsupported provisioning destination: ${exhaustive}`);
    }
  }
}
