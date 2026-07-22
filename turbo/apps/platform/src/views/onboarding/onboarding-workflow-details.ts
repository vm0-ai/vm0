export interface OnboardingWorkflowStep {
  readonly title: string;
  readonly description: string;
}

export interface OnboardingWorkflowDetails {
  readonly scenario: string;
  readonly steps: readonly OnboardingWorkflowStep[];
}

export const ONBOARDING_WORKFLOW_DETAILS: Readonly<
  Record<string, OnboardingWorkflowDetails>
> = {
  "auto-merge-github-prs": {
    scenario:
      "Merging a PR means babysitting CI, re-checking the diff, and remembering to post that it shipped. Zero watches for the ready-to-merge label, reviews the change, waits for checks to go green, merges, and tells the channel.",
    steps: [
      {
        title: "A PR is labeled ready-to-merge",
        description:
          "Zero picks up pull requests as soon as they carry your merge label.",
      },
      {
        title: "Zero reviews and waits on CI",
        description:
          "Zero reads the diff and holds until every required check passes.",
      },
      {
        title: "Merged and posted to Slack",
        description:
          "Zero merges the PR and posts the outcome to your channel.",
      },
    ],
  },
  "file-sentry-crashes-github": {
    scenario:
      "New crashes hide in Sentry until someone goes looking. Zero checks every hour, ranks errors by how many users they hit, opens a GitHub issue for the ones that matter, and pings whoever owns that code.",
    steps: [
      {
        title: "Zero pulls new Sentry errors",
        description:
          "Zero reads unresolved errors and their event counts for the last hour.",
      },
      {
        title: "Ranked by user impact",
        description:
          "Zero sorts by affected users and filters out low-impact noise.",
      },
      {
        title: "Issues filed and owner pinged",
        description:
          "Zero opens a GitHub issue with the stack trace and notifies the owner in Slack.",
      },
    ],
  },
  "watch-sentry-after-release": {
    scenario:
      "The riskiest window is right after a deploy. Zero watches the new release's crash-free and error rates against the prior baseline, and if things get worse it flags the regression and suggests rolling back.",
    steps: [
      {
        title: "Zero watches the new release",
        description:
          "After a deploy, Zero tracks the release's crash-free and error rate in Sentry.",
      },
      {
        title: "Compared against baseline",
        description:
          "Zero compares live numbers to the previous release's baseline.",
      },
      {
        title: "Regression flagged with a rollback tip",
        description:
          "If the release regresses, Zero alerts Slack and suggests a rollback.",
      },
    ],
  },
  "post-github-updates-slack": {
    scenario:
      "Standups eat time and half of it is just recalling what you did. Zero compiles your merged PRs and in-progress Linear tickets each morning and posts a tidy progress update so the async standup writes itself.",
    steps: [
      {
        title: "Zero collects your activity",
        description:
          "Zero reads your merged and open work from GitHub and Linear.",
      },
      {
        title: "Summarized into an update",
        description: "Zero writes a short, readable progress summary.",
      },
      {
        title: "Posted to Slack",
        description:
          "Zero posts the update to your standup channel every weekday.",
      },
    ],
  },
  "draft-github-release-notes-notion": {
    scenario:
      "Writing release notes means scrolling the PR history and translating commits into plain language. Zero does it when you label a PR shipped: it gathers everything merged since the last tag and drafts readable notes in Notion.",
    steps: [
      {
        title: "A PR is labeled shipped",
        description: "Zero triggers on your release label.",
      },
      {
        title: "Zero gathers merged PRs",
        description:
          "Zero collects everything merged since the last release tag.",
      },
      {
        title: "Release notes saved to Notion",
        description:
          "Zero drafts clean, grouped release notes on a Notion page.",
      },
    ],
  },
  "report-ai-model-costs-slack": {
    scenario:
      "Model spend creeps up quietly across routes and models. Zero reads Langfuse every day and posts a breakdown of token spend and p95 latency per model and route so cost surprises never wait until the invoice.",
    steps: [
      {
        title: "Zero reads Langfuse",
        description: "Zero pulls token spend and latency traces for the day.",
      },
      {
        title: "Broken down by model and route",
        description: "Zero aggregates spend and p95 per model and per route.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the daily cost and latency report.",
      },
    ],
  },
  "github-idea-to-notion-spec": {
    scenario:
      "A one-line idea in an issue isn't a spec. Zero picks up the needs-spec label and expands the issue into a structured PRD in Notion with problem, users, requirements, and acceptance criteria ready to refine.",
    steps: [
      {
        title: "An issue is labeled needs-spec",
        description: "Zero triggers on the label and reads the issue.",
      },
      {
        title: "Zero expands it into a PRD",
        description:
          "Zero drafts problem, users, requirements, and acceptance criteria.",
      },
      {
        title: "Saved to Notion",
        description: "Zero creates the structured PRD page in Notion.",
      },
    ],
  },
  "summarize-user-feedback-notion": {
    scenario:
      "Feedback is scattered across four tools and nobody has time to read it all. Zero pulls from each source weekly, clusters the comments into themes, and writes a ranked summary in Notion so the top asks are obvious.",
    steps: [
      {
        title: "Zero pulls feedback",
        description:
          "Zero reads new feedback from Productlane, Typeform, Intercom, and GitHub.",
      },
      {
        title: "Clustered into themes",
        description:
          "Zero groups related feedback and ranks themes by frequency.",
      },
      {
        title: "Summary saved to Notion",
        description: "Zero writes the ranked digest to a Notion page.",
      },
    ],
  },
  "post-release-notes-slack": {
    scenario:
      "The changelog users see is different from the commit log. Zero triggers on the release label, drafts a friendly user-facing summary of what shipped, and posts it to Slack and Notion.",
    steps: [
      {
        title: "A PR is labeled release",
        description: "Zero triggers on the release label.",
      },
      {
        title: "Zero drafts the changelog",
        description: "Zero writes a user-facing summary of what changed.",
      },
      {
        title: "Posted to Slack and Notion",
        description: "Zero shares the announcement in both places.",
      },
    ],
  },
  "sync-linear-roadmap-notion": {
    scenario:
      "Roadmaps go stale the moment tickets move. Zero syncs Linear status into a Now / Next / Later board in Notion every day so the roadmap stakeholders read always matches reality.",
    steps: [
      {
        title: "Zero reads Linear status",
        description: "Zero pulls current ticket states and milestones.",
      },
      {
        title: "Mapped to Now / Next / Later",
        description: "Zero buckets work into roadmap columns.",
      },
      {
        title: "Board updated in Notion",
        description: "Zero updates the Notion roadmap board.",
      },
    ],
  },
  "track-feature-usage-posthog": {
    scenario:
      "Nobody notices a feature quietly losing usage until it's a problem. Zero checks PostHog weekly and posts which features are climbing or slipping so the team sees adoption shifts early.",
    steps: [
      {
        title: "Zero reads PostHog",
        description: "Zero pulls feature usage for the week.",
      },
      {
        title: "Compared week over week",
        description: "Zero finds the biggest risers and fallers.",
      },
      {
        title: "Shifts posted to Slack",
        description: "Zero posts the adoption changes to your channel.",
      },
    ],
  },
  "flag-figma-designs-no-task": {
    scenario:
      "Designs quietly finish without ever becoming build tickets. Zero scans Figma daily for frames marked ready that have no linked Linear task and flags the gaps in Slack before they slip.",
    steps: [
      {
        title: "Zero scans Figma frames",
        description: "Zero reads frames and their linked tasks.",
      },
      {
        title: "Finds frames without a task",
        description: "Zero flags ready designs missing a build ticket.",
      },
      {
        title: "Gaps posted to Slack",
        description: "Zero lists the unlinked designs in your channel.",
      },
    ],
  },
  "post-daily-metrics-slack": {
    scenario:
      "Checking three dashboards before coffee is nobody's favorite ritual. Zero pulls visitors, signups, and activation each morning and posts the numbers to Slack so the day starts with the KPIs already in the channel.",
    steps: [
      {
        title: "Zero pulls the metrics",
        description:
          "Zero reads traffic, signups, and activation from your analytics tools.",
      },
      {
        title: "Assembled into a KPI snapshot",
        description: "Zero formats the key numbers with day-over-day context.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the morning KPI update.",
      },
    ],
  },
  "run-daily-query-sheets": {
    scenario:
      "The report you rebuild every morning is the same query and the same paste into a sheet. Zero runs the query for you each day and writes the formatted results straight into Google Sheets.",
    steps: [
      {
        title: "Zero runs the query",
        description:
          "Zero executes your saved read-only query against the warehouse.",
      },
      {
        title: "Results formatted",
        description: "Zero shapes the output into clean columns.",
      },
      {
        title: "Written to Google Sheets",
        description: "Zero appends the results to your tracking sheet.",
      },
    ],
  },
  "check-posthog-signup-funnel": {
    scenario:
      "Funnels only help if someone runs them. Zero runs the signup funnel weekly, finds the step losing the most people, and posts it to Slack so the team knows where to focus.",
    steps: [
      {
        title: "Zero runs the funnel",
        description: "Zero executes the signup funnel in PostHog for the week.",
      },
      {
        title: "Biggest drop-off identified",
        description: "Zero finds the step with the largest fall-off.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the leak and the trend.",
      },
    ],
  },
  "alert-metric-moves-slack": {
    scenario:
      "By the time a metric problem shows on the weekly review, it's days old. Zero watches a key metric every hour and pings Slack the moment it moves outside its normal range.",
    steps: [
      {
        title: "Zero checks the metric",
        description: "Zero reads the metric every hour.",
      },
      {
        title: "Compared to normal range",
        description: "Zero flags values outside the expected band.",
      },
      {
        title: "Alert posted to Slack",
        description: "Zero posts an alert with the deviation.",
      },
    ],
  },
  "track-signup-sources-sheets": {
    scenario:
      "Knowing where signups come from means stitching Clerk to analytics by hand. Zero attributes each new signup to its channel and campaign daily and logs it to a Google Sheet you can pivot.",
    steps: [
      {
        title: "Zero reads new signups",
        description: "Zero pulls new users from Clerk.",
      },
      {
        title: "Attributed to a channel",
        description:
          "Zero matches each signup to its source and campaign via Plausible.",
      },
      {
        title: "Logged to Google Sheets",
        description: "Zero appends the attributed rows to your sheet.",
      },
    ],
  },
  "build-weekly-deck-gamma": {
    scenario:
      "The weekly metrics deck is the same slides with new numbers every time. Zero pulls the data, builds the deck in Gamma, and posts it to Slack so the review is ready before the meeting.",
    steps: [
      {
        title: "Zero gathers the numbers",
        description: "Zero reads metrics from Sheets and analytics.",
      },
      {
        title: "Deck built in Gamma",
        description: "Zero assembles the recurring metrics deck.",
      },
      {
        title: "Posted to Slack",
        description: "Zero shares the finished deck.",
      },
    ],
  },
  "track-keyword-ranks-ahrefs": {
    scenario:
      "Rank tracking is a manual export-and-compare chore. Zero pulls your target keywords weekly, compares positions, and writes the biggest movers to Notion so SEO wins and slips are obvious.",
    steps: [
      {
        title: "Zero reads keyword positions",
        description: "Zero pulls current rankings from Ahrefs.",
      },
      {
        title: "Movers identified",
        description:
          "Zero compares to last week and finds the biggest changes.",
      },
      {
        title: "Reported in Notion",
        description: "Zero writes the movers and trend to Notion.",
      },
    ],
  },
  "publish-scheduled-posts-buffer": {
    scenario:
      "A content calendar only works if someone hits publish. Zero reads today's scheduled items from Notion, publishes them to Strapi, and queues the matching social posts in Buffer.",
    steps: [
      {
        title: "Zero reads today's calendar",
        description: "Zero pulls the items scheduled for today from Notion.",
      },
      {
        title: "Published to the CMS",
        description: "Zero pushes the content live in Strapi.",
      },
      {
        title: "Social queued in Buffer",
        description: "Zero schedules the promo posts in Buffer.",
      },
    ],
  },
  "blog-posts-to-x": {
    scenario:
      "One blog post can be ten social posts, but nobody has time to cut them up. Zero spots newly published posts, drafts a set of X variants, and queues them through Buffer for approval.",
    steps: [
      {
        title: "Zero finds new posts",
        description: "Zero detects newly published posts in Strapi.",
      },
      {
        title: "Cut into social variants",
        description: "Zero drafts several X posts from each article.",
      },
      {
        title: "Queued in Buffer",
        description: "Zero schedules the variants for review.",
      },
    ],
  },
  "draft-newsletter-mailchimp": {
    scenario:
      "The monthly newsletter always starts from a blank page. Zero gathers what shipped from GitHub, drafts the issue, and stages it in Mailchimp so you edit instead of author.",
    steps: [
      {
        title: "Zero gathers what shipped",
        description: "Zero reads merged features and highlights from GitHub.",
      },
      {
        title: "Newsletter drafted",
        description: "Zero writes the issue in your voice.",
      },
      {
        title: "Staged in Mailchimp",
        description: "Zero creates a ready-to-edit draft campaign.",
      },
    ],
  },
  "compare-google-ads-last-month": {
    scenario:
      "Ad pacing problems cost money for every day they go unnoticed. Zero compares spend, CPA, and ROAS to the prior period daily and flags anything drifting in Slack.",
    steps: [
      {
        title: "Zero reads ad performance",
        description:
          "Zero pulls spend, CPA, and conversions from Google and Meta Ads.",
      },
      {
        title: "Compared to prior period",
        description: "Zero computes the deltas and pacing.",
      },
      {
        title: "Anomalies flagged in Slack",
        description: "Zero posts the comparison and highlights drift.",
      },
    ],
  },
  "watch-brand-mentions": {
    scenario:
      "By the time you find the thread about your product, the conversation has moved on. Zero searches the web, Reddit, and X every hour and posts fresh mentions to Slack so you can jump in while it's live.",
    steps: [
      {
        title: "Zero searches for mentions",
        description: "Zero scans the web, Reddit, and X with Exa.",
      },
      {
        title: "New mentions filtered",
        description: "Zero keeps only fresh, relevant hits.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts each mention with a link and context.",
      },
    ],
  },
  "catch-leads-gmail": {
    scenario:
      "Warm leads hide in a busy inbox and go cold. Zero reads incoming mail for buying signals, enriches the sender with Apollo, logs the lead to a sheet, and suggests the next move in Slack.",
    steps: [
      {
        title: "Zero scans new mail",
        description: "Zero reads incoming Gmail for buying signals.",
      },
      {
        title: "Lead enriched and logged",
        description: "Zero enriches with Apollo and adds a row to your sheet.",
      },
      {
        title: "Next step suggested",
        description:
          "Zero posts the lead and a recommended next step to Slack.",
      },
    ],
  },
  "new-gmail-contacts-hubspot": {
    scenario:
      "Contacts slip through when nobody logs them. Zero notices email from someone not yet in HubSpot, creates the record, and enriches it with Apollo so the CRM stays complete without manual entry.",
    steps: [
      {
        title: "Zero spots an unknown sender",
        description: "Zero checks incoming mail against the CRM.",
      },
      {
        title: "Contact created and enriched",
        description:
          "Zero adds the person to HubSpot and enriches with Apollo.",
      },
      {
        title: "Logged for follow-up",
        description: "Zero records the contact and source on the timeline.",
      },
    ],
  },
  "research-new-signups-apollo": {
    scenario:
      "A new signup is an opportunity only if someone notices in time. Zero checks Clerk hourly, researches each new user and their company with Apollo, and posts a background snapshot to Slack.",
    steps: [
      {
        title: "Zero reads new signups",
        description: "Zero pulls new users from Clerk each hour.",
      },
      {
        title: "Researched with Apollo",
        description: "Zero enriches background and company context.",
      },
      {
        title: "Snapshot posted to Slack",
        description: "Zero posts each signup's profile to the channel.",
      },
    ],
  },
  "gmail-followups-auto": {
    scenario:
      "Follow-up is where deals are won and where they're forgotten. Zero advances your sequences daily and drafts the next touch for every non-reply so nothing goes stale.",
    steps: [
      {
        title: "Zero checks sequence status",
        description: "Zero reads who hasn't replied in Instantly and Apollo.",
      },
      {
        title: "Next touch drafted",
        description: "Zero writes the follow-up for each contact.",
      },
      {
        title: "Ready in Gmail",
        description: "Zero stages the drafts for your approval.",
      },
    ],
  },
  "prep-google-calendar-meetings": {
    scenario:
      "Walking into a call cold means winging it. Zero notices new external meetings, researches the attendee and company with Apollo, pulls prior call context from Gong, and DMs you a one-page brief before it starts.",
    steps: [
      {
        title: "A meeting is added",
        description:
          "Zero triggers when an external attendee joins your calendar.",
      },
      {
        title: "Attendee researched",
        description:
          "Zero enriches the person and company with Apollo and Gong.",
      },
      {
        title: "Prep brief sent to Slack",
        description: "Zero DMs you a one-page dossier before the call.",
      },
    ],
  },
  "log-gong-calls-hubspot": {
    scenario:
      "Call notes never make it into the CRM while they're fresh. Zero reads the Gong transcript after each call and writes the summary and next steps onto the HubSpot deal automatically.",
    steps: [
      {
        title: "Zero reads the transcript",
        description:
          "After the call, Zero pulls the recording notes from Gong.",
      },
      {
        title: "Summary and next steps drafted",
        description: "Zero extracts decisions and follow-ups.",
      },
      {
        title: "Logged to HubSpot",
        description: "Zero writes the notes onto the deal record.",
      },
    ],
  },
  "sort-route-zendesk-tickets": {
    scenario:
      "Every ticket needs triage before it can be answered. Zero reads each new ticket, assigns severity, routes it to the right queue, and drafts a first reply so agents start from a draft, not a blank box.",
    steps: [
      {
        title: "A ticket arrives",
        description: "Zero reads the new Zendesk ticket.",
      },
      {
        title: "Severity set and routed",
        description: "Zero classifies urgency and sends it to the right team.",
      },
      {
        title: "First reply drafted",
        description: "Zero stages an on-brand first response.",
      },
    ],
  },
  "draft-replies-notion-faq": {
    scenario:
      "Most questions are already answered in the docs. Zero reads the incoming question, looks up the FAQ in Notion, and drafts a reply grounded in your own docs for an agent to approve.",
    steps: [
      {
        title: "A question arrives",
        description: "Zero reads the new conversation in Intercom or Gmail.",
      },
      {
        title: "Zero checks the Notion FAQ",
        description: "Zero finds the relevant answer in your docs.",
      },
      {
        title: "Reply drafted for review",
        description: "Zero stages an on-brand response.",
      },
    ],
  },
  "send-bugs-github-slack": {
    scenario:
      "A bug report is only useful to engineers if it's complete. Zero picks up the bug label, assembles repro steps and customer impact, files it cleanly, and posts it to the engineering channel.",
    steps: [
      {
        title: "An issue is labeled bug",
        description: "Zero triggers on the bug label.",
      },
      {
        title: "Repro and impact packaged",
        description: "Zero assembles steps, impact, and context.",
      },
      {
        title: "Sent to engineering",
        description: "Zero posts the structured report to Slack.",
      },
    ],
  },
  "fixes-to-notion-help-docs": {
    scenario:
      "The same question comes back because the fix never got documented. Zero turns each resolved ticket into a clean, reusable help article in Notion so the answer exists next time.",
    steps: [
      {
        title: "A ticket is resolved",
        description: "Zero triggers when a ticket is closed.",
      },
      {
        title: "Fix written up",
        description: "Zero drafts a clear how-to from the resolution.",
      },
      {
        title: "Saved to Notion",
        description: "Zero adds the article to your help center.",
      },
    ],
  },
  "spot-churn-risk-stripe-zendesk": {
    scenario:
      "Churn is obvious only after it happens. Zero checks Stripe and Zendesk daily for billing trouble or ticket spikes, flags the at-risk accounts, and drafts a recovery email so someone can step in early.",
    steps: [
      {
        title: "Zero scans accounts",
        description:
          "Zero reads billing status from Stripe and ticket volume from Zendesk.",
      },
      {
        title: "At-risk accounts flagged",
        description: "Zero surfaces accounts showing churn signals.",
      },
      {
        title: "Recovery email drafted",
        description: "Zero drafts an outreach email for review.",
      },
    ],
  },
  "summarize-zendesk-tickets-daily": {
    scenario:
      "The support backlog is hard to see until it's a fire. Zero summarizes the last day of tickets by severity and age each morning and posts it to Slack so nothing rots unseen.",
    steps: [
      {
        title: "Zero reads the queue",
        description: "Zero pulls the last 24 hours of Zendesk tickets.",
      },
      {
        title: "Grouped by severity and age",
        description: "Zero organizes open tickets and flags stale ones.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the daily support digest.",
      },
    ],
  },
  "daily-company-brief-slack": {
    scenario:
      "The full picture lives in five tools nobody checks together. Zero pulls growth, revenue, product health, and engineering each morning and posts one company pulse to Slack: wins, risks, and what needs attention.",
    steps: [
      {
        title: "Zero gathers the signals",
        description:
          "Zero reads growth, revenue, errors, and shipping across your stack.",
      },
      {
        title: "Assembled into a pulse",
        description: "Zero writes wins, risks, and what needs attention.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the daily company brief.",
      },
    ],
  },
  "daily-industry-news-slack": {
    scenario:
      "Staying current means a dozen tabs you never open. Zero scans the last 24 hours of AI and competitor news each day and posts a short brief to Slack so you skim one summary instead.",
    steps: [
      {
        title: "Zero scans the news",
        description:
          "Zero searches AI and competitor coverage from the last day with Exa.",
      },
      {
        title: "Distilled into a brief",
        description: "Zero summarizes what actually matters.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the daily news brief.",
      },
    ],
  },
  "business-review-gamma": {
    scenario:
      "The weekly business review is a recurring deck someone rebuilds by hand. Zero pulls revenue and growth, builds the deck in Gamma, and has it ready before the meeting.",
    steps: [
      {
        title: "Zero pulls the numbers",
        description: "Zero reads MRR, burn, and growth from Stripe and Clerk.",
      },
      {
        title: "Deck built in Gamma",
        description: "Zero assembles the recurring business review.",
      },
      {
        title: "Ready to present",
        description: "Zero shares the finished deck.",
      },
    ],
  },
  "highlight-key-emails-gmail": {
    scenario:
      "An overflowing inbox buries the three emails that matter. Zero reads your mail each morning and surfaces only the ones that genuinely need you, posted to Slack.",
    steps: [
      {
        title: "Zero reads the inbox",
        description: "Zero scans overnight mail in Gmail.",
      },
      {
        title: "Priorities identified",
        description: "Zero filters to the few that need your attention.",
      },
      {
        title: "Posted to Slack",
        description: "Zero posts the shortlist with why each matters.",
      },
    ],
  },
  "investor-update-google-docs": {
    scenario:
      "The monthly investor update always starts late and from scratch. Zero gathers the KPIs and highlights and drafts the update in Google Docs so you refine instead of assemble.",
    steps: [
      {
        title: "Zero gathers KPIs",
        description: "Zero pulls revenue and growth from Stripe and Sheets.",
      },
      {
        title: "Update drafted",
        description: "Zero writes the narrative and metrics.",
      },
      {
        title: "Editable in Google Docs",
        description: "Zero leaves a ready-to-edit draft.",
      },
    ],
  },
  "gmail-reconnect-reminders": {
    scenario:
      "Relationships fade when you're heads-down. Zero reviews your inbox and calendar weekly, surfaces meaningful contacts you've gone quiet with, and suggests a natural opener to reconnect.",
    steps: [
      {
        title: "Zero reviews your contacts",
        description: "Zero reads recent email and calendar history.",
      },
      {
        title: "Quiet relationships surfaced",
        description:
          "Zero finds meaningful contacts you haven't touched lately.",
      },
      {
        title: "Openers suggested",
        description: "Zero posts each contact with a suggested opener.",
      },
    ],
  },
  "sync-asana-projects-notion": {
    scenario:
      "Status lives in Asana but leadership reads Notion. Zero rolls up task status daily into one Notion board and posts a digest so everyone sees the same picture without a status meeting.",
    steps: [
      {
        title: "Zero reads Asana",
        description: "Zero pulls task and project status across teams.",
      },
      {
        title: "Rolled into one board",
        description: "Zero updates a single Notion status board.",
      },
      {
        title: "Digest posted",
        description: "Zero posts a summary to Slack.",
      },
    ],
  },
  "meeting-notes-asana-tasks": {
    scenario:
      "Action items die in meeting notes. Zero reads the transcript after each meeting, pulls out the to-dos, and creates assigned Asana tasks so decisions actually turn into work.",
    steps: [
      {
        title: "Zero reads the transcript",
        description: "After the meeting, Zero pulls notes from Fireflies.",
      },
      {
        title: "Action items extracted",
        description: "Zero identifies to-dos and owners.",
      },
      {
        title: "Tasks created in Asana",
        description: "Zero files assigned tasks with due dates.",
      },
    ],
  },
  "file-gmail-invoices-drive": {
    scenario:
      "Invoices pile up in the inbox and reconciliation is a scramble. Zero files each labeled invoice to the right Drive folder and logs the amount and due date in your expense sheet as it arrives.",
    steps: [
      {
        title: "An invoice is labeled",
        description: "Zero triggers on your Invoices label in Gmail.",
      },
      {
        title: "Filed to Google Drive",
        description: "Zero saves the attachment to the correct folder.",
      },
      {
        title: "Logged in a sheet",
        description: "Zero records amount and due date in the expense sheet.",
      },
    ],
  },
  "onboard-new-hires-asana": {
    scenario:
      "Onboarding is the same checklist every time, done manually every time. Zero detects a new hire, spins up the onboarding project in Asana, and sets up their starter docs in Drive.",
    steps: [
      {
        title: "A new hire is added",
        description: "Zero detects the new record in Deel.",
      },
      {
        title: "Checklist created in Asana",
        description: "Zero fires the onboarding project with assigned tasks.",
      },
      {
        title: "Docs provisioned",
        description: "Zero sets up starter documents in Google Drive.",
      },
    ],
  },
  "chase-overdue-asana-tasks": {
    scenario:
      "Overdue tasks need someone to chase them, and that someone is always busy. Zero scans Asana daily for anything past due and nudges each owner in Slack.",
    steps: [
      {
        title: "Zero scans Asana",
        description: "Zero reads tasks that are past their due date.",
      },
      {
        title: "Owners identified",
        description: "Zero groups overdue work by assignee.",
      },
      {
        title: "Nudges sent in Slack",
        description: "Zero DMs each owner their overdue list.",
      },
    ],
  },
  "catch-calendar-conflicts": {
    scenario:
      "Double-bookings are only discovered when two meetings start at once. Zero checks each new event against your calendar and Cal.com availability and alerts you to conflicts before they land.",
    steps: [
      {
        title: "An event is created",
        description: "Zero triggers when a new event hits your calendar.",
      },
      {
        title: "Checked for conflicts",
        description: "Zero compares against existing events and availability.",
      },
      {
        title: "Conflict flagged in Slack",
        description: "Zero alerts you with the clash and options.",
      },
    ],
  },
  "sort-gmail-draft-replies": {
    scenario:
      "A full inbox is a full-time job. Zero sorts incoming mail by urgency and drafts replies in your voice so you skim and approve instead of typing from scratch.",
    steps: [
      {
        title: "Zero reads new mail",
        description: "Zero scans incoming Gmail messages.",
      },
      {
        title: "Sorted by urgency",
        description: "Zero labels what needs you now versus later.",
      },
      {
        title: "Replies drafted",
        description: "Zero stages responses for your approval.",
      },
    ],
  },
  "morning-brief-slack": {
    scenario:
      "The first ten minutes of the day go to figuring out what the day even is. Zero assembles your schedule and the emails that need you and posts a morning brief to Slack before you sit down.",
    steps: [
      {
        title: "Zero reads your day",
        description: "Zero pulls today's calendar and priority email.",
      },
      {
        title: "Brief assembled",
        description: "Zero writes your schedule and what needs attention.",
      },
      {
        title: "Posted to Slack",
        description: "Zero sends the morning brief.",
      },
    ],
  },
  "research-calendar-meetings": {
    scenario:
      "Showing up prepared means research you rarely have time for. Zero notices new meetings, looks up the attendees and their company, and sends you a one-page dossier before it starts.",
    steps: [
      {
        title: "A meeting is added",
        description: "Zero triggers on new calendar events.",
      },
      {
        title: "Attendees researched",
        description: "Zero looks up the people and company with Exa.",
      },
      {
        title: "Dossier delivered",
        description: "Zero sends a one-page brief to Slack before the call.",
      },
    ],
  },
  "summarize-gmail-newsletters": {
    scenario:
      "You subscribe to twenty newsletters and read none. Zero collects everything you've labeled as a newsletter and posts one tidy weekly digest so you get the signal without the pile.",
    steps: [
      {
        title: "Zero collects newsletters",
        description: "Zero reads messages under your Newsletters label.",
      },
      {
        title: "Digested into one summary",
        description: "Zero pulls the key points from each.",
      },
      {
        title: "Posted to Slack",
        description: "Zero sends the weekly digest.",
      },
    ],
  },
  "meeting-recaps-slack": {
    scenario:
      "The details of a meeting fade by the next one. Zero reads the transcript afterward and sends a clean recap of decisions and action items so nothing gets lost.",
    steps: [
      {
        title: "Zero reads the transcript",
        description: "After the meeting, Zero pulls notes from Fireflies.",
      },
      {
        title: "Recap written",
        description: "Zero summarizes decisions and action items.",
      },
      {
        title: "Sent to you",
        description: "Zero delivers the recap to Gmail or Slack.",
      },
    ],
  },
  "flagged-gmail-todoist-tasks": {
    scenario:
      "Flagging an email just moves the decision later. Zero picks up the flag, researches the topic and prior thread, and files a Todoist task with the context already attached.",
    steps: [
      {
        title: "You flag an email",
        description: "Zero triggers on your to-do label in Gmail.",
      },
      {
        title: "Zero researches it",
        description: "Zero gathers prior thread context and web info with Exa.",
      },
      {
        title: "Task filed in Todoist",
        description: "Zero creates a ready-to-do task with links.",
      },
    ],
  },
};
