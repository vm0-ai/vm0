import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The two schematics in the built-in welcome thread. They are React rather than
 * mermaid so the strokes stay hairline at any zoom, the copy goes through i18n,
 * and every colour resolves from a semantic token and flips with the theme.
 *
 * Shared vocabulary: hairline connectors with a dot at each junction instead of
 * an arrowhead, labels sitting directly on the panel instead of inside boxes,
 * and exactly one accent-tinted node per diagram.
 */

const PANEL_CLASS =
  "w-full overflow-hidden rounded-xl border border-border/60 bg-muted/25 px-5 py-6 sm:px-8 sm:py-7";

const EYEBROW_CLASS =
  "text-[0.6875rem] font-medium tracking-[0.08em] text-muted-foreground";

const NODE_TITLE_CLASS =
  "text-[0.8125rem] font-semibold leading-5 text-foreground";

const NODE_BODY_CLASS =
  "mt-0.5 text-[0.75rem] leading-[1.45] text-muted-foreground";

function DiagramNode({
  title,
  body,
  accent = false,
}: {
  title: string;
  body: string;
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-2.5">
      <span
        aria-hidden="true"
        className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${
          accent ? "bg-primary" : "bg-border"
        }`}
      />
      <div className="min-w-0">
        <div className={NODE_TITLE_CLASS}>{title}</div>
        <div className={NODE_BODY_CLASS}>{body}</div>
      </div>
    </div>
  );
}

function DiagramColumn({
  eyebrow,
  children,
  divider = false,
}: {
  eyebrow: string;
  children: ReactNode;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-3 ${
        divider
          ? "border-t border-dashed border-border/70 pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0 lg:pl-8"
          : ""
      }`}
    >
      <div className={EYEBROW_CLASS}>{eyebrow}</div>
      {children}
    </div>
  );
}

/**
 * One person's finished chat becomes a saved workflow, and the workflow is what
 * the rest of the team and the schedule both start from. The pivot node carries
 * the only accent so the eye lands on the thing worth saving.
 */
export function WelcomeTeamDiagram() {
  const { t } = useTranslation();

  return (
    <figure
      className={PANEL_CLASS}
      data-testid="welcome-team-diagram"
      aria-label={t(($) => {
        return $.chat.welcomeThread.teamDiagram.caption;
      })}
    >
      <div className="grid gap-5 sm:grid-cols-3 sm:gap-0">
        <DiagramColumn
          eyebrow={t(($) => {
            return $.chat.welcomeThread.teamDiagram.yoursEyebrow;
          })}
        >
          <DiagramNode
            title={t(($) => {
              return $.chat.welcomeThread.teamDiagram.chatTitle;
            })}
            body={t(($) => {
              return $.chat.welcomeThread.teamDiagram.chatBody;
            })}
          />
        </DiagramColumn>

        <DiagramColumn
          divider
          eyebrow={t(($) => {
            return $.chat.welcomeThread.teamDiagram.savedEyebrow;
          })}
        >
          <DiagramNode
            accent
            title={t(($) => {
              return $.chat.welcomeThread.teamDiagram.workflowTitle;
            })}
            body={t(($) => {
              return $.chat.welcomeThread.teamDiagram.workflowBody;
            })}
          />
        </DiagramColumn>

        <DiagramColumn
          divider
          eyebrow={t(($) => {
            return $.chat.welcomeThread.teamDiagram.teamEyebrow;
          })}
        >
          <DiagramNode
            title={t(($) => {
              return $.chat.welcomeThread.teamDiagram.teammateTitle;
            })}
            body={t(($) => {
              return $.chat.welcomeThread.teamDiagram.teammateBody;
            })}
          />
          <DiagramNode
            title={t(($) => {
              return $.chat.welcomeThread.teamDiagram.automationTitle;
            })}
            body={t(($) => {
              return $.chat.welcomeThread.teamDiagram.automationBody;
            })}
          />
        </DiagramColumn>
      </div>
    </figure>
  );
}

function SlackTextLine({ width }: { width: string }) {
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 rounded-full bg-border/80"
      style={{ width }}
    />
  );
}

function SlackAvatar({ accent = false }: { accent?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-5 w-5 shrink-0 rounded-md ${
        accent ? "bg-primary/20" : "bg-border/70"
      }`}
    />
  );
}

function SlackMessage({
  label,
  lines,
  accent = false,
}: {
  label: string;
  lines: readonly string[];
  accent?: boolean;
}) {
  return (
    <div className="flex gap-2.5">
      <SlackAvatar accent={accent} />
      <div className="min-w-0 flex-1">
        <div
          className={`text-[0.75rem] font-semibold leading-5 ${
            accent ? "text-primary" : "text-foreground"
          }`}
        >
          {label}
        </div>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {lines.map((width) => {
            return <SlackTextLine key={width} width={width} />;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Where an answer lands in Slack. The channel panel shows the mention and the
 * threaded reply nested under it; the direct-message panel sits beside it as the
 * private alternative. Both are schematics, not screenshots.
 */
export function WelcomeSlackDiagram() {
  const { t } = useTranslation();

  return (
    <figure
      className={PANEL_CLASS}
      data-testid="welcome-slack-diagram"
      aria-label={t(($) => {
        return $.chat.welcomeThread.slackDiagram.caption;
      })}
    >
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] sm:gap-0">
        <div className="flex min-w-0 flex-col gap-3">
          <div className={EYEBROW_CLASS}>
            {t(($) => {
              return $.chat.welcomeThread.slackDiagram.channelEyebrow;
            })}
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 p-3.5">
            <SlackMessage
              label={t(($) => {
                return $.chat.welcomeThread.slackDiagram.mentionLabel;
              })}
              lines={["78%", "54%"]}
            />
            <div className="mt-3 flex gap-2.5">
              <span
                aria-hidden="true"
                className="ml-[9px] w-[11px] shrink-0 rounded-bl-md border-b border-l border-border/80"
                style={{ marginBottom: "18px" }}
              />
              <div className="min-w-0 flex-1">
                <SlackMessage
                  accent
                  label={t(($) => {
                    return $.chat.welcomeThread.slackDiagram.replyLabel;
                  })}
                  lines={["88%", "62%", "40%"]}
                />
              </div>
            </div>
          </div>
          <p className={NODE_BODY_CLASS}>
            {t(($) => {
              return $.chat.welcomeThread.slackDiagram.channelNote;
            })}
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-3 border-t border-dashed border-border/70 pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0 lg:pl-8">
          <div className={EYEBROW_CLASS}>
            {t(($) => {
              return $.chat.welcomeThread.slackDiagram.directEyebrow;
            })}
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 p-3.5">
            <SlackMessage
              label={t(($) => {
                return $.chat.welcomeThread.slackDiagram.directLabel;
              })}
              lines={["70%", "46%"]}
            />
          </div>
          <p className={NODE_BODY_CLASS}>
            {t(($) => {
              return $.chat.welcomeThread.slackDiagram.directNote;
            })}
          </p>
        </div>
      </div>
    </figure>
  );
}
