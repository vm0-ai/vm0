import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { i18n } from "../i18n/index.ts";

export function localizedSshError(code: string): string | undefined {
  switch (code) {
    case SSH_ERROR_CODES.UNAVAILABLE: {
      return i18n.t(($) => {
        return $.ssh.unavailable;
      });
    }
    case SSH_ERROR_CODES.AGENT_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.ssh.errors.agentUnavailable;
      });
    }
    case SSH_ERROR_CODES.INVALID_INPUT: {
      return i18n.t(($) => {
        return $.ssh.errors.invalidInput;
      });
    }
    case SSH_ERROR_CODES.INVALID_HOST: {
      return i18n.t(($) => {
        return $.ssh.errors.invalidHost;
      });
    }
    case SSH_ERROR_CODES.CONNECTION_NOT_FOUND: {
      return i18n.t(($) => {
        return $.ssh.errors.hostUnavailable;
      });
    }
    case SSH_ERROR_CODES.ENDPOINT_CONFLICT: {
      return i18n.t(($) => {
        return $.ssh.errors.duplicateEndpoint;
      });
    }
    case SSH_ERROR_CODES.GENERATION_CONFLICT: {
      return i18n.t(($) => {
        return $.ssh.errors.configurationChanged;
      });
    }
    default: {
      return undefined;
    }
  }
}
