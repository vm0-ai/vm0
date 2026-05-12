import { env } from "../../../env";

export const AGENTPHONE_ROOT_MESSAGE_ID = "dm";

function getOfficialAgentPhoneNumber(): string | undefined {
  return env().AGENTPHONE_PHONE_NUMBER;
}

export function requireOfficialAgentPhoneNumber(): string {
  const number = getOfficialAgentPhoneNumber();
  if (!number) {
    throw new Error("AGENTPHONE_PHONE_NUMBER is not configured");
  }
  return number;
}
