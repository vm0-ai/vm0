import { AgentPhoneClient } from "agentphone";
import { env } from "../../../env";

let _client: AgentPhoneClient | undefined;

/**
 * Returns the platform-level AgentPhone client singleton.
 * Uses the AGENTPHONE_API_KEY env var (not per-org connector token).
 */
export function getAgentPhoneClient(): AgentPhoneClient {
  if (!_client) {
    const token = env().AGENTPHONE_API_KEY;
    if (!token) {
      throw new Error("AGENTPHONE_API_KEY is not configured");
    }
    _client = new AgentPhoneClient({ token });
  }
  return _client;
}
