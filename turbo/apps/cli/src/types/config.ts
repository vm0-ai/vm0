/**
 * VM0 configuration types
 */

export interface VM0Config {
  version: string;
  agent: {
    description: string;
    image: string;
    provider: string;
    working_dir: string;
    volumes: string[];
  };
  volumes?: Record<string, VolumeConfig>;
  dynamic_volumes?: Record<string, VolumeConfig>;
}

export interface VolumeConfig {
  driver: string;
  driver_opts: {
    uri: string;
    region: string;
  };
}

export interface CLIConfig {
  apiUrl: string;
  apiKey: string;
}
