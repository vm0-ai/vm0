import { inferMimetype } from "../../shared/mimetype";

function filenameFromUrl(mediaUrl: string): string {
  try {
    const url = new URL(mediaUrl);
    const filename = url.pathname.split("/").filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : "agentphone-media";
  } catch {
    return "agentphone-media";
  }
}

export function formatAgentPhoneFileForContext(params: {
  messageId: string;
  mediaUrl: string;
}): string {
  const name = filenameFromUrl(params.mediaUrl);
  const mimetype = inferMimetype(name);
  return [
    `[AgentPhone file] ${name} (${mimetype})`,
    `   [ID] ${params.messageId}`,
  ].join("\n");
}

export function agentPhoneFilenameFromMediaUrl(
  mediaUrl: string,
  fallback: string,
): string {
  const filename = filenameFromUrl(mediaUrl);
  return filename === "agentphone-media" ? fallback : filename;
}
