import { env } from "../../../env";

export const IMESSAGE_ROOT_MESSAGE_ID = "dm";

function getOfficialIMessageNumber(): string | undefined {
  return env().AGENTPHONE_IMESSAGE_NUMBER;
}

export function requireOfficialIMessageNumber(): string {
  const number = getOfficialIMessageNumber();
  if (!number) {
    throw new Error("AGENTPHONE_IMESSAGE_NUMBER is not configured");
  }
  return number;
}
