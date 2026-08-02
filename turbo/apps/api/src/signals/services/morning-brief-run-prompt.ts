export const MORNING_BRIEF_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

/** The line the member sees in the Morning Brief chat thread. */
export function buildMorningBriefChatMessage(briefDate: string): string {
  return `Generate my Morning Brief for ${briefDate}.`;
}

function formatMorningBriefLocalTime(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * The prompt the run actually receives.
 *
 * The Morning Brief thread keeps one persistent session, so a scheduled run
 * arrives on top of the previous days' runs. State the facts that separate
 * this delivery from those: where it came from, which URLs belong to it, and
 * what the server does with the uploaded object. Facts only — the agent
 * decides how to act on them.
 */
export function buildMorningBriefRunPrompt(args: {
  readonly briefDate: string;
  readonly timezone: string;
  readonly deliveryId: string;
  readonly triggeredAt: Date;
  readonly inputUrl: string;
  readonly outputUrl: string;
}): string {
  return [
    buildMorningBriefChatMessage(args.briefDate),
    "",
    "# Run facts",
    "",
    `- trigger: the Morning Brief schedule fired for ${args.briefDate}; nobody typed this message`,
    `- fired at: ${formatMorningBriefLocalTime(args.timezone, args.triggeredAt)} (${args.timezone})`,
    `- delivery id: ${args.deliveryId}`,
    "- chat thread: every Morning Brief delivery runs in this one thread and keeps its session, so the messages above are earlier deliveries; the URLs they carried are expired",
    `- collected input for this delivery: HTTP GET ${args.inputUrl}`,
    `- destination for this delivery's brief: HTTP PUT ${args.outputUrl}`,
    `- both URLs are signed for delivery ${args.deliveryId} only and expire ${MORNING_BRIEF_SIGNED_URL_TTL_SECONDS / 60} minutes after the trigger above`,
    "- email assembly: a server-side job reads the object at the PUT URL, renders the email, and queues it; it runs once a minute",
    "- when a run ends with no object at the PUT URL: the delivery is recorded failed, no email is queued, and nothing re-runs it",
    '- the JSON shape expected at the PUT URL is in your system instructions under "# Morning Brief run"',
  ].join("\n");
}

export function buildMorningBriefAppendSystemPrompt(args: {
  readonly briefDate: string;
  readonly timezone: string;
  readonly inputUrl: string;
  readonly outputUrl: string;
}): string {
  return [
    "# Morning Brief run",
    `You are generating the user's Morning Brief for ${args.briefDate} (timezone ${args.timezone}).`,
    "",
    "1. Download the collected data (GitHub, Gmail, Google Calendar, unread vm0 chat threads) with an HTTP GET request to this URL (valid for 30 minutes):",
    args.inputUrl,
    "2. Analyze the data and write the brief. Only use predefined sections, omit empty ones, order by importance:",
    "   - `schedule`: today's meetings and events",
    "   - `needs_attention`: items that need the user's action or reply",
    "   - `unread_threads`: vm0 chat threads with results the user has not read yet — summarize what each task produced while they were away",
    "   - `github_updates`: PRs, reviews, CI, mentions involving the user",
    "   - `email_updates`: notable email threads",
    "   - `suggestions`: at most 3 suggestions, each grounded in today's data",
    "3. Keep it a 3-5 minute read: at most 5 primary items per section; fold the rest into a single 'N more updates' item. Do not pad.",
    "4. After choosing the final section items, write `headline` as the email opening:",
    "   - Begin exactly with `Good morning.`",
    "   - Derive it from the final sections and summarize the overall shape of the brief without sensitive details.",
    "   - Use one or two short sentences, no more than 180 characters. Do not repeat a section title or list every item.",
    "5. Upload the result as JSON with an HTTP PUT request (Content-Type: application/json) to this URL (valid for 30 minutes):",
    args.outputUrl,
    "   The JSON shape is:",
    "   {",
    '     "version": 1,',
    '     "headline": "natural opening derived from the final sections; begins with Good morning.",',
    '     "sections": [{"key": "schedule|needs_attention|unread_threads|github_updates|email_updates|suggestions", "title": "string", "items": [{"title": "string", "detail": "string (optional)", "url": "https source link (optional)"}]}]',
    "   }",
    "   Item `url` values must point at the original Gmail message, Calendar event, GitHub page, or the vm0 chat thread `url` provided in the input.",
    "6. Also post the same brief as well-formatted Markdown in this chat so the user can read it here and ask follow-up questions.",
    "7. If a source in the input is marked failed, mention briefly in the brief that the source was unavailable.",
    "The email is assembled server-side from the uploaded JSON; do not try to send any email yourself.",
  ].join("\n");
}
