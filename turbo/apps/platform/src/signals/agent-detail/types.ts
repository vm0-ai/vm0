export interface AgentDetail {
  id: string;
  name: string;
  headVersionId: string | null;
  content: AgentComposeYaml | null;
  createdAt: string;
  updatedAt: string;
  isOwner: boolean;
}

interface AgentComposeYaml {
  version: string;
  agents: Record<string, AgentDefinition>;
  volumes?: Record<string, VolumeConfig>;
}

interface AgentDefinition {
  description?: string;
  framework: string;
  instructions?: string;
  skills?: string[];
  environment?: Record<string, string>;
  metadata?: { displayName?: string; sound?: string; description?: string };
  experimental_runner?: { group: string };
}

interface VolumeConfig {
  name: string;
  version: string;
  optional?: boolean;
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
