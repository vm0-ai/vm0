import {
  createArtifactSignals,
  type ArtifactSignals,
} from "./artifact-card-signals.ts";
import {
  createConnectorSignals,
  createCustomConnectorSignals,
  type ConnectorSignals,
  type CustomConnectorSignals,
} from "./connector-action-block.ts";
import {
  createComputerUseAuthorizationSignals,
  type ComputerUseAuthorizationSignals,
} from "./computer-use-authorization-block.ts";
import {
  createPermissionSignals,
  type PermissionSignals,
} from "./permission-card-signals.ts";
import type { BodyRenderBlock, ParsedBodyBlock } from "./parse-body-blocks.ts";

export interface ChatCardSignalsRegistry {
  registerBodyBlocks(blocks: readonly ParsedBodyBlock[]): BodyRenderBlock[];
  resolveBodyBlocks(blocks: readonly ParsedBodyBlock[]): BodyRenderBlock[];
}

function getOrCreateSignals<T>(
  registry: Map<string, T>,
  resourceKey: string,
  create: () => T,
): T {
  const existing = registry.get(resourceKey);
  if (existing !== undefined) {
    return existing;
  }
  const signals = create();
  registry.set(resourceKey, signals);
  return signals;
}

function registeredSignals<T>(
  registry: ReadonlyMap<string, T>,
  resourceKey: string,
): T {
  const signals = registry.get(resourceKey);
  if (signals === undefined) {
    throw new Error(`Card signals were not registered: ${resourceKey}`);
  }
  return signals;
}

type SignalsResolution = "register" | "resolve";

function resolveSignals<T>(
  registry: Map<string, T>,
  resourceKey: string,
  create: () => T,
  resolution: SignalsResolution,
): T {
  return resolution === "register"
    ? getOrCreateSignals(registry, resourceKey, create)
    : registeredSignals(registry, resourceKey);
}

export function createChatCardSignalsRegistry(): ChatCardSignalsRegistry {
  const artifactCardSignals = new Map<string, ArtifactSignals>();
  const connectorCardSignals = new Map<string, ConnectorSignals>();
  const customConnectorCardSignals = new Map<string, CustomConnectorSignals>();
  const permissionCardSignals = new Map<string, PermissionSignals>();
  const computerUseAuthorizationCardSignals = new Map<
    string,
    ComputerUseAuthorizationSignals
  >();

  function renderBlock(
    block: ParsedBodyBlock,
    resolution: SignalsResolution,
  ): BodyRenderBlock {
    switch (block.type) {
      case "markdown": {
        return block;
      }
      case "artifact": {
        return {
          type: block.type,
          resourceKey: block.resourceKey,
          signals: resolveSignals(
            artifactCardSignals,
            block.resourceKey,
            () => {
              return createArtifactSignals(block.descriptor);
            },
            resolution,
          ),
        };
      }
      case "connector-action": {
        return {
          type: block.type,
          resourceKey: block.resourceKey,
          signals: resolveSignals(
            connectorCardSignals,
            block.resourceKey,
            () => {
              return createConnectorSignals(block.descriptor);
            },
            resolution,
          ),
        };
      }
      case "custom-connector-action": {
        return {
          type: block.type,
          resourceKey: block.resourceKey,
          signals: resolveSignals(
            customConnectorCardSignals,
            block.resourceKey,
            () => {
              return createCustomConnectorSignals(block.descriptor);
            },
            resolution,
          ),
        };
      }
      case "permission-action": {
        return {
          type: block.type,
          resourceKey: block.resourceKey,
          signals: resolveSignals(
            permissionCardSignals,
            block.resourceKey,
            () => {
              return createPermissionSignals(block.descriptor);
            },
            resolution,
          ),
        };
      }
      case "computer-use-authorization": {
        return {
          type: block.type,
          resourceKey: block.resourceKey,
          signals: resolveSignals(
            computerUseAuthorizationCardSignals,
            block.resourceKey,
            () => {
              return createComputerUseAuthorizationSignals(block.descriptor);
            },
            resolution,
          ),
        };
      }
    }
  }

  return {
    registerBodyBlocks(blocks) {
      return blocks.map((block) => {
        return renderBlock(block, "register");
      });
    },
    resolveBodyBlocks(blocks) {
      return blocks.map((block) => {
        return renderBlock(block, "resolve");
      });
    },
  };
}
