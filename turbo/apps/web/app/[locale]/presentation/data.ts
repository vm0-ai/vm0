export interface PresentationItem {
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly embedUrl: string;
}

export const PRESENTATION_ITEMS: readonly PresentationItem[] = [
  {
    slug: "starship-v3-investor-update",
    title: "Starship V3 Investor Update",
    prompt:
      "/gen presentation with design system `spacex` and template `html-ppt-pitch-deck`, create a Starship V3 investor update deck. Cadence numbers, payload mass to LEO, Raptor 3 cost curve, lunar Starlink V3 architecture, and 18-month roadmap. Make it feel aerospace, technical, austere, bold.",
    embedUrl: "https://starship-v3-investor-update-715f6d07.sites.vm0.io",
  },
  {
    slug: "vision-pro-studio-keynote",
    title: "Vision Pro Studio Keynote",
    prompt:
      "/gen presentation with design system `apple` and template `html-ppt-product-launch`, create a Vision Pro Studio Edition launch keynote. Hero reveal, R2 silicon specs, spatial workflows demo, pricing tiers, availability windows. Make it feel cinematic, minimal, premium.",
    embedUrl: "https://vision-pro-studio-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "tesla-q3-2026-shareholder-talk",
    title: "Tesla Q3 2026 Shareholder Talk",
    prompt:
      "/gen presentation with design system `tesla` and template `html-ppt-presenter-mode-reveal`, create a Q3 2026 vehicle delivery and FSD v14 shareholder talk. Production ramp, energy storage attach, FSD miles-per-intervention, Cybercab pilot cities, gigafactory map. Make it feel kinetic, sleek, confident.",
    embedUrl:
      "https://tesla-q3-2026-shareholder-talk-715f6d07-715f6d07.sites.vm0.io",
  },
  {
    slug: "ferrari-sf90-xx-unveiling",
    title: "Ferrari SF90 Xx Unveiling",
    prompt:
      "/gen presentation with design system `ferrari` and template `html-ppt-zhangzara-bold-poster`, create an SF90 XX Stradale press unveiling. Powertrain reveal, aero numbers, track lap record, livery palette, owner-program tiers. Make it feel red-blooded, editorial, prestige.",
    embedUrl:
      "https://ferrari-sf90-xx-unveiling-715f6d07-715f6d07.sites.vm0.io",
  },
  {
    slug: "air-max-day-2026-campaign",
    title: "Air Max Day 2026 Campaign",
    prompt:
      "/gen presentation with design system `nike` and template `html-ppt-zhangzara-coral`, create an Air Max Day 2026 brand campaign deck. Story arc, athlete ambassadors, drop calendar, retail activations, social moments. Make it feel bold, kinetic, street.",
    embedUrl: "https://air-max-day-2026-campaign-715f6d07.sites.vm0.io",
  },
  {
    slug: "crypto-liquidity-flow-research",
    title: "Crypto Liquidity Flow Research",
    prompt:
      "/gen presentation with design system `binance` and template `html-ppt-graphify-dark-graph`, create a crypto liquidity flow research readout. Order book heatmap, market-maker graph, stablecoin corridors, MEV anomalies, settlement latency. Make it feel dark, quantitative, technical.",
    embedUrl: "https://crypto-liquidity-flow-research-715f6d07.sites.vm0.io",
  },
  {
    slug: "bmw-neue-klasse-brand-book",
    title: "Bmw Neue Klasse Brand Book",
    prompt:
      "/gen presentation with design system `bmw` and template `html-ppt-zhangzara-broadside`, create a Neue Klasse design language brand book unveil. Silhouette sketches, Hofmeister kink evolution, interior philosophy, color palette, model rollout. Make it feel precise, modernist, refined.",
    embedUrl: "https://bmw-neue-klasse-brand-book-715f6d07.sites.vm0.io",
  },
  {
    slug: "bmw-m5-cs-touring-keynote",
    title: "Bmw M5 CS Touring Keynote",
    prompt:
      "/gen presentation with design system `bmw-m` and template `html-ppt-product-launch`, create an M5 CS Touring launch keynote. Power numbers, Nurburgring time, chassis tech, livery options, customer track-day program. Make it feel motorsport, aggressive, premium.",
    embedUrl: "https://bmw-m5-cs-touring-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "bugatti-tourbillon-owners-briefing",
    title: "Bugatti Tourbillon Owners Briefing",
    prompt:
      "/gen presentation with design system `bugatti` and template `html-ppt-zhangzara-monochrome`, create a Tourbillon hyper-GT owners briefing. Powertrain, atelier customization, Molsheim delivery experience, road-touring routes, heritage references. Make it feel luxury, hand-built, French-refined.",
    embedUrl:
      "https://bugatti-tourbillon-owners-briefing-715f6d07.sites.vm0.io",
  },
  {
    slug: "lamborghini-revuelto-2027-lineup",
    title: "Lamborghini Revuelto 2027 Lineup",
    prompt:
      "/gen presentation with design system `lamborghini` and template `html-ppt-zhangzara-studio`, create a Revuelto color and trim 2027 lineup deck. Ad Personam palettes, carbon weave options, Y-shape design language, dealer rollout, owner events. Make it feel high-voltage, theatrical, exotic.",
    embedUrl: "https://lamborghini-revuelto-2027-lineup-715f6d07.sites.vm0.io",
  },
  {
    slug: "renault-5-etech-retro-launch",
    title: "Renault 5 Etech Retro Launch",
    prompt:
      "/gen presentation with design system `renault` and template `html-ppt-zhangzara-cartesian`, create a Renault 5 E-Tech retro-launch deck. Heritage timeline, battery options, charging network, color palette, French market positioning. Make it feel warm, design-forward, French.",
    embedUrl: "https://renault-5-etech-retro-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "openai-gpt-6-conf-talk",
    title: "Openai GPT 6 Conf Talk",
    prompt:
      "/gen presentation with design system `openai` and template `html-ppt-tech-sharing`, create a GPT-6 capability and safety conference talk. Reasoning benchmarks, training compute, alignment evals, deployment policy, partner ecosystem. Make it feel research, candid, technical.",
    embedUrl: "https://openai-gpt-6-conf-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "claude-5-model-deep-dive",
    title: "Claude 5 Model Deep Dive",
    prompt:
      "/gen presentation with design system `claude` and template `html-ppt-obsidian-claude-gradient`, create a Claude 5 model card and product deep-dive. Eval suite, constitutional AI updates, context window, agent harness, customer wins. Make it feel thoughtful, deliberate, gradient-elegant.",
    embedUrl: "https://claude-5-model-deep-dive-715f6d07.sites.vm0.io",
  },
  {
    slug: "cohere-enterprise-rag-arch",
    title: "Cohere Enterprise RAG Arch",
    prompt:
      "/gen presentation with design system `cohere` and template `html-ppt-knowledge-arch-blueprint`, create an enterprise RAG reference architecture session. Embedding pipeline, retrieval graph, reranker stack, eval harness, deployment topology. Make it feel architectural, enterprise, blueprint-clean.",
    embedUrl: "https://cohere-enterprise-rag-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "mixtral-next-moe-research",
    title: "Mixtral Next Moe Research",
    prompt:
      "/gen presentation with design system `mistral-ai` and template `html-ppt-tech-sharing`, create a Mixtral-Next mixture-of-experts research talk. Routing math, expert utilization charts, throughput benchmarks, open-weight policy, partner programs. Make it feel European, research, candid.",
    embedUrl: "https://mixtral-next-moe-research-715f6d07.sites.vm0.io",
  },
  {
    slug: "huggingface-state-of-the-hub",
    title: "Huggingface State Of The Hub",
    prompt:
      "/gen presentation with design system `huggingface` and template `html-ppt-creative-mode`, create an open model community state-of-the-hub annual recap. Downloads dashboard, top contributors, dataset spotlights, hub partnerships, roadmap. Make it feel warm, community, playful.",
    embedUrl: "https://huggingface-state-of-the-hub-715f6d07.sites.vm0.io",
  },
  {
    slug: "grok-4-infra-disclosure",
    title: "Grok 4 Infra Disclosure",
    prompt:
      "/gen presentation with design system `x-ai` and template `html-ppt-hermes-cyber-terminal`, create a Grok 4 capability and infra disclosure. Training cluster, Colossus topology, tool use evals, deployment guardrails, public usage stats. Make it feel cyberpunk, terminal, bold.",
    embedUrl: "https://grok-4-infra-disclosure-715f6d07.sites.vm0.io",
  },
  {
    slug: "minimax-m2-product-launch",
    title: "Minimax M2 Product Launch",
    prompt:
      "/gen presentation with design system `minimax` and template `html-ppt-xhs-white-editorial`, create a MiniMax M2 product launch deck. Multimodal samples, agent benchmarks, partner integrations, China-market rollout, pricing tiers. Make it feel pastel, modern, friendly.",
    embedUrl: "https://minimax-m2-product-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "nvidia-blackwell-ultra-arch",
    title: "NVIDIA Blackwell Ultra Arch",
    prompt:
      "/gen presentation with design system `nvidia` and template `html-ppt-knowledge-arch-blueprint`, create a Blackwell Ultra reference data-center architecture briefing. NVLink fabric, rack power profile, liquid cooling, cluster topology, MLPerf numbers. Make it feel architectural, high-performance, technical.",
    embedUrl: "https://nvidia-blackwell-ultra-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "ibm-consulting-hybrid-cloud-qbr",
    title: "IBM Consulting Hybrid Cloud QBR",
    prompt:
      "/gen presentation with design system `ibm` and template `html-ppt-weekly-report`, create an IBM Consulting hybrid-cloud QBR for a Fortune 100 client. Engagement KPIs, workload migration progress, FinOps savings, risk register, next-quarter roadmap. Make it feel corporate, measured, enterprise.",
    embedUrl: "https://ibm-consulting-hybrid-cloud-qbr-715f6d07.sites.vm0.io",
  },
  {
    slug: "cisco-netops-weekly-status",
    title: "Cisco Netops Weekly Status",
    prompt:
      "/gen presentation with design system `cisco` and template `html-ppt-weekly-report`, create a global NetOps weekly status report. SLA dashboards, incident summary, capacity headroom, security posture, change calendar. Make it feel corporate, operational, clear.",
    embedUrl: "https://cisco-netops-weekly-status-715f6d07.sites.vm0.io",
  },
  {
    slug: "meta-rayban-display-keynote",
    title: "Meta Rayban Display Keynote",
    prompt:
      "/gen presentation with design system `meta` and template `html-ppt-product-launch`, create a Ray-Ban Display launch keynote. Hardware specs, AI assistant demos, social capture stories, pricing tiers, retail rollout. Make it feel cinematic, social, premium.",
    embedUrl: "https://meta-rayban-display-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "discord-community-summit-2026",
    title: "Discord Community Summit 2026",
    prompt:
      "/gen presentation with design system `discord` and template `html-ppt-zhangzara-block-frame`, create a Discord platform 2026 community summit deck. New voice features, Activities SDK, creator monetization, moderator tools, partner spotlights. Make it feel playful, pastel-pop, community.",
    embedUrl: "https://discord-community-summit-2026-715f6d07.sites.vm0.io",
  },
  {
    slug: "slack-enterprise-success-qbr",
    title: "Slack Enterprise Success QBR",
    prompt:
      "/gen presentation with design system `slack` and template `html-ppt-weekly-report`, create an enterprise customer success QBR for a 30k-seat account. Adoption metrics, channel health, integrations attached, automation hours saved, renewal motion. Make it feel corporate, friendly, structured.",
    embedUrl: "https://slack-enterprise-success-qbr-715f6d07.sites.vm0.io",
  },
  {
    slug: "notion-ai-pm-training-module",
    title: "Notion AI PM Training Module",
    prompt:
      "/gen presentation with design system `notion` and template `html-ppt-course-module`, create a Notion AI for product managers self-paced training module. Lesson outline, exercises, AI prompt library, project rubric, completion checklist. Make it feel warm, editorial, instructional.",
    embedUrl: "https://notion-ai-pm-training-module-715f6d07.sites.vm0.io",
  },
  {
    slug: "airbnb-icons-2027-host-pitch",
    title: "Airbnb Icons 2027 Host Pitch",
    prompt:
      "/gen presentation with design system `airbnb` and template `html-ppt-zhangzara-soft-editorial`, create an Airbnb Icons 2027 host pitch deck. Story collections, guest personas, photography moodboard, host requirements, payout economics. Make it feel warm, editorial, hospitable.",
    embedUrl: "https://airbnb-icons-2027-host-pitch-715f6d07.sites.vm0.io",
  },
  {
    slug: "airtable-cobuilder-arch",
    title: "Airtable Cobuilder Arch",
    prompt:
      "/gen presentation with design system `airtable` and template `html-ppt-knowledge-arch-blueprint`, create an Airtable Cobuilder reference architecture briefing for enterprise IT. Data model, sync graph, automation engine, governance layer, rollout plan. Make it feel architectural, enterprise, blueprint-clean.",
    embedUrl: "https://airtable-cobuilder-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "ant-design-v6-governance-review",
    title: "Ant Design V6 Governance Review",
    prompt:
      "/gen presentation with design system `ant` and template `html-ppt-weekly-report`, create an Ant Design System v6 internal governance review. Component adoption, theming changes, accessibility scores, release calendar, open issues. Make it feel structured, corporate, clear.",
    embedUrl: "https://ant-design-v6-governance-review-715f6d07.sites.vm0.io",
  },
  {
    slug: "cal-com-routing-forms-v2-launch",
    title: "Cal Com Routing Forms V2 Launch",
    prompt:
      "/gen presentation with design system `cal` and template `html-ppt-product-launch`, create a Cal.com Routing Forms v2 launch deck. New form builder, workflow webhooks, embed SDK, pricing tiers, customer wins. Make it feel friendly, modern, developer.",
    embedUrl: "https://cal-com-routing-forms-v2-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "canva-design-ai-allhands",
    title: "Canva Design AI Allhands",
    prompt:
      "/gen presentation with design system `canva` and template `html-ppt-zhangzara-creative-mode`, create a Canva Design AI for marketers all-hands deck. New magic features, brand kits, education program, case studies, roadmap. Make it feel colorful, friendly, energetic.",
    embedUrl: "https://canva-design-ai-allhands-715f6d07.sites.vm0.io",
  },
  {
    slug: "clickhouse-query-performance-talk",
    title: "Clickhouse Query Performance Talk",
    prompt:
      "/gen presentation with design system `clickhouse` and template `html-ppt-tech-sharing`, create a ClickHouse Cloud query-performance deep-dive conference talk. JOIN reordering, parallel replicas, S3 cold tier, benchmark vs Snowflake, optimization recipes. Make it feel technical, candid, performance.",
    embedUrl: "https://clickhouse-query-performance-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "coinbase-institutional-prime-deck",
    title: "Coinbase Institutional Prime Deck",
    prompt:
      "/gen presentation with design system `coinbase` and template `html-ppt-pitch-deck`, create a Coinbase Institutional prime-brokerage sales deck. AUC scale, custody architecture, OTC desk, derivatives roadmap, regulatory posture. Make it feel institutional, sleek, blue-chip.",
    embedUrl: "https://coinbase-institutional-prime-deck-715f6d07.sites.vm0.io",
  },
  {
    slug: "composio-agent-tooling-arch",
    title: "Composio Agent Tooling Arch",
    prompt:
      "/gen presentation with design system `composio` and template `html-ppt-knowledge-arch-blueprint`, create a Composio agent-tooling reference architecture for an enterprise prospect. Tool registry, auth proxy, sandboxing layer, observability, integration matrix. Make it feel architectural, technical, clean.",
    embedUrl: "https://composio-agent-tooling-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "cursor-1-0-developer-conf",
    title: "Cursor 1 0 Developer Conf",
    prompt:
      "/gen presentation with design system `cursor` and template `html-ppt-tech-sharing`, create a Cursor 1.0 developer conference talk. Agent mode demo, codebase indexing, MCP support, enterprise SSO, pricing. Make it feel developer, sleek, confident.",
    embedUrl: "https://cursor-1-0-developer-conf-715f6d07.sites.vm0.io",
  },
  {
    slug: "duolingo-math-parents-launch",
    title: "Duolingo Math Parents Launch",
    prompt:
      "/gen presentation with design system `duolingo` and template `html-ppt-zhangzara-daisy-days`, create a Duolingo Math launch deck for parents and educators. Curriculum scope, gamification mechanics, parent dashboard, school program, pricing. Make it feel cheerful, friendly, family.",
    embedUrl: "https://duolingo-math-parents-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "elevenlabs-voice-3-keynote",
    title: "Elevenlabs Voice 3 Keynote",
    prompt:
      "/gen presentation with design system `elevenlabs` and template `html-ppt-product-launch`, create an ElevenLabs Voice 3 model launch keynote. Sample reel, latency benchmarks, voice cloning policy, agent voices, pricing tiers. Make it feel premium, voice-forward, sleek.",
    embedUrl: "https://elevenlabs-voice-3-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "expo-router-v5-conf-talk",
    title: "Expo Router V5 Conf Talk",
    prompt:
      "/gen presentation with design system `expo` and template `html-ppt-tech-sharing`, create an Expo Router v5 conference talk. New routing primitives, server components, EAS updates, performance wins, migration guide. Make it feel developer, friendly, technical.",
    embedUrl: "https://expo-router-v5-conf-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "figma-sites-ga-keynote",
    title: "Figma Sites GA Keynote",
    prompt:
      "/gen presentation with design system `figma` and template `html-ppt-product-launch`, create a Figma Sites GA launch keynote. New site editor, CMS panel, publishing pipeline, pricing, customer stories. Make it feel design, premium, modern.",
    embedUrl: "https://figma-sites-ga-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "framer-ai-sites-2026-launch",
    title: "Framer AI Sites 2026 Launch",
    prompt:
      "/gen presentation with design system `framer` and template `html-ppt-product-launch`, create a Framer AI Sites 2026 launch deck. Prompt-to-site demo, CMS, SEO panel, e-commerce add-on, pricing. Make it feel design, friendly, fast.",
    embedUrl: "https://framer-ai-sites-2026-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "github-universe-copilot-keynote",
    title: "Github Universe Copilot Keynote",
    prompt:
      "/gen presentation with design system `github` and template `html-ppt-tech-sharing`, create a GitHub Universe Copilot Workspace keynote. Issue-to-PR flow, plan-edit-test loop, enterprise rollout, security posture, customer wins. Make it feel developer, candid, confident.",
    embedUrl: "https://github-universe-copilot-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "terraform-stacks-bank-arch",
    title: "Terraform Stacks Bank Arch",
    prompt:
      "/gen presentation with design system `hashicorp` and template `html-ppt-knowledge-arch-blueprint`, create a Terraform Stacks reference deployment architecture for a bank. Stack topology, state isolation, policy guardrails, CI/CD pipeline, migration plan. Make it feel architectural, enterprise, precise.",
    embedUrl: "https://terraform-stacks-bank-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "intercom-fin-ai-agent-sales",
    title: "Intercom Fin AI Agent Sales",
    prompt:
      "/gen presentation with design system `intercom` and template `html-ppt-pitch-deck`, create an Intercom Fin AI Agent enterprise sales deck. Deflection rate proof, integrations, governance controls, pricing model, customer wins. Make it feel modern, friendly, sales.",
    embedUrl: "https://intercom-fin-ai-agent-sales-715f6d07.sites.vm0.io",
  },
  {
    slug: "kraken-pro-flash-crash-postmortem",
    title: "Kraken Pro Flash Crash Postmortem",
    prompt:
      "/gen presentation with design system `kraken` and template `html-ppt-hermes-cyber-terminal`, create a Kraken Pro trading platform internal post-mortem on a flash-crash incident. Timeline, order book state, throttle decisions, customer comms, remediation. Make it feel terminal, candid, technical.",
    embedUrl: "https://kraken-pro-flash-crash-postmortem-715f6d07.sites.vm0.io",
  },
  {
    slug: "levels-metabolic-q-report",
    title: "Levels Metabolic Q Report",
    prompt:
      "/gen presentation with design system `levels` and template `html-ppt-xhs-pastel-card`, create a Levels metabolic health quarterly member report. Glucose variability trends, food correlations, sleep impact, exercise wins, next-quarter goals. Make it feel calm, pastel, member-friendly.",
    embedUrl: "https://levels-metabolic-q-report-715f6d07.sites.vm0.io",
  },
  {
    slug: "linear-product-intelligence-keynote",
    title: "Linear Product Intelligence Keynote",
    prompt:
      "/gen presentation with design system `linear-app` and template `html-ppt-presenter-mode-reveal`, create a Linear Product Intelligence launch keynote. New insights view, AI triage, roadmap canvas, customer wins, pricing tiers. Make it feel modern, sleek, confident.",
    embedUrl:
      "https://linear-product-intelligence-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "lingo-localization-ops-training",
    title: "Lingo Localization Ops Training",
    prompt:
      "/gen presentation with design system `lingo` and template `html-ppt-course-module`, create a Lingo localization-ops onboarding training module for translators. Workflow walkthrough, glossary, QA checks, payout calendar, certification path. Make it feel warm, instructional, friendly.",
    embedUrl: "https://lingo-localization-ops-training-715f6d07.sites.vm0.io",
  },
  {
    slug: "loom-ai-workflows-launch",
    title: "Loom AI Workflows Launch",
    prompt:
      "/gen presentation with design system `loom` and template `html-ppt-product-launch`, create a Loom AI Workflows launch deck. Auto-summary, action items, integrations, enterprise SSO, pricing. Make it feel friendly, modern, video-first.",
    embedUrl: "https://loom-ai-workflows-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "lovable-v3-community-launch",
    title: "Lovable V3 Community Launch",
    prompt:
      "/gen presentation with design system `lovable` and template `html-ppt-zhangzara-playful`, create a Lovable v3 community launch deck. Prompt-to-app demo, project gallery, builder economics, partner ecosystem, roadmap. Make it feel playful, friendly, indie.",
    embedUrl: "https://lovable-v3-community-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "mastercard-fraud-risk-council",
    title: "Mastercard Fraud Risk Council",
    prompt:
      "/gen presentation with design system `mastercard` and template `html-ppt-weekly-report`, create a Mastercard fraud-risk weekly council report. Authorization-decline trends, model performance, geo heatmap, issuer alerts, control changes. Make it feel corporate, structured, financial.",
    embedUrl: "https://mastercard-fraud-risk-council-715f6d07.sites.vm0.io",
  },
  {
    slug: "mintlify-docs-writing-workshop",
    title: "Mintlify Docs Writing Workshop",
    prompt:
      "/gen presentation with design system `mintlify` and template `html-ppt-course-module`, create a Mintlify docs-writing workshop deck for new technical writers. Module outline, examples, exercise prompts, peer review, certification. Make it feel warm, editorial, instructional.",
    embedUrl: "https://mintlify-docs-writing-workshop-715f6d07.sites.vm0.io",
  },
  {
    slug: "miro-innovation-workshop",
    title: "Miro Innovation Workshop",
    prompt:
      "/gen presentation with design system `miro` and template `html-ppt-zhangzara-scatterbrain`, create a Miro Innovation Workspace customer co-creation workshop deck. Discovery board, opportunity map, prototype sticky notes, voting matrix, next steps. Make it feel post-it, playful, workshop.",
    embedUrl: "https://miro-innovation-workshop-715f6d07.sites.vm0.io",
  },
  {
    slug: "mongodb-atlas-vector-search-talk",
    title: "Mongodb Atlas Vector Search Talk",
    prompt:
      "/gen presentation with design system `mongodb` and template `html-ppt-tech-sharing`, create a MongoDB Atlas Vector Search conference talk. Index internals, hybrid search, embedding refresh, benchmark numbers, customer wins. Make it feel technical, candid, database.",
    embedUrl: "https://mongodb-atlas-vector-search-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "ollama-on-device-community-talk",
    title: "Ollama On Device Community Talk",
    prompt:
      "/gen presentation with design system `ollama` and template `html-ppt-hermes-cyber-terminal`, create an Ollama on-device deployment community talk. Model zoo, GPU profile guide, quantization tradeoffs, MCP integration, roadmap. Make it feel terminal, indie, technical.",
    embedUrl: "https://ollama-on-device-community-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "perplexity-pages-comet-keynote",
    title: "Perplexity Pages Comet Keynote",
    prompt:
      "/gen presentation with design system `perplexity` and template `html-ppt-product-launch`, create a Perplexity Pages and Comet browser launch keynote. New page editor, agent browsing, pricing tiers, partner publishers, growth. Make it feel sleek, modern, research.",
    embedUrl: "https://perplexity-pages-comet-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "pinterest-predicts-2027",
    title: "Pinterest Predicts 2027",
    prompt:
      "/gen presentation with design system `pinterest` and template `html-ppt-xhs-post`, create a Pinterest Predicts 2027 trend release. Trend cards, search-volume charts, brand opportunity callouts, creator quotes, campaign ideas. Make it feel editorial, pastel, lifestyle.",
    embedUrl: "https://pinterest-predicts-2027-715f6d07.sites.vm0.io",
  },
  {
    slug: "posthog-product-eng-metrics-talk",
    title: "Posthog Product Eng Metrics Talk",
    prompt:
      "/gen presentation with design system `posthog` and template `html-ppt-tech-sharing`, create a PostHog product-engineering metrics conference talk. North-star tree, experiments velocity, retention curves, error budgets, recipes. Make it feel candid, technical, indie.",
    embedUrl: "https://posthog-product-eng-metrics-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "raycast-for-teams-keynote",
    title: "Raycast For Teams Keynote",
    prompt:
      "/gen presentation with design system `raycast` and template `html-ppt-product-launch`, create a Raycast for Teams launch keynote. Shared snippets, AI commands, team analytics, pricing tiers, enterprise readiness. Make it feel sleek, premium, developer.",
    embedUrl: "https://raycast-for-teams-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "replicate-model-serving-infra-talk",
    title: "Replicate Model Serving Infra Talk",
    prompt:
      "/gen presentation with design system `replicate` and template `html-ppt-tech-sharing`, create a Replicate model-serving infra deep-dive talk. Cold-start architecture, scheduler, GPU bin packing, cost economics, roadmap. Make it feel technical, candid, infra.",
    embedUrl:
      "https://replicate-model-serving-infra-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "resend-broadcasts-2-launch",
    title: "Resend Broadcasts 2 Launch",
    prompt:
      "/gen presentation with design system `resend` and template `html-ppt-product-launch`, create a Resend Broadcasts 2.0 launch deck. New editor, segmentation, deliverability dashboard, pricing, customer wins. Make it feel modern, friendly, developer.",
    embedUrl: "https://resend-broadcasts-2-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "revolut-business-latam-update",
    title: "Revolut Business Latam Update",
    prompt:
      "/gen presentation with design system `revolut` and template `html-ppt-pitch-deck`, create a Revolut Business expansion-to-LATAM investor update. Market sizing, regulatory path, product wedge, unit economics, hiring plan. Make it feel sleek, fintech, confident.",
    embedUrl: "https://revolut-business-latam-update-715f6d07.sites.vm0.io",
  },
  {
    slug: "runway-gen-4-film-tools",
    title: "Runway Gen 4 Film Tools",
    prompt:
      "/gen presentation with design system `runwayml` and template `html-ppt-zhangzara-bold-poster`, create a Runway Gen-4 film-tools launch deck for studios. Pipeline integration, look-dev examples, talent quotes, festival placements, pricing. Make it feel cinematic, bold, editorial.",
    embedUrl: "https://runway-gen-4-film-tools-715f6d07.sites.vm0.io",
  },
  {
    slug: "sanity-content-platform-arch",
    title: "Sanity Content Platform Arch",
    prompt:
      "/gen presentation with design system `sanity` and template `html-ppt-knowledge-arch-blueprint`, create a Sanity content-platform reference architecture for a media company. Content graph, GROQ queries, syndication pipeline, governance, migration plan. Make it feel architectural, editorial, clean.",
    embedUrl: "https://sanity-content-platform-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "sentry-prod-outage-postmortem",
    title: "Sentry Prod Outage Postmortem",
    prompt:
      "/gen presentation with design system `sentry` and template `html-ppt-testing-safety-alert`, create a production incident post-mortem deck for a major customer outage. Incident timeline, blast radius, contributing factors, remediation, follow-ups. Make it feel alert, accountable, structured.",
    embedUrl: "https://sentry-prod-outage-postmortem-715f6d07.sites.vm0.io",
  },
  {
    slug: "shopify-magic-merchants-launch",
    title: "Shopify Magic Merchants Launch",
    prompt:
      "/gen presentation with design system `shopify` and template `html-ppt-product-launch`, create a Shopify Magic for Merchants summer edition launch deck. AI tools demo, store templates, payment updates, merchant case studies, pricing. Make it feel friendly, modern, commerce.",
    embedUrl: "https://shopify-magic-merchants-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "spotify-wrapped-2027",
    title: "Spotify Wrapped 2027",
    prompt:
      "/gen presentation with design system `spotify` and template `html-ppt-product-launch`, create a Spotify Wrapped 2027 product launch deck. Personalization features, creator stories, advertiser opportunities, partner spotlights, rollout calendar. Make it feel kinetic, expressive, music-first.",
    embedUrl: "https://spotify-wrapped-2027-715f6d07.sites.vm0.io",
  },
  {
    slug: "starbucks-reserve-brand-book",
    title: "Starbucks Reserve Brand Book",
    prompt:
      "/gen presentation with design system `starbucks` and template `html-ppt-zhangzara-mat`, create a Starbucks Reserve global brand book unveil. Bean story, store design language, beverage rituals, art collaborations, market rollout. Make it feel warm, refined, cafe.",
    embedUrl: "https://starbucks-reserve-brand-book-715f6d07.sites.vm0.io",
  },
  {
    slug: "stripe-marketplace-arch",
    title: "Stripe Marketplace Arch",
    prompt:
      "/gen presentation with design system `stripe` and template `html-ppt-knowledge-arch-blueprint`, create a Stripe platform reference architecture for a marketplace. Account model, Connect flows, Tax engine, Radar, settlement timeline. Make it feel architectural, fintech, precise.",
    embedUrl: "https://stripe-marketplace-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "supabase-postgres-17-talk",
    title: "Supabase Postgres 17 Talk",
    prompt:
      "/gen presentation with design system `supabase` and template `html-ppt-tech-sharing`, create a Supabase Postgres 17 features conference talk. Foreign data wrappers, vector index, realtime improvements, edge functions, customer wins. Make it feel developer, candid, open-source.",
    embedUrl: "https://supabase-postgres-17-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "superhuman-ai-inbox-launch",
    title: "Superhuman AI Inbox Launch",
    prompt:
      "/gen presentation with design system `superhuman` and template `html-ppt-product-launch`, create a Superhuman AI Inbox launch deck. New triage flow, command palette, calendar integration, pricing tiers, testimonials. Make it feel premium, sleek, productivity.",
    embedUrl: "https://superhuman-ai-inbox-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "together-inference-engine-talk",
    title: "Together Inference Engine Talk",
    prompt:
      "/gen presentation with design system `together-ai` and template `html-ppt-tech-sharing`, create a Together Inference Engine performance research talk. Speculative decoding, KV cache reuse, MLPerf benchmarks, partner stories, roadmap. Make it feel research, technical, candid.",
    embedUrl: "https://together-inference-engine-talk-715f6d07.sites.vm0.io",
  },
  {
    slug: "uber-eats-marketplace-wbr",
    title: "Uber Eats Marketplace WBR",
    prompt:
      "/gen presentation with design system `uber` and template `html-ppt-weekly-report`, create an Uber Eats marketplace weekly business review. Cohort GMV, courier supply, restaurant churn, ad revenue, growth experiments. Make it feel corporate, marketplace, data-driven.",
    embedUrl: "https://uber-eats-marketplace-wbr-715f6d07.sites.vm0.io",
  },
  {
    slug: "vercel-v0-ga-enterprise-launch",
    title: "Vercel V0 GA Enterprise Launch",
    prompt:
      "/gen presentation with design system `vercel` and template `html-ppt-product-launch`, create a Vercel v0 GA enterprise launch deck. New site builder, AI workflow, design partner stories, pricing, enterprise controls. Make it feel sleek, modern, developer.",
    embedUrl: "https://vercel-v0-ga-enterprise-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "vodafone-enterprise-services-qbr",
    title: "Vodafone Enterprise Services QBR",
    prompt:
      "/gen presentation with design system `vodafone` and template `html-ppt-weekly-report`, create a Vodafone enterprise-services QBR for a multinational client. SLA scorecards, network performance, security posture, change calendar, roadmap. Make it feel corporate, telco, structured.",
    embedUrl: "https://vodafone-enterprise-services-qbr-715f6d07.sites.vm0.io",
  },
  {
    slug: "webex-contact-center-qbr",
    title: "Webex Contact Center QBR",
    prompt:
      "/gen presentation with design system `webex` and template `html-ppt-weekly-report`, create a Webex Contact Center QBR for a Fortune 500 client. Adoption stats, AI agent attach, queue performance, NPS, renewal plan. Make it feel corporate, professional, clear.",
    embedUrl: "https://webex-contact-center-qbr-715f6d07.sites.vm0.io",
  },
  {
    slug: "webflow-conf-2026-keynote",
    title: "Webflow Conf 2026 Keynote",
    prompt:
      "/gen presentation with design system `webflow` and template `html-ppt-zhangzara-creative-mode`, create a Webflow Conf 2026 keynote deck. Designer 2 release, AI site builder, CMS upgrades, partner showcase, ecosystem stats. Make it feel colorful, design, energetic.",
    embedUrl: "https://webflow-conf-2026-keynote-715f6d07.sites.vm0.io",
  },
  {
    slug: "wechat-miniprogram-2027",
    title: "Wechat Miniprogram 2027",
    prompt:
      "/gen presentation with design system `wechat` and template `guizang-ppt`, create a 微信小程序 2027 生态年度大会主题演讲. 小程序数量、视频号联动、AI 能力开放、商家案例、商业化路径. Make it feel 电子杂志, 中式, 优雅.",
    embedUrl: "https://wechat-miniprogram-2027-715f6d07.sites.vm0.io",
  },
  {
    slug: "wise-treasury-weekly-ops",
    title: "Wise Treasury Weekly Ops",
    prompt:
      "/gen presentation with design system `wise` and template `html-ppt-weekly-report`, create a Wise treasury weekly ops review. FX exposure, corridor volumes, settlement breakage, compliance flags, runway. Make it feel corporate, fintech, structured.",
    embedUrl: "https://wise-treasury-weekly-ops-715f6d07.sites.vm0.io",
  },
  {
    slug: "xhs-2027-spring-summer-trends",
    title: "Xhs 2027 Spring Summer Trends",
    prompt:
      "/gen presentation with design system `xiaohongshu` and template `html-ppt-xhs-post`, create a 小红书 2027 春夏种草趋势报告. 趋势卡片、爆款笔记拆解、博主合作建议、品牌进入策略、案例集. Make it feel 马卡龙, 生活方式, 中文.",
    embedUrl: "https://xhs-2027-spring-summer-trends-715f6d07.sites.vm0.io",
  },
  {
    slug: "xhs-creator-annual-review",
    title: "Xhs Creator Annual Review",
    prompt:
      "/gen presentation with design system `xiaohongshu` and template `html-ppt-xhs-pastel-card`, create a 小红书博主个人成长年报. 内容选题复盘、粉丝画像、合作品牌清单、明年计划、感谢清单. Make it feel 柔和, 慢生活, 治愈.",
    embedUrl: "https://xhs-creator-annual-review-715f6d07.sites.vm0.io",
  },
  {
    slug: "zapier-central-orchestration-arch",
    title: "Zapier Central Orchestration Arch",
    prompt:
      "/gen presentation with design system `zapier` and template `html-ppt-knowledge-arch-blueprint`, create a Zapier Central agent-orchestration reference architecture for ops teams. Trigger graph, agent skills, data store, governance, rollout plan. Make it feel architectural, friendly, automation.",
    embedUrl: "https://zapier-central-orchestration-arch-715f6d07.sites.vm0.io",
  },
  {
    slug: "saas-revops-weekly-metrics",
    title: "Saas Revops Weekly Metrics",
    prompt:
      "/gen presentation with design system `dashboard` and template `html-ppt-weekly-report`, create a SaaS revops weekly metrics review. ARR waterfall, pipeline coverage, win rate by segment, churn cohort, forecast call. Make it feel corporate, data-dense, clear.",
    embedUrl: "https://saas-revops-weekly-metrics-715f6d07.sites.vm0.io",
  },
  {
    slug: "prop-desk-daily-pnl",
    title: "Prop Desk Daily Pnl",
    prompt:
      "/gen presentation with design system `trading-terminal` and template `html-ppt-hermes-cyber-terminal`, create a prop-trading desk daily P&L recap. Greeks dashboard, vol surface, top winners/losers, risk limits, overnight watchlist. Make it feel terminal, dense, technical.",
    embedUrl: "https://prop-desk-daily-pnl-715f6d07.sites.vm0.io",
  },
  {
    slug: "craft-coffee-feature-pitch",
    title: "Craft Coffee Feature Pitch",
    prompt:
      "/gen presentation with design system `warm-editorial` and template `html-ppt-taste-editorial`, create a long-form magazine feature pitch on the future of craft coffee. Story arc, photography moodboard, sources, columnist quotes, publishing schedule. Make it feel warm, editorial, hairline.",
    embedUrl: "https://craft-coffee-feature-pitch-715f6d07.sites.vm0.io",
  },
  {
    slug: "nym-year-in-review",
    title: "NYM Year In Review",
    prompt:
      "/gen presentation with design system `editorial` and template `html-ppt-taste-editorial`, create a New York Magazine year-in-review staff readout. Hero stories, traffic anatomy, subscriber growth, editorial wins, 2027 commissions. Make it feel editorial, considered, refined.",
    embedUrl: "https://nym-year-in-review-715f6d07.sites.vm0.io",
  },
  {
    slug: "indie-author-book-launch",
    title: "Indie Author Book Launch",
    prompt:
      "/gen presentation with design system `mono` and template `html-ppt-zhangzara-monochrome`, create an indie author book launch deck. Synopsis, character map, reader personas, tour cities, press kit. Make it feel monochrome, literary, considered.",
    embedUrl: "https://indie-author-book-launch-715f6d07.sites.vm0.io",
  },
  {
    slug: "agent-system-architecture-readout",
    title: "Agent System Architecture Readout",
    prompt:
      "/gen presentation with design system `agentic` and template `html-ppt-graphify-dark-graph`, create an internal agent-system architecture readout for an enterprise platform team. Agent graph, tool registry, eval harness, observability, rollout plan. Make it feel dark, graph-driven, technical.",
    embedUrl: "https://agent-system-architecture-readout-715f6d07.sites.vm0.io",
  },
  {
    slug: "creative-portfolio-capsule-pitch",
    title: "Creative Portfolio Capsule Pitch",
    prompt:
      "/gen presentation with design system `bento` and template `html-ppt-zhangzara-capsule`, create a personal portfolio pitch for a multi-disciplinary creative. Project capsules, skills grid, client logos, testimonial pulls, contact card. Make it feel capsule, lifestyle, friendly.",
    embedUrl: "https://creative-portfolio-capsule-pitch-715f6d07.sites.vm0.io",
  },
  {
    slug: "protest-poster-history-capstone",
    title: "Protest Poster History Capstone",
    prompt:
      "/gen presentation with design system `brutalism` and template `html-ppt-zhangzara-raw-grid`, create a graphic-design-school capstone presentation on protest poster history. Era timeline, case studies, typography study, field photography, final thesis. Make it feel raw-grid, brutalist, academic.",
    embedUrl: "https://protest-poster-history-capstone-715f6d07.sites.vm0.io",
  },
  {
    slug: "wellness-app-annual-story",
    title: "Wellness App Annual Story",
    prompt:
      "/gen presentation with design system `claymorphism` and template `html-ppt-xhs-pastel-card`, create a wellness-app subscriber annual story. Habit streaks, sleep gains, mindful minutes, community moments, next-year ritual. Make it feel pastel, soft, calming.",
    embedUrl: "https://wellness-app-annual-story-715f6d07.sites.vm0.io",
  },
  {
    slug: "kindergarten-family-yearbook",
    title: "Kindergarten Family Yearbook",
    prompt:
      "/gen presentation with design system `clay` and template `html-ppt-zhangzara-daisy-days`, create a kindergarten family-yearbook reveal for parents. Class moments, art highlights, milestone chart, teacher notes, summer plans. Make it feel cheerful, friendly, family.",
    embedUrl: "https://kindergarten-family-yearbook-715f6d07.sites.vm0.io",
  },
  {
    slug: "indie-pixel-game-press-deck",
    title: "Indie Pixel Game Press Deck",
    prompt:
      "/gen presentation with design system `cosmic` and template `html-ppt-zhangzara-8-bit-orbit`, create an indie video game pre-launch press deck. Story pitch, gameplay loop, art direction, soundtrack samples, release window. Make it feel pixel, neon, gaming.",
    embedUrl: "https://indie-pixel-game-press-deck-715f6d07.sites.vm0.io",
  },
  {
    slug: "indie-zine-release-party",
    title: "Indie Zine Release Party",
    prompt:
      "/gen presentation with design system `dithered` and template `html-ppt-zhangzara-retro-zine`, create an indie zine release-party deck for a local arts collective. Zine spreads, contributor bios, print run, distribution plan, launch night flow. Make it feel zine, tactile, retro.",
    embedUrl: "https://indie-zine-release-party-715f6d07.sites.vm0.io",
  },
  {
    slug: "fashion-house-autumn-lookbook",
    title: "Fashion House Autumn Lookbook",
    prompt:
      "/gen presentation with design system `dramatic` and template `html-ppt-zhangzara-pink-script`, create a fashion house autumn collection lookbook reveal. Mood manifesto, silhouette stories, fabric swatches, runway lineup, retail drop. Make it feel late-night, expressive, editorial.",
    embedUrl: "https://fashion-house-autumn-lookbook-715f6d07.sites.vm0.io",
  },
  {
    slug: "art-biennale-curator-pitch",
    title: "Art Biennale Curator Pitch",
    prompt:
      "/gen presentation with design system `expressive` and template `html-ppt-zhangzara-bold-poster`, create an art biennale curator concept pitch deck. Curatorial statement, artist lineup, venue map, public program, funding ask. Make it feel poster, editorial, bold.",
    embedUrl: "https://art-biennale-curator-pitch-715f6d07.sites.vm0.io",
  },
  {
    slug: "grove-restoration-annual-report",
    title: "Grove Restoration Annual Report",
    prompt:
      "/gen presentation with design system `fantasy` and template `html-ppt-zhangzara-grove`, create a sustainability nonprofit grove-restoration annual report. Hectares restored, species returned, community stories, donor wall, next-year goals. Make it feel forest, hopeful, refined.",
    embedUrl: "https://grove-restoration-annual-report-715f6d07.sites.vm0.io",
  },
  {
    slug: "antique-paper-restoration-catalogue",
    title: "Antique Paper Restoration Catalogue",
    prompt:
      "/gen presentation with design system `kami` and template `kami-deck`, create an antique paper restoration studio exhibit catalogue. Featured works, technique notes, restorer profiles, sponsor wall, event calendar. Make it feel parchment, considered, craft.",
    embedUrl:
      "https://antique-paper-restoration-catalogue-715f6d07.sites.vm0.io",
  },
  {
    slug: "vm0-atelier-zero-v2-unveil",
    title: "Vm0 Atelier Zero V2 Unveil",
    prompt:
      "/gen presentation with design system `atelier-zero` and template `open-design-landing-deck`, create a vm0 design-system v2 internal unveil for the team. New tokens, component refactors, motion language, doc rewrite, rollout plan. Make it feel italic-serif, coral, atelier.",
    embedUrl: "https://vm0-atelier-zero-v2-unveil-715f6d07.sites.vm0.io",
  },
  {
    slug: "community-zine-workshop-facilitator",
    title: "Community Zine Workshop Facilitator",
    prompt:
      "/gen presentation with design system `paper` and template `html-ppt-zhangzara-pin-and-paper`, create a community zine workshop facilitator deck. Workshop arc, supply list, sample spreads, peer feedback flow, takeaway zine. Make it feel handwritten, friendly, paper.",
    embedUrl:
      "https://community-zine-workshop-facilitator-715f6d07.sites.vm0.io",
  },
  {
    slug: "90s-tech-nostalgia-lightning",
    title: "90S Tech Nostalgia Lightning",
    prompt:
      "/gen presentation with design system `retro` and template `html-ppt-zhangzara-retro-windows`, create a 90s tech-nostalgia conference lightning talk. Boot-screen tour, software archaeology, AOL anecdotes, demo screenshots, audience Q&A. Make it feel pixel, retro, playful.",
    embedUrl: "https://90s-tech-nostalgia-lightning-715f6d07.sites.vm0.io",
  },
  {
    slug: "ps6-dev-summit-roadmap",
    title: "PS6 Dev Summit Roadmap",
    prompt:
      "/gen presentation with design system `playstation` and template `html-ppt-zhangzara-8-bit-orbit`, create a PS6 dev-summit roadmap deck for studio partners. Console specs, dev-kit timeline, marquee titles, store policy updates, partner programs. Make it feel arcade, neon, gaming.",
    embedUrl: "https://ps6-dev-summit-roadmap-715f6d07.sites.vm0.io",
  },
];

export function buildPresentationRemixHref(
  item: PresentationItem,
  appUrl: string,
): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
  return url.toString();
}
