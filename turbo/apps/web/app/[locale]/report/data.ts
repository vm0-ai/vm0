export interface ReportItem {
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly embedUrl: string;
  readonly previewImage: string;
  readonly previewWidth: number;
  readonly previewHeight: number;
}

export const REPORT_ITEMS: readonly ReportItem[] = [
  {
    slug: "01-finance-trading-terminal",
    title: "Finance Report / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `finance-report`, Q2 FY26 financial report for a Series B SaaS company: ARR, net revenue retention, gross margin, burn multiple, runway, and forward outlook",
    embedUrl:
      "https://gen-report-01-finance-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/29ae40e0-a673-426e-bc75-7abc270381df/01-finance-trading-terminal.png",
    previewWidth: 1265,
    previewHeight: 2179,
  },
  {
    slug: "02-finance-stripe",
    title: "Finance Report / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `finance-report`, Monthly revenue report for a payments startup: MRR, churn, expansion revenue, and cohort revenue retention",
    embedUrl: "https://gen-report-02-finance-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/431eae09-75c1-405b-b0c6-38373568f720/02-finance-stripe.png",
    previewWidth: 1265,
    previewHeight: 4585,
  },
  {
    slug: "03-finance-corporate",
    title: "Finance Report / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `finance-report`, FY25 annual financial report for a manufacturing company: revenue, COGS, EBITDA, capex, and free cash flow",
    embedUrl: "https://gen-report-03-finance-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/029fd0ab-9c3c-498b-924e-0dd821cd3e8b/03-finance-corporate.png",
    previewWidth: 1265,
    previewHeight: 2811,
  },
  {
    slug: "04-finance-editorial",
    title: "Finance Report / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `finance-report`, Quarterly investor update: P&L summary, cash position, KPI highlights, and a narrative outlook section",
    embedUrl: "https://gen-report-04-finance-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5bec1fec-8195-43a1-9f22-d6315d5d782f/04-finance-editorial.png",
    previewWidth: 1265,
    previewHeight: 4304,
  },
  {
    slug: "05-finance-coinbase",
    title: "Finance Report / Coinbase",
    prompt:
      "/gen report with design system `coinbase` and template `finance-report`, Crypto exchange quarterly report: trading volume, fee revenue, treasury composition, and token holdings",
    embedUrl: "https://gen-report-05-finance-coinbase-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4a3464c9-de29-4baf-b52f-0a6d4f954ef5/05-finance-coinbase.png",
    previewWidth: 1265,
    previewHeight: 4335,
  },
  {
    slug: "06-finance-vercel",
    title: "Finance Report / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `finance-report`, Developer-tools company quarterly financials: usage-based revenue, gross margin, and R&D spend breakdown",
    embedUrl: "https://gen-report-06-finance-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1950f618-c893-4d66-9f3d-e5e1c6625c91/06-finance-vercel.png",
    previewWidth: 1265,
    previewHeight: 4546,
  },
  {
    slug: "07-finance-mono",
    title: "Finance Report / Mono",
    prompt:
      "/gen report with design system `mono` and template `finance-report`, Lean monthly burn report for an early-stage startup: cash in, cash out, runway, and default-alive analysis",
    embedUrl: "https://gen-report-07-finance-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/78b4ded6-3115-4396-8da7-6de9a4445283/07-finance-mono.png",
    previewWidth: 1265,
    previewHeight: 2045,
  },
  {
    slug: "08-finance-ibm",
    title: "Finance Report / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `finance-report`, Enterprise division financial report: segment revenue, operating margin, backlog, and full-year guidance",
    embedUrl: "https://gen-report-08-finance-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/355a7477-4dfe-4809-aaed-d44f4583f83a/08-finance-ibm.png",
    previewWidth: 1265,
    previewHeight: 3057,
  },
  {
    slug: "09-finance-dashboard",
    title: "Finance Report / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `finance-report`, SaaS finance dashboard report: MRR, ARR waterfall, CAC payback, and the magic number",
    embedUrl: "https://gen-report-09-finance-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7f93cd34-a2e5-4262-b7c7-3a609157257a/09-finance-dashboard.png",
    previewWidth: 1265,
    previewHeight: 3021,
  },
  {
    slug: "10-finance-mastercard",
    title: "Finance Report / Mastercard",
    prompt:
      "/gen report with design system `mastercard` and template `finance-report`, Fintech quarterly report: transaction volume, interchange revenue, active cards, and fraud rate",
    embedUrl: "https://gen-report-10-finance-mastercard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1ac5f40f-f6ba-4b17-8eb9-f70653c01590/10-finance-mastercard.png",
    previewWidth: 1265,
    previewHeight: 5790,
  },
  {
    slug: "11-weekly-linear-app",
    title: "Weekly Update / Linear App",
    prompt:
      "/gen report with design system `linear-app` and template `weekly-update`, Engineering team weekly: shipped features, in-flight epics, blockers, sprint velocity, and asks",
    embedUrl: "https://gen-report-11-weekly-linear-app-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fd46bda6-847c-4b1e-99a0-ce83fda7a301/11-weekly-linear-app.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "12-weekly-notion",
    title: "Weekly Update / Notion",
    prompt:
      "/gen report with design system `notion` and template `weekly-update`, Product team weekly update deck: launches, experiments running, key metrics, and decisions needed",
    embedUrl: "https://gen-report-12-weekly-notion-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/dddfc0df-f13b-432f-87c3-61a27b483673/12-weekly-notion.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "13-weekly-slack",
    title: "Weekly Update / Slack",
    prompt:
      "/gen report with design system `slack` and template `weekly-update`, Growth team weekly: campaigns shipped, in-flight tests, blockers, and funnel metrics",
    embedUrl: "https://gen-report-13-weekly-slack-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/93351f0a-ab1e-455e-81d9-11ddff837c8d/13-weekly-slack.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "14-weekly-github",
    title: "Weekly Update / Github",
    prompt:
      "/gen report with design system `github` and template `weekly-update`, Open-source maintainer weekly: PRs merged, issues triaged, releases cut, and community asks",
    embedUrl: "https://gen-report-14-weekly-github-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fecc006e-6c96-4653-8949-67412d4c0b27/14-weekly-github.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "15-weekly-framer",
    title: "Weekly Update / Framer",
    prompt:
      "/gen report with design system `framer` and template `weekly-update`, Design team weekly: shipped designs, in-review explorations, research findings, and asks",
    embedUrl: "https://gen-report-15-weekly-framer-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f496e083-68c5-4116-86b9-66c35fcd0889/15-weekly-framer.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "16-weekly-raycast",
    title: "Weekly Update / Raycast",
    prompt:
      "/gen report with design system `raycast` and template `weekly-update`, Founder weekly update to investors: shipped, metrics, hiring progress, and asks",
    embedUrl: "https://gen-report-16-weekly-raycast-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7b5f2377-58bc-4a02-94fd-f0e22cfd3840/16-weekly-raycast.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "17-weekly-superhuman",
    title: "Weekly Update / Superhuman",
    prompt:
      "/gen report with design system `superhuman` and template `weekly-update`, Sales team weekly: deals closed, pipeline movement, blockers, and quota attainment",
    embedUrl: "https://gen-report-17-weekly-superhuman-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ef6a55f5-d62b-4140-968b-bfcb9465d7a9/17-weekly-superhuman.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "18-weekly-cursor",
    title: "Weekly Update / Cursor",
    prompt:
      "/gen report with design system `cursor` and template `weekly-update`, AI infra team weekly: model evals shipped, training runs in flight, GPU blockers, and metrics",
    embedUrl: "https://gen-report-18-weekly-cursor-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2a2830ad-819d-4cef-a82b-2d1f1bd1e55d/18-weekly-cursor.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "19-weekly-vercel",
    title: "Weekly Update / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `weekly-update`, Platform team weekly: deploys, reliability incidents, in-progress migrations, and SLOs",
    embedUrl: "https://gen-report-19-weekly-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d542af37-5037-4aa9-82b2-6301336b7dbd/19-weekly-vercel.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "20-clinical-clean",
    title: "Clinical Case Report / Clean",
    prompt:
      "/gen report with design system `clean` and template `clinical-case-report`, 54-year-old male with acute chest pain: SOAP note, ECG findings, troponin trend, and STEMI management plan",
    embedUrl: "https://gen-report-20-clinical-clean-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8a770995-66f0-461c-804d-9cdbf31dbcb3/20-clinical-clean.png",
    previewWidth: 1265,
    previewHeight: 7242,
  },
  {
    slug: "21-clinical-publication",
    title: "Clinical Case Report / Publication",
    prompt:
      "/gen report with design system `publication` and template `clinical-case-report`, Pediatric case of Kawasaki disease: presentation, labs, echocardiogram findings, and IVIG response",
    embedUrl:
      "https://gen-report-21-clinical-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cbbea932-89b3-498b-8ec4-30eb09699bdf/21-clinical-publication.png",
    previewWidth: 1265,
    previewHeight: 8143,
  },
  {
    slug: "22-clinical-minimal",
    title: "Clinical Case Report / Minimal",
    prompt:
      "/gen report with design system `minimal` and template `clinical-case-report`, New diagnosis of type 2 diabetes: history, HbA1c, metabolic panel, and treatment plan",
    embedUrl: "https://gen-report-22-clinical-minimal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/da32b612-b19d-4027-9a59-2571fd7594d7/22-clinical-minimal.png",
    previewWidth: 1265,
    previewHeight: 6791,
  },
  {
    slug: "23-clinical-paper",
    title: "Clinical Case Report / Paper",
    prompt:
      "/gen report with design system `paper` and template `clinical-case-report`, Post-operative pulmonary embolism case: vitals, D-dimer, CT-PA findings, and anticoagulation plan",
    embedUrl: "https://gen-report-23-clinical-paper-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/80007da4-e7c0-4fea-86f6-a4a845af8fca/23-clinical-paper.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "24-clinical-refined",
    title: "Clinical Case Report / Refined",
    prompt:
      "/gen report with design system `refined` and template `clinical-case-report`, Rheumatoid arthritis flare: joint exam, inflammatory markers, imaging, and biologic escalation",
    embedUrl: "https://gen-report-24-clinical-refined-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3ab0853e-1e34-4657-9237-32b1de5e0cbe/24-clinical-refined.png",
    previewWidth: 1265,
    previewHeight: 7755,
  },
  {
    slug: "25-clinical-professional",
    title: "Clinical Case Report / Professional",
    prompt:
      "/gen report with design system `professional` and template `clinical-case-report`, Community-acquired pneumonia in an elderly patient: CURB-65 score, labs, CXR, and antibiotic course",
    embedUrl:
      "https://gen-report-25-clinical-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6182d57b-fcbb-4366-a071-b400b6f9aa57/25-clinical-professional.png",
    previewWidth: 1265,
    previewHeight: 5697,
  },
  {
    slug: "26-clinical-material",
    title: "Clinical Case Report / Material",
    prompt:
      "/gen report with design system `material` and template `clinical-case-report`, Migraine with aura differential workup: neuro exam, MRI, and medication strategy",
    embedUrl: "https://gen-report-26-clinical-material-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3fda5a3a-d2c9-4155-bc84-7fd74ed634ec/26-clinical-material.png",
    previewWidth: 1265,
    previewHeight: 6797,
  },
  {
    slug: "27-clinical-editorial",
    title: "Clinical Case Report / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `clinical-case-report`, Narrative case report of a rare autoimmune presentation prepared for grand rounds",
    embedUrl: "https://gen-report-27-clinical-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/420c6013-d270-47e5-8474-c8b236f21d1a/27-clinical-editorial.png",
    previewWidth: 1265,
    previewHeight: 7797,
  },
  {
    slug: "28-critique-artistic",
    title: "Critique / Artistic",
    prompt:
      "/gen report with design system `artistic` and template `critique`, Design critique of a fintech landing page across philosophy, hierarchy, detail, functionality, and innovation",
    embedUrl: "https://gen-report-28-critique-artistic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/27e93b70-9c85-4031-8f19-23233ee4a5dd/28-critique-artistic.png",
    previewWidth: 1265,
    previewHeight: 4857,
  },
  {
    slug: "29-critique-dramatic",
    title: "Critique / Dramatic",
    prompt:
      "/gen report with design system `dramatic` and template `critique`, Expert design review of an AI product dashboard with a radar chart and scored evidence",
    embedUrl: "https://gen-report-29-critique-dramatic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/00d686c1-37fc-4cbd-bf06-b5e511e56854/29-critique-dramatic.png",
    previewWidth: 1265,
    previewHeight: 4162,
  },
  {
    slug: "30-critique-bold",
    title: "Critique / Bold",
    prompt:
      "/gen report with design system `bold` and template `critique`, Critique of a SaaS pricing page: visual hierarchy, clarity, and conversion design",
    embedUrl: "https://gen-report-30-critique-bold-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/05d34439-682c-4bc5-bd6f-89f65f5ca99f/30-critique-bold.png",
    previewWidth: 1265,
    previewHeight: 5500,
  },
  {
    slug: "31-critique-brutalism",
    title: "Critique / Brutalism",
    prompt:
      "/gen report with design system `brutalism` and template `critique`, Design teardown of a portfolio website with 0-10 scoring across five dimensions",
    embedUrl: "https://gen-report-31-critique-brutalism-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/65978a7d-685e-438a-9f45-817eb52b65db/31-critique-brutalism.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "32-critique-expressive",
    title: "Critique / Expressive",
    prompt:
      "/gen report with design system `expressive` and template `critique`, Critique of a mobile onboarding flow's visual and interaction design",
    embedUrl: "https://gen-report-32-critique-expressive-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d3532dbe-fdae-42da-8c6a-31b1d5d5822d/32-critique-expressive.png",
    previewWidth: 1265,
    previewHeight: 3053,
  },
  {
    slug: "33-critique-cosmic",
    title: "Critique / Cosmic",
    prompt:
      "/gen report with design system `cosmic` and template `critique`, Review of a data-visualization-heavy analytics product UI",
    embedUrl: "https://gen-report-33-critique-cosmic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/48a9b431-d159-4ed9-8a79-4f32519ef6dc/33-critique-cosmic.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "34-critique-neobrutalism",
    title: "Critique / Neobrutalism",
    prompt:
      "/gen report with design system `neobrutalism` and template `critique`, Critique of a marketing site redesign with before/after scoring",
    embedUrl:
      "https://gen-report-34-critique-neobrutalism-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2bf5a7d9-e2eb-4d5f-9c19-58dfae6b292d/34-critique-neobrutalism.png",
    previewWidth: 1265,
    previewHeight: 4116,
  },
  {
    slug: "35-critique-dithered",
    title: "Critique / Dithered",
    prompt:
      "/gen report with design system `dithered` and template `critique`, Retro-styled critique of a game studio's web presence",
    embedUrl: "https://gen-report-35-critique-dithered-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/17a055c1-523b-4655-a2ed-2aec83d92c91/35-critique-dithered.png",
    previewWidth: 1265,
    previewHeight: 3337,
  },
  {
    slug: "36-dcf-trading-terminal",
    title: "Dcf Valuation / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `dcf-valuation`, DCF valuation of a high-growth SaaS company with WACC sensitivity and terminal value analysis",
    embedUrl:
      "https://gen-report-36-dcf-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/38b026cb-3351-4311-8b97-9939166e526e/36-dcf-trading-terminal.png",
    previewWidth: 1265,
    previewHeight: 2684,
  },
  {
    slug: "37-dcf-corporate",
    title: "Dcf Valuation / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `dcf-valuation`, DCF intrinsic value analysis of a mature consumer-goods company",
    embedUrl: "https://gen-report-37-dcf-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d12fef55-e1cc-4192-9db1-4a5abcdd5d55/37-dcf-corporate.png",
    previewWidth: 1265,
    previewHeight: 5913,
  },
  {
    slug: "38-dcf-professional",
    title: "Dcf Valuation / Professional",
    prompt:
      "/gen report with design system `professional` and template `dcf-valuation`, DCF model for a semiconductor company: FCF projections, discount rate, and scenario analysis",
    embedUrl: "https://gen-report-38-dcf-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8268e60e-4bb1-4890-ba99-f38c9d9f1a6d/38-dcf-professional.png",
    previewWidth: 1265,
    previewHeight: 5677,
  },
  {
    slug: "39-dcf-mono",
    title: "Dcf Valuation / Mono",
    prompt:
      "/gen report with design system `mono` and template `dcf-valuation`, Lean DCF for an early profitable startup with an explicit assumptions table",
    embedUrl: "https://gen-report-39-dcf-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1a93c8aa-967e-4205-a0d7-1f594a27541c/39-dcf-mono.png",
    previewWidth: 1265,
    previewHeight: 3650,
  },
  {
    slug: "40-dcf-editorial",
    title: "Dcf Valuation / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `dcf-valuation`, Narrative DCF valuation memo for a media company",
    embedUrl: "https://gen-report-40-dcf-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/dea765c1-e5c5-4565-8739-cc9353abd68e/40-dcf-editorial.png",
    previewWidth: 1265,
    previewHeight: 8967,
  },
  {
    slug: "41-dcf-ibm",
    title: "Dcf Valuation / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `dcf-valuation`, Enterprise software DCF: segment FCF, WACC build-up, and a sensitivity grid",
    embedUrl: "https://gen-report-41-dcf-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ee4152b7-0b82-4fce-a16a-ce9e198ecc04/41-dcf-ibm.png",
    previewWidth: 1265,
    previewHeight: 4930,
  },
  {
    slug: "42-dcf-stripe",
    title: "Dcf Valuation / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `dcf-valuation`, Fintech DCF valuation with revenue ramp and margin expansion scenarios",
    embedUrl: "https://gen-report-42-dcf-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/88e8845d-a773-447d-bc6c-cbecaba3fd7f/42-dcf-stripe.png",
    previewWidth: 1265,
    previewHeight: 5229,
  },
  {
    slug: "43-dcf-dashboard",
    title: "Dcf Valuation / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `dcf-valuation`, DCF dashboard report with sensitivity heatmaps",
    embedUrl: "https://gen-report-43-dcf-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/74f54bf8-a726-4d75-8081-f03eff5cdf29/43-dcf-dashboard.png",
    previewWidth: 1265,
    previewHeight: 4343,
  },
  {
    slug: "44-ppt-corporate",
    title: "Html Ppt Weekly Report / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `html-ppt-weekly-report`, Company-wide weekly business review: 8-cell KPI grid, shipped list, and 8-week trend",
    embedUrl: "https://gen-report-44-ppt-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/698ba369-829d-4170-a8c6-e3bee81069c6/44-ppt-corporate.png",
    previewWidth: 1265,
    previewHeight: 3545,
  },
  {
    slug: "45-ppt-enterprise",
    title: "Html Ppt Weekly Report / Enterprise",
    prompt:
      "/gen report with design system `enterprise` and template `html-ppt-weekly-report`, Regional sales weekly status deck with a KPI grid and next-week plan",
    embedUrl: "https://gen-report-45-ppt-enterprise-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5062ce81-b71a-4547-b3d7-383c4bbf98a6/45-ppt-enterprise.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "46-ppt-ant",
    title: "Html Ppt Weekly Report / Ant",
    prompt:
      "/gen report with design system `ant` and template `html-ppt-weekly-report`, Engineering org weekly report: delivery metrics, incidents, and roadmap progress",
    embedUrl: "https://gen-report-46-ppt-ant-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c94f1566-10a6-49a9-823f-16398f1bb820/46-ppt-ant.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "47-ppt-professional",
    title: "Html Ppt Weekly Report / Professional",
    prompt:
      "/gen report with design system `professional` and template `html-ppt-weekly-report`, Marketing weekly status deck: campaign KPIs, pipeline, and content shipped",
    embedUrl: "https://gen-report-47-ppt-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ee31c972-6e2f-4300-9543-668d88800749/47-ppt-professional.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "48-ppt-cisco",
    title: "Html Ppt Weekly Report / Cisco",
    prompt:
      "/gen report with design system `cisco` and template `html-ppt-weekly-report`, IT operations weekly review: uptime, ticket volume, projects, and risks",
    embedUrl: "https://gen-report-48-ppt-cisco-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f71f7f46-4f9d-45a5-bd95-ac1d7066413d/48-ppt-cisco.png",
    previewWidth: 1265,
    previewHeight: 6035,
  },
  {
    slug: "49-ppt-ibm",
    title: "Html Ppt Weekly Report / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `html-ppt-weekly-report`, Consulting engagement weekly status with milestones and budget burn",
    embedUrl: "https://gen-report-49-ppt-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e53f4bef-ec57-4555-9313-a6b7ce709d67/49-ppt-ibm.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "50-ppt-vodafone",
    title: "Html Ppt Weekly Report / Vodafone",
    prompt:
      "/gen report with design system `vodafone` and template `html-ppt-weekly-report`, Telecom product weekly business review with subscriber metrics",
    embedUrl: "https://gen-report-50-ppt-vodafone-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0a7f6b80-5281-4c95-b444-ff0bf5977a77/50-ppt-vodafone.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "51-ppt-webex",
    title: "Html Ppt Weekly Report / Webex",
    prompt:
      "/gen report with design system `webex` and template `html-ppt-weekly-report`, Cross-functional weekly sync deck with per-team status cells",
    embedUrl: "https://gen-report-51-ppt-webex-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/522ba833-dc3a-46a5-b434-e4f4890af31a/51-ppt-webex.png",
    previewWidth: 1280,
    previewHeight: 6023,
  },
  {
    slug: "52-ppt-mastercard",
    title: "Html Ppt Weekly Report / Mastercard",
    prompt:
      "/gen report with design system `mastercard` and template `html-ppt-weekly-report`, Payments product weekly review: volume, approval rate, and roadmap",
    embedUrl: "https://gen-report-52-ppt-mastercard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/884f86aa-682f-45c6-92a9-b53e6414346b/52-ppt-mastercard.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "53-pitch-corporate",
    title: "Ib Pitch Book / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `ib-pitch-book`, Sell-side pitch book for a SaaS company: trading comps, precedent transactions, valuation football field, and DCF sensitivity",
    embedUrl: "https://gen-report-53-pitch-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b4322a0e-6df4-464e-b9b3-5d19e4f303d9/53-pitch-corporate.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "54-pitch-premium",
    title: "Ib Pitch Book / Premium",
    prompt:
      "/gen report with design system `premium` and template `ib-pitch-book`, M&A pitch book for a luxury consumer brand acquisition",
    embedUrl: "https://gen-report-54-pitch-premium-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cbdf2128-7f06-431e-98bf-59780ff61553/54-pitch-premium.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "55-pitch-professional",
    title: "Ib Pitch Book / Professional",
    prompt:
      "/gen report with design system `professional` and template `ib-pitch-book`, Strategic options pitch book for a mid-market manufacturer",
    embedUrl: "https://gen-report-55-pitch-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/89a08ed5-9c6e-4269-bed1-55fc4e7f5fec/55-pitch-professional.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "56-pitch-luxury",
    title: "Ib Pitch Book / Luxury",
    prompt:
      "/gen report with design system `luxury` and template `ib-pitch-book`, Board materials for a private equity take-private analysis",
    embedUrl: "https://gen-report-56-pitch-luxury-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/de60cb62-eb71-46ac-818d-fb0369f2a8b4/56-pitch-luxury.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "57-pitch-editorial",
    title: "Ib Pitch Book / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `ib-pitch-book`, Capital raise pitch book with a narrative thesis and valuation range",
    embedUrl: "https://gen-report-57-pitch-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2cf5296f-14a3-4aa0-8a12-35e798e2e086/57-pitch-editorial.png",
    previewWidth: 1265,
    previewHeight: 9672,
  },
  {
    slug: "58-pitch-ibm",
    title: "Ib Pitch Book / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `ib-pitch-book`, Enterprise tech merger pitch book with synergy analysis",
    embedUrl: "https://gen-report-58-pitch-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/12d4b284-3aee-4ad5-bb0f-1e8e93d11eb3/58-pitch-ibm.png",
    previewWidth: 1265,
    previewHeight: 6540,
  },
  {
    slug: "59-pitch-elegant",
    title: "Ib Pitch Book / Elegant",
    prompt:
      "/gen report with design system `elegant` and template `ib-pitch-book`, IPO readiness pitch book: comps, valuation range, and use of proceeds",
    embedUrl: "https://gen-report-59-pitch-elegant-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/156bf196-1d91-4cff-9fa2-dcbcf4eaa053/59-pitch-elegant.png",
    previewWidth: 1265,
    previewHeight: 7981,
  },
  {
    slug: "60-pitch-mono",
    title: "Ib Pitch Book / Mono",
    prompt:
      "/gen report with design system `mono` and template `ib-pitch-book`, Lean restructuring pitch book with a strategic-options matrix",
    embedUrl: "https://gen-report-60-pitch-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4e958d5a-5544-4585-b780-e06e3253ea17/60-pitch-mono.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "61-invoice-stripe",
    title: "Invoice / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `invoice`, SaaS subscription invoice with line items, proration, tax, and a payment link",
    embedUrl: "https://gen-report-61-invoice-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/910c4e01-dee2-4db6-ba6e-a7843459b51a/61-invoice-stripe.png",
    previewWidth: 1265,
    previewHeight: 2104,
  },
  {
    slug: "62-invoice-clean",
    title: "Invoice / Clean",
    prompt:
      "/gen report with design system `clean` and template `invoice`, Freelance design services invoice with hourly line items and totals",
    embedUrl: "https://gen-report-62-invoice-clean-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7e8d0b88-1539-4a3b-a5b8-697b38c933a8/62-invoice-clean.png",
    previewWidth: 1265,
    previewHeight: 2234,
  },
  {
    slug: "63-invoice-minimal",
    title: "Invoice / Minimal",
    prompt:
      "/gen report with design system `minimal` and template `invoice`, Consulting retainer invoice with a milestone breakdown",
    embedUrl: "https://gen-report-63-invoice-minimal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9a02805d-71d6-46d2-a0b4-a5289c99115d/63-invoice-minimal.png",
    previewWidth: 1265,
    previewHeight: 2610,
  },
  {
    slug: "64-invoice-wise",
    title: "Invoice / Wise",
    prompt:
      "/gen report with design system `wise` and template `invoice`, Cross-border contractor invoice with multi-currency amounts and bank details",
    embedUrl: "https://gen-report-64-invoice-wise-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/60f3e16b-7977-4cbc-8bc9-fcd7da3c18ae/64-invoice-wise.png",
    previewWidth: 1265,
    previewHeight: 2469,
  },
  {
    slug: "65-invoice-paper",
    title: "Invoice / Paper",
    prompt:
      "/gen report with design system `paper` and template `invoice`, Print-ready agency invoice with itemized deliverables and VAT",
    embedUrl: "https://gen-report-65-invoice-paper-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a0f838d3-1e64-44db-8bda-40c2961b4bf7/65-invoice-paper.png",
    previewWidth: 1265,
    previewHeight: 2222,
  },
  {
    slug: "66-invoice-professional",
    title: "Invoice / Professional",
    prompt:
      "/gen report with design system `professional` and template `invoice`, Enterprise software license invoice with a PO reference and net-30 terms",
    embedUrl:
      "https://gen-report-66-invoice-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3a2c71e4-89bb-4712-923f-ba83470347c8/66-invoice-professional.png",
    previewWidth: 1265,
    previewHeight: 2159,
  },
  {
    slug: "67-invoice-refined",
    title: "Invoice / Refined",
    prompt:
      "/gen report with design system `refined` and template `invoice`, Photography studio invoice with package line items",
    embedUrl: "https://gen-report-67-invoice-refined-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7fb469b5-f7ff-462a-94fb-79221f2ab675/67-invoice-refined.png",
    previewWidth: 1265,
    previewHeight: 2188,
  },
  {
    slug: "68-invoice-simple",
    title: "Invoice / Simple",
    prompt:
      "/gen report with design system `simple` and template `invoice`, Small-business product invoice with quantity, unit price, and sales tax",
    embedUrl: "https://gen-report-68-invoice-simple-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/03885cd6-06d7-4563-9f3f-f9da02c3efe2/68-invoice-simple.png",
    previewWidth: 1265,
    previewHeight: 2102,
  },
  {
    slug: "69-last30-theverge",
    title: "Last30days / Theverge",
    prompt:
      "/gen report with design system `theverge` and template `last30days`, Last 30 days in AI agents: top launches, debates, and community trends",
    embedUrl: "https://gen-report-69-last30-theverge-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d231d6f7-06ce-4b7f-80d1-7ee902c25f48/69-last30-theverge.png",
    previewWidth: 1265,
    previewHeight: 7451,
  },
  {
    slug: "70-last30-wired",
    title: "Last30days / Wired",
    prompt:
      "/gen report with design system `wired` and template `last30days`, 30-day trend report on the humanoid robotics space",
    embedUrl: "https://gen-report-70-last30-wired-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/199d3901-75c2-4756-a0ac-67ec50c4e2d0/70-last30-wired.png",
    previewWidth: 1265,
    previewHeight: 6987,
  },
  {
    slug: "71-last30-perplexity",
    title: "Last30days / Perplexity",
    prompt:
      "/gen report with design system `perplexity` and template `last30days`, Recent 30-day developments in open-source LLMs",
    embedUrl: "https://gen-report-71-last30-perplexity-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6a695b44-daf6-4829-b436-6999f3a8a5be/71-last30-perplexity.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "72-last30-publication",
    title: "Last30days / Publication",
    prompt:
      "/gen report with design system `publication` and template `last30days`, Last 30 days in crypto and DeFi: narratives, launches, and sentiment",
    embedUrl: "https://gen-report-72-last30-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/50a56337-90f4-433b-bdb9-a50fab9fbb3f/72-last30-publication.png",
    previewWidth: 1265,
    previewHeight: 6361,
  },
  {
    slug: "73-last30-editorial",
    title: "Last30days / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `last30days`, 30-day roundup of developer-tooling community discourse",
    embedUrl: "https://gen-report-73-last30-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9ea13dbd-f3f0-4e53-9098-a216eb26e043/73-last30-editorial.png",
    previewWidth: 1265,
    previewHeight: 6268,
  },
  {
    slug: "74-last30-posthog",
    title: "Last30days / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `last30days`, Recent product-analytics and growth community trends over the last 30 days",
    embedUrl: "https://gen-report-74-last30-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e2887928-2aa3-4148-9b7c-27dbb48b89e9/74-last30-posthog.png",
    previewWidth: 1265,
    previewHeight: 5592,
  },
  {
    slug: "75-last30-mono",
    title: "Last30days / Mono",
    prompt:
      "/gen report with design system `mono` and template `last30days`, Last 30 days in the AI coding-agent ecosystem",
    embedUrl: "https://gen-report-75-last30-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a588087a-f6f6-4926-a0df-3add3d96ae84/75-last30-mono.png",
    previewWidth: 1265,
    previewHeight: 5153,
  },
  {
    slug: "76-last30-x-ai",
    title: "Last30days / X Ai",
    prompt:
      "/gen report with design system `x-ai` and template `last30days`, 30-day trend report on AI safety and alignment discourse",
    embedUrl: "https://gen-report-76-last30-x-ai-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1c8c35c2-e8f3-4fe4-9334-bb2074c42a81/76-last30-x-ai.png",
    previewWidth: 1265,
    previewHeight: 7653,
  },
  {
    slug: "77-live-dashboard",
    title: "Live Artifact / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `live-artifact`, Live revenue dashboard backed by Stripe data: MRR, churn, and new customers, refreshable",
    embedUrl: "https://gen-report-77-live-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/97498883-07ce-4dab-8f9a-39146067bfef/77-live-dashboard.png",
    previewWidth: 1265,
    previewHeight: 2027,
  },
  {
    slug: "78-live-mission-control",
    title: "Live Artifact / Mission Control",
    prompt:
      "/gen report with design system `mission-control` and template `live-artifact`, Live ops dashboard for service health, incidents, and SLOs",
    embedUrl:
      "https://gen-report-78-live-mission-control-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e48aa873-a0fc-44d9-866d-e5ab6e303904/78-live-mission-control.png",
    previewWidth: 1265,
    previewHeight: 2056,
  },
  {
    slug: "79-live-hud",
    title: "Live Artifact / Hud",
    prompt:
      "/gen report with design system `hud` and template `live-artifact`, Live KPI HUD for a startup: signups, activation, and revenue with auto-refresh",
    embedUrl: "https://gen-report-79-live-hud-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f7eddce3-525d-4112-860f-052fce58efb0/79-live-hud.png",
    previewWidth: 1265,
    previewHeight: 927,
  },
  {
    slug: "80-live-trading-terminal",
    title: "Live Artifact / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `live-artifact`, Live portfolio tracker with positions, P&L, and market data",
    embedUrl:
      "https://gen-report-80-live-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4d308052-4ce0-440b-8afb-cd3fa854b5b6/80-live-trading-terminal.png",
    previewWidth: 1265,
    previewHeight: 1024,
  },
  {
    slug: "81-live-clickhouse",
    title: "Live Artifact / Clickhouse",
    prompt:
      "/gen report with design system `clickhouse` and template `live-artifact`, Live analytics report over an event stream with refreshable queries",
    embedUrl: "https://gen-report-81-live-clickhouse-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0ca11e10-4602-458f-8b49-65e7f86fc855/81-live-clickhouse.png",
    previewWidth: 1265,
    previewHeight: 3275,
  },
  {
    slug: "82-live-sentry",
    title: "Live Artifact / Sentry",
    prompt:
      "/gen report with design system `sentry` and template `live-artifact`, Live error-monitoring artifact: error rate, top issues, and release health",
    embedUrl: "https://gen-report-82-live-sentry-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/91197c6a-b71d-47e5-a1eb-c608b3de796b/82-live-sentry.png",
    previewWidth: 1265,
    previewHeight: 2136,
  },
  {
    slug: "83-live-posthog",
    title: "Live Artifact / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `live-artifact`, Live product-funnel artifact backed by analytics data",
    embedUrl: "https://gen-report-83-live-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/74c5a224-ad19-495b-87bb-789491766187/83-live-posthog.png",
    previewWidth: 1265,
    previewHeight: 2259,
  },
  {
    slug: "84-live-mono",
    title: "Live Artifact / Mono",
    prompt:
      "/gen report with design system `mono` and template `live-artifact`, Minimal live metrics artifact with auto-refreshing counters",
    embedUrl: "https://gen-report-84-live-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5004e000-afe7-4212-bb47-8fba409e8adb/84-live-mono.png",
    previewWidth: 1265,
    previewHeight: 879,
  },
  {
    slug: "85-tweaks-framer",
    title: "Tweaks / Framer",
    prompt:
      "/gen report with design system `framer` and template `tweaks`, Landing page wrapped with a live control panel for accent color, type scale, density, and motion",
    embedUrl: "https://gen-report-85-tweaks-framer-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4926138c-f466-44c1-ba2b-00da699e8cbc/85-tweaks-framer.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "86-tweaks-shadcn",
    title: "Tweaks / Shadcn",
    prompt:
      "/gen report with design system `shadcn` and template `tweaks`, Component showcase with live theme, density, and radius controls",
    embedUrl: "https://gen-report-86-tweaks-shadcn-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/74b9a13d-613a-4438-a576-7e8ddfa9805c/86-tweaks-shadcn.png",
    previewWidth: 1265,
    previewHeight: 3059,
  },
  {
    slug: "87-tweaks-linear-app",
    title: "Tweaks / Linear App",
    prompt:
      "/gen report with design system `linear-app` and template `tweaks`, Dashboard with live parameterized controls for theme and motion",
    embedUrl: "https://gen-report-87-tweaks-linear-app-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d947c5a9-ad4f-4c63-8782-85240e1db5c3/87-tweaks-linear-app.png",
    previewWidth: 1265,
    previewHeight: 1310,
  },
  {
    slug: "88-tweaks-raycast",
    title: "Tweaks / Raycast",
    prompt:
      "/gen report with design system `raycast` and template `tweaks`, Settings-style artifact with a live customization panel",
    embedUrl: "https://gen-report-88-tweaks-raycast-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a826bc03-ddf2-42c6-9b31-15fa9988dba7/88-tweaks-raycast.png",
    previewWidth: 1265,
    previewHeight: 2439,
  },
  {
    slug: "89-tweaks-vercel",
    title: "Tweaks / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `tweaks`, Marketing page with real-time CSS variable tweaks and localStorage persistence",
    embedUrl: "https://gen-report-89-tweaks-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/13e184ed-8638-4478-96a0-25a789c75062/89-tweaks-vercel.png",
    previewWidth: 1265,
    previewHeight: 3695,
  },
  {
    slug: "90-tweaks-figma",
    title: "Tweaks / Figma",
    prompt:
      "/gen report with design system `figma` and template `tweaks`, Design-token playground with live accent and scale controls",
    embedUrl: "https://gen-report-90-tweaks-figma-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1b5f0005-e8f5-47e4-9d1c-cb69cb41f965/90-tweaks-figma.png",
    previewWidth: 1265,
    previewHeight: 2410,
  },
  {
    slug: "91-tweaks-arc",
    title: "Tweaks / Arc",
    prompt:
      "/gen report with design system `arc` and template `tweaks`, Browser-style page with translucency and warmth controls",
    embedUrl: "https://gen-report-91-tweaks-arc-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a5159e54-5ccc-4ceb-90e7-f86b358608b5/91-tweaks-arc.png",
    previewWidth: 1265,
    previewHeight: 1125,
  },
  {
    slug: "92-tweaks-sleek",
    title: "Tweaks / Sleek",
    prompt:
      "/gen report with design system `sleek` and template `tweaks`, Minimal page with a live density and theme switcher",
    embedUrl: "https://gen-report-92-tweaks-sleek-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/86dc1968-0493-4bf8-b93e-496b4265fcde/92-tweaks-sleek.png",
    previewWidth: 1265,
    previewHeight: 2418,
  },
  {
    slug: "93-xresearch-x-ai",
    title: "X Research / X Ai",
    prompt:
      "/gen report with design system `x-ai` and template `x-research`, X sentiment research on a major AI model launch: themes, top posts, and sentiment breakdown",
    embedUrl: "https://gen-report-93-xresearch-x-ai-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4c9da45d-f565-4a47-bbdf-c9bf718e33ca/93-xresearch-x-ai.png",
    previewWidth: 1265,
    previewHeight: 7950,
  },
  {
    slug: "94-xresearch-mono",
    title: "X Research / Mono",
    prompt:
      "/gen report with design system `mono` and template `x-research`, X public discourse research on a developer-tools product",
    embedUrl: "https://gen-report-94-xresearch-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/58adc72f-e8ee-4964-915c-83adbf9d7529/94-xresearch-mono.png",
    previewWidth: 1265,
    previewHeight: 5171,
  },
  {
    slug: "95-xresearch-theverge",
    title: "X Research / Theverge",
    prompt:
      "/gen report with design system `theverge` and template `x-research`, X sentiment on a consumer hardware launch with an engagement breakdown",
    embedUrl: "https://gen-report-95-xresearch-theverge-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/92ea719d-ae54-4eef-b53a-7077d57d1e0e/95-xresearch-theverge.png",
    previewWidth: 1280,
    previewHeight: 800,
  },
  {
    slug: "96-xresearch-perplexity",
    title: "X Research / Perplexity",
    prompt:
      "/gen report with design system `perplexity` and template `x-research`, X research on market reaction to an earnings report",
    embedUrl:
      "https://gen-report-96-xresearch-perplexity-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e17002b2-b9a7-441f-a174-105ec19c3d4e/96-xresearch-perplexity.png",
    previewWidth: 1265,
    previewHeight: 5028,
  },
  {
    slug: "97-xresearch-wired",
    title: "X Research / Wired",
    prompt:
      "/gen report with design system `wired` and template `x-research`, X discourse analysis of a tech-policy debate",
    embedUrl: "https://gen-report-97-xresearch-wired-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9a3ce371-edf5-46dd-abb1-e91b7fd613f3/97-xresearch-wired.png",
    previewWidth: 1265,
    previewHeight: 6821,
  },
  {
    slug: "98-xresearch-posthog",
    title: "X Research / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `x-research`, X sentiment research on a SaaS pricing change",
    embedUrl: "https://gen-report-98-xresearch-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1a06d87-0098-4022-99c7-548e54c7f772/98-xresearch-posthog.png",
    previewWidth: 1265,
    previewHeight: 5298,
  },
  {
    slug: "99-xresearch-publication",
    title: "X Research / Publication",
    prompt:
      "/gen report with design system `publication` and template `x-research`, X community research on an open-source project controversy",
    embedUrl:
      "https://gen-report-99-xresearch-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ed95143d-d2dd-4073-8801-92aed14ad424/99-xresearch-publication.png",
    previewWidth: 1265,
    previewHeight: 7375,
  },
  {
    slug: "100-xresearch-editorial",
    title: "X Research / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `x-research`, X sentiment roundup for a product rebrand",
    embedUrl:
      "https://gen-report-100-xresearch-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/039c4db4-1b5a-4e15-ac95-df5e17c30f87/100-xresearch-editorial.png",
    previewWidth: 1265,
    previewHeight: 8697,
  },
];

export function buildReportRemixHref(item: ReportItem, appUrl: string): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
  return url.toString();
}
