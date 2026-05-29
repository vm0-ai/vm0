export interface ReportItem {
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly embedUrl: string;
  readonly previewImage: string;
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a7904f22-5113-4fd3-a936-d36b7472b0b6/01-finance-trading-terminal.png",
  },
  {
    slug: "02-finance-stripe",
    title: "Finance Report / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `finance-report`, Monthly revenue report for a payments startup: MRR, churn, expansion revenue, and cohort revenue retention",
    embedUrl: "https://gen-report-02-finance-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bf670c7d-5b4f-4c35-a324-37b75b2b7b9e/02-finance-stripe.png",
  },
  {
    slug: "03-finance-corporate",
    title: "Finance Report / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `finance-report`, FY25 annual financial report for a manufacturing company: revenue, COGS, EBITDA, capex, and free cash flow",
    embedUrl: "https://gen-report-03-finance-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/aa720a2a-ce21-483e-8ce4-a8a5624f3a5d/03-finance-corporate.png",
  },
  {
    slug: "04-finance-editorial",
    title: "Finance Report / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `finance-report`, Quarterly investor update: P&L summary, cash position, KPI highlights, and a narrative outlook section",
    embedUrl: "https://gen-report-04-finance-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e345e8dc-6150-4b37-8adc-ea415b6f8c41/04-finance-editorial.png",
  },
  {
    slug: "05-finance-coinbase",
    title: "Finance Report / Coinbase",
    prompt:
      "/gen report with design system `coinbase` and template `finance-report`, Crypto exchange quarterly report: trading volume, fee revenue, treasury composition, and token holdings",
    embedUrl: "https://gen-report-05-finance-coinbase-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cad8efae-25ed-42fa-9057-af6646e34215/05-finance-coinbase.png",
  },
  {
    slug: "06-finance-vercel",
    title: "Finance Report / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `finance-report`, Developer-tools company quarterly financials: usage-based revenue, gross margin, and R&D spend breakdown",
    embedUrl: "https://gen-report-06-finance-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7fd2e7a1-3bb1-41d2-85a5-32eae6f5aa50/06-finance-vercel.png",
  },
  {
    slug: "07-finance-mono",
    title: "Finance Report / Mono",
    prompt:
      "/gen report with design system `mono` and template `finance-report`, Lean monthly burn report for an early-stage startup: cash in, cash out, runway, and default-alive analysis",
    embedUrl: "https://gen-report-07-finance-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4f689875-bf12-4dd0-bc53-1651e3601c3e/07-finance-mono.png",
  },
  {
    slug: "08-finance-ibm",
    title: "Finance Report / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `finance-report`, Enterprise division financial report: segment revenue, operating margin, backlog, and full-year guidance",
    embedUrl: "https://gen-report-08-finance-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b43ec9e0-9c25-4c0c-9eba-0974e8091e57/08-finance-ibm.png",
  },
  {
    slug: "09-finance-dashboard",
    title: "Finance Report / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `finance-report`, SaaS finance dashboard report: MRR, ARR waterfall, CAC payback, and the magic number",
    embedUrl: "https://gen-report-09-finance-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bda40116-d401-427c-8835-2f0e21f8b979/09-finance-dashboard.png",
  },
  {
    slug: "10-finance-mastercard",
    title: "Finance Report / Mastercard",
    prompt:
      "/gen report with design system `mastercard` and template `finance-report`, Fintech quarterly report: transaction volume, interchange revenue, active cards, and fraud rate",
    embedUrl: "https://gen-report-10-finance-mastercard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a38f8168-223a-4e53-ad60-69ba268f33fe/10-finance-mastercard.png",
  },
  {
    slug: "11-weekly-linear-app",
    title: "Weekly Update / Linear App",
    prompt:
      "/gen report with design system `linear-app` and template `weekly-update`, Engineering team weekly: shipped features, in-flight epics, blockers, sprint velocity, and asks",
    embedUrl: "https://gen-report-11-weekly-linear-app-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4d473e47-8f4e-4505-b06f-3ddb061bf29a/11-weekly-linear-app.png",
  },
  {
    slug: "12-weekly-notion",
    title: "Weekly Update / Notion",
    prompt:
      "/gen report with design system `notion` and template `weekly-update`, Product team weekly update deck: launches, experiments running, key metrics, and decisions needed",
    embedUrl: "https://gen-report-12-weekly-notion-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/27fbd56f-c22f-4547-a795-83a7e4df3b7c/12-weekly-notion.png",
  },
  {
    slug: "13-weekly-slack",
    title: "Weekly Update / Slack",
    prompt:
      "/gen report with design system `slack` and template `weekly-update`, Growth team weekly: campaigns shipped, in-flight tests, blockers, and funnel metrics",
    embedUrl: "https://gen-report-13-weekly-slack-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/62bbfe85-8276-488d-a102-7a286ff11348/13-weekly-slack.png",
  },
  {
    slug: "14-weekly-github",
    title: "Weekly Update / Github",
    prompt:
      "/gen report with design system `github` and template `weekly-update`, Open-source maintainer weekly: PRs merged, issues triaged, releases cut, and community asks",
    embedUrl: "https://gen-report-14-weekly-github-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ce707840-00ce-43be-8d7a-9b1c3e14df43/14-weekly-github.png",
  },
  {
    slug: "15-weekly-framer",
    title: "Weekly Update / Framer",
    prompt:
      "/gen report with design system `framer` and template `weekly-update`, Design team weekly: shipped designs, in-review explorations, research findings, and asks",
    embedUrl: "https://gen-report-15-weekly-framer-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f4361885-50ad-4a60-90f4-5ddd8de06279/15-weekly-framer.png",
  },
  {
    slug: "16-weekly-raycast",
    title: "Weekly Update / Raycast",
    prompt:
      "/gen report with design system `raycast` and template `weekly-update`, Founder weekly update to investors: shipped, metrics, hiring progress, and asks",
    embedUrl: "https://gen-report-16-weekly-raycast-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b1adec10-7ff5-4fa0-899c-6f5a039a0fec/16-weekly-raycast.png",
  },
  {
    slug: "17-weekly-superhuman",
    title: "Weekly Update / Superhuman",
    prompt:
      "/gen report with design system `superhuman` and template `weekly-update`, Sales team weekly: deals closed, pipeline movement, blockers, and quota attainment",
    embedUrl: "https://gen-report-17-weekly-superhuman-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1ca9a3cb-2c06-42a4-bb56-692e74374767/17-weekly-superhuman.png",
  },
  {
    slug: "18-weekly-cursor",
    title: "Weekly Update / Cursor",
    prompt:
      "/gen report with design system `cursor` and template `weekly-update`, AI infra team weekly: model evals shipped, training runs in flight, GPU blockers, and metrics",
    embedUrl: "https://gen-report-18-weekly-cursor-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ac51fa14-050f-4c32-b671-f436aa250735/18-weekly-cursor.png",
  },
  {
    slug: "19-weekly-vercel",
    title: "Weekly Update / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `weekly-update`, Platform team weekly: deploys, reliability incidents, in-progress migrations, and SLOs",
    embedUrl: "https://gen-report-19-weekly-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a3ef533e-faa6-41ee-9988-be17ddbe679f/19-weekly-vercel.png",
  },
  {
    slug: "20-clinical-clean",
    title: "Clinical Case Report / Clean",
    prompt:
      "/gen report with design system `clean` and template `clinical-case-report`, 54-year-old male with acute chest pain: SOAP note, ECG findings, troponin trend, and STEMI management plan",
    embedUrl: "https://gen-report-20-clinical-clean-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e258f971-1d78-4fca-9e27-07223a43a514/20-clinical-clean.png",
  },
  {
    slug: "21-clinical-publication",
    title: "Clinical Case Report / Publication",
    prompt:
      "/gen report with design system `publication` and template `clinical-case-report`, Pediatric case of Kawasaki disease: presentation, labs, echocardiogram findings, and IVIG response",
    embedUrl:
      "https://gen-report-21-clinical-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/441d081a-d812-4e46-9f65-5d2f646f428a/21-clinical-publication.png",
  },
  {
    slug: "22-clinical-minimal",
    title: "Clinical Case Report / Minimal",
    prompt:
      "/gen report with design system `minimal` and template `clinical-case-report`, New diagnosis of type 2 diabetes: history, HbA1c, metabolic panel, and treatment plan",
    embedUrl: "https://gen-report-22-clinical-minimal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/22363664-c158-4bbd-bb13-dd61643b1fdb/22-clinical-minimal.png",
  },
  {
    slug: "23-clinical-paper",
    title: "Clinical Case Report / Paper",
    prompt:
      "/gen report with design system `paper` and template `clinical-case-report`, Post-operative pulmonary embolism case: vitals, D-dimer, CT-PA findings, and anticoagulation plan",
    embedUrl: "https://gen-report-23-clinical-paper-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ef12e052-c0dd-4df1-bde1-9a1d48dabb45/23-clinical-paper.png",
  },
  {
    slug: "24-clinical-refined",
    title: "Clinical Case Report / Refined",
    prompt:
      "/gen report with design system `refined` and template `clinical-case-report`, Rheumatoid arthritis flare: joint exam, inflammatory markers, imaging, and biologic escalation",
    embedUrl: "https://gen-report-24-clinical-refined-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cc565554-db58-47c4-8eee-66b987f96e38/24-clinical-refined.png",
  },
  {
    slug: "25-clinical-professional",
    title: "Clinical Case Report / Professional",
    prompt:
      "/gen report with design system `professional` and template `clinical-case-report`, Community-acquired pneumonia in an elderly patient: CURB-65 score, labs, CXR, and antibiotic course",
    embedUrl:
      "https://gen-report-25-clinical-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/691d106d-c011-4eaf-95b5-4d172c7eb908/25-clinical-professional.png",
  },
  {
    slug: "26-clinical-material",
    title: "Clinical Case Report / Material",
    prompt:
      "/gen report with design system `material` and template `clinical-case-report`, Migraine with aura differential workup: neuro exam, MRI, and medication strategy",
    embedUrl: "https://gen-report-26-clinical-material-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f9e21035-5656-4f24-a3e6-987c8374fd72/26-clinical-material.png",
  },
  {
    slug: "27-clinical-editorial",
    title: "Clinical Case Report / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `clinical-case-report`, Narrative case report of a rare autoimmune presentation prepared for grand rounds",
    embedUrl: "https://gen-report-27-clinical-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ebd40214-c6d8-41c4-830d-20c9a1f91a4f/27-clinical-editorial.png",
  },
  {
    slug: "28-critique-artistic",
    title: "Critique / Artistic",
    prompt:
      "/gen report with design system `artistic` and template `critique`, Design critique of a fintech landing page across philosophy, hierarchy, detail, functionality, and innovation",
    embedUrl: "https://gen-report-28-critique-artistic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1eddcd44-1a49-42f1-b4e8-849387948530/28-critique-artistic.png",
  },
  {
    slug: "29-critique-dramatic",
    title: "Critique / Dramatic",
    prompt:
      "/gen report with design system `dramatic` and template `critique`, Expert design review of an AI product dashboard with a radar chart and scored evidence",
    embedUrl: "https://gen-report-29-critique-dramatic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/75534084-7633-413b-a544-fd00253201e0/29-critique-dramatic.png",
  },
  {
    slug: "30-critique-bold",
    title: "Critique / Bold",
    prompt:
      "/gen report with design system `bold` and template `critique`, Critique of a SaaS pricing page: visual hierarchy, clarity, and conversion design",
    embedUrl: "https://gen-report-30-critique-bold-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8e52a41c-7d94-494f-bd8a-9059bf319d2c/30-critique-bold.png",
  },
  {
    slug: "31-critique-brutalism",
    title: "Critique / Brutalism",
    prompt:
      "/gen report with design system `brutalism` and template `critique`, Design teardown of a portfolio website with 0-10 scoring across five dimensions",
    embedUrl: "https://gen-report-31-critique-brutalism-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fc85a694-71a7-4a20-bd6c-1b8dd0843835/31-critique-brutalism.png",
  },
  {
    slug: "32-critique-expressive",
    title: "Critique / Expressive",
    prompt:
      "/gen report with design system `expressive` and template `critique`, Critique of a mobile onboarding flow's visual and interaction design",
    embedUrl: "https://gen-report-32-critique-expressive-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/dfa5a0b2-6365-4d97-85ec-f1b19ee97bb0/32-critique-expressive.png",
  },
  {
    slug: "33-critique-cosmic",
    title: "Critique / Cosmic",
    prompt:
      "/gen report with design system `cosmic` and template `critique`, Review of a data-visualization-heavy analytics product UI",
    embedUrl: "https://gen-report-33-critique-cosmic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f060c5de-62b7-4426-b7c1-f77fc5264c24/33-critique-cosmic.png",
  },
  {
    slug: "34-critique-neobrutalism",
    title: "Critique / Neobrutalism",
    prompt:
      "/gen report with design system `neobrutalism` and template `critique`, Critique of a marketing site redesign with before/after scoring",
    embedUrl:
      "https://gen-report-34-critique-neobrutalism-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a073852d-3946-48dc-9cee-ddac54e6d9a4/34-critique-neobrutalism.png",
  },
  {
    slug: "35-critique-dithered",
    title: "Critique / Dithered",
    prompt:
      "/gen report with design system `dithered` and template `critique`, Retro-styled critique of a game studio's web presence",
    embedUrl: "https://gen-report-35-critique-dithered-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ee8259fe-7caf-4746-b977-ce85a4a58e7c/35-critique-dithered.png",
  },
  {
    slug: "36-dcf-trading-terminal",
    title: "Dcf Valuation / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `dcf-valuation`, DCF valuation of a high-growth SaaS company with WACC sensitivity and terminal value analysis",
    embedUrl:
      "https://gen-report-36-dcf-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c6cf037b-686e-4463-9261-86a05533cd72/36-dcf-trading-terminal.png",
  },
  {
    slug: "37-dcf-corporate",
    title: "Dcf Valuation / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `dcf-valuation`, DCF intrinsic value analysis of a mature consumer-goods company",
    embedUrl: "https://gen-report-37-dcf-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/47cab9d0-dd76-4a25-a605-2cfb6106bf0d/37-dcf-corporate.png",
  },
  {
    slug: "38-dcf-professional",
    title: "Dcf Valuation / Professional",
    prompt:
      "/gen report with design system `professional` and template `dcf-valuation`, DCF model for a semiconductor company: FCF projections, discount rate, and scenario analysis",
    embedUrl: "https://gen-report-38-dcf-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/46b0548b-7e7d-4934-b3ad-cd350873e619/38-dcf-professional.png",
  },
  {
    slug: "39-dcf-mono",
    title: "Dcf Valuation / Mono",
    prompt:
      "/gen report with design system `mono` and template `dcf-valuation`, Lean DCF for an early profitable startup with an explicit assumptions table",
    embedUrl: "https://gen-report-39-dcf-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/354b5050-0e9d-4727-91b1-8d55cbd6be9c/39-dcf-mono.png",
  },
  {
    slug: "40-dcf-editorial",
    title: "Dcf Valuation / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `dcf-valuation`, Narrative DCF valuation memo for a media company",
    embedUrl: "https://gen-report-40-dcf-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6b5b7f8c-b561-46f9-b67b-447c0b6620cc/40-dcf-editorial.png",
  },
  {
    slug: "41-dcf-ibm",
    title: "Dcf Valuation / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `dcf-valuation`, Enterprise software DCF: segment FCF, WACC build-up, and a sensitivity grid",
    embedUrl: "https://gen-report-41-dcf-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cebf980f-463a-418e-96ea-7956d16e568b/41-dcf-ibm.png",
  },
  {
    slug: "42-dcf-stripe",
    title: "Dcf Valuation / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `dcf-valuation`, Fintech DCF valuation with revenue ramp and margin expansion scenarios",
    embedUrl: "https://gen-report-42-dcf-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f1d94999-beb8-4678-ad26-61e8244b0928/42-dcf-stripe.png",
  },
  {
    slug: "43-dcf-dashboard",
    title: "Dcf Valuation / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `dcf-valuation`, DCF dashboard report with sensitivity heatmaps",
    embedUrl: "https://gen-report-43-dcf-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/205c4077-7d16-4dee-9209-a2086b4bfd3e/43-dcf-dashboard.png",
  },
  {
    slug: "44-ppt-corporate",
    title: "Html Ppt Weekly Report / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `html-ppt-weekly-report`, Company-wide weekly business review: 8-cell KPI grid, shipped list, and 8-week trend",
    embedUrl: "https://gen-report-44-ppt-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/19d18a7b-3bee-44be-8cb1-a4166b113997/44-ppt-corporate.png",
  },
  {
    slug: "45-ppt-enterprise",
    title: "Html Ppt Weekly Report / Enterprise",
    prompt:
      "/gen report with design system `enterprise` and template `html-ppt-weekly-report`, Regional sales weekly status deck with a KPI grid and next-week plan",
    embedUrl: "https://gen-report-45-ppt-enterprise-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/34805cb6-b246-4ff0-a814-a5d81c84a4b3/45-ppt-enterprise.png",
  },
  {
    slug: "46-ppt-ant",
    title: "Html Ppt Weekly Report / Ant",
    prompt:
      "/gen report with design system `ant` and template `html-ppt-weekly-report`, Engineering org weekly report: delivery metrics, incidents, and roadmap progress",
    embedUrl: "https://gen-report-46-ppt-ant-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fae1d121-1e01-4820-af85-93126b540e1e/46-ppt-ant.png",
  },
  {
    slug: "47-ppt-professional",
    title: "Html Ppt Weekly Report / Professional",
    prompt:
      "/gen report with design system `professional` and template `html-ppt-weekly-report`, Marketing weekly status deck: campaign KPIs, pipeline, and content shipped",
    embedUrl: "https://gen-report-47-ppt-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c315929d-5729-4930-b300-9e5f6c371959/47-ppt-professional.png",
  },
  {
    slug: "48-ppt-cisco",
    title: "Html Ppt Weekly Report / Cisco",
    prompt:
      "/gen report with design system `cisco` and template `html-ppt-weekly-report`, IT operations weekly review: uptime, ticket volume, projects, and risks",
    embedUrl: "https://gen-report-48-ppt-cisco-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/202f5945-5e25-4109-a0f6-76ca9ea66476/48-ppt-cisco.png",
  },
  {
    slug: "49-ppt-ibm",
    title: "Html Ppt Weekly Report / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `html-ppt-weekly-report`, Consulting engagement weekly status with milestones and budget burn",
    embedUrl: "https://gen-report-49-ppt-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/301169b7-368e-408b-957a-3f71552d5b56/49-ppt-ibm.png",
  },
  {
    slug: "50-ppt-vodafone",
    title: "Html Ppt Weekly Report / Vodafone",
    prompt:
      "/gen report with design system `vodafone` and template `html-ppt-weekly-report`, Telecom product weekly business review with subscriber metrics",
    embedUrl: "https://gen-report-50-ppt-vodafone-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5db18f93-8dc1-4ea2-a300-3e2dd00efac3/50-ppt-vodafone.png",
  },
  {
    slug: "51-ppt-webex",
    title: "Html Ppt Weekly Report / Webex",
    prompt:
      "/gen report with design system `webex` and template `html-ppt-weekly-report`, Cross-functional weekly sync deck with per-team status cells",
    embedUrl: "https://gen-report-51-ppt-webex-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/208e6522-9551-4f33-ac03-3ceb804cb424/51-ppt-webex.png",
  },
  {
    slug: "52-ppt-mastercard",
    title: "Html Ppt Weekly Report / Mastercard",
    prompt:
      "/gen report with design system `mastercard` and template `html-ppt-weekly-report`, Payments product weekly review: volume, approval rate, and roadmap",
    embedUrl: "https://gen-report-52-ppt-mastercard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a4b3ce01-2342-4cc4-a038-c359b8c8c854/52-ppt-mastercard.png",
  },
  {
    slug: "53-pitch-corporate",
    title: "Ib Pitch Book / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `ib-pitch-book`, Sell-side pitch book for a SaaS company: trading comps, precedent transactions, valuation football field, and DCF sensitivity",
    embedUrl: "https://gen-report-53-pitch-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a0546d36-a459-4b65-a1a8-1cf28e9d996e/53-pitch-corporate.png",
  },
  {
    slug: "54-pitch-premium",
    title: "Ib Pitch Book / Premium",
    prompt:
      "/gen report with design system `premium` and template `ib-pitch-book`, M&A pitch book for a luxury consumer brand acquisition",
    embedUrl: "https://gen-report-54-pitch-premium-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5ddb3893-8a5e-47b2-a33b-d66d719c9190/54-pitch-premium.png",
  },
  {
    slug: "55-pitch-professional",
    title: "Ib Pitch Book / Professional",
    prompt:
      "/gen report with design system `professional` and template `ib-pitch-book`, Strategic options pitch book for a mid-market manufacturer",
    embedUrl: "https://gen-report-55-pitch-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/59374544-d9d3-4f91-9ae9-2511028162c8/55-pitch-professional.png",
  },
  {
    slug: "56-pitch-luxury",
    title: "Ib Pitch Book / Luxury",
    prompt:
      "/gen report with design system `luxury` and template `ib-pitch-book`, Board materials for a private equity take-private analysis",
    embedUrl: "https://gen-report-56-pitch-luxury-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e009abdd-ea40-4b17-a6bd-07b5375db86d/56-pitch-luxury.png",
  },
  {
    slug: "57-pitch-editorial",
    title: "Ib Pitch Book / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `ib-pitch-book`, Capital raise pitch book with a narrative thesis and valuation range",
    embedUrl: "https://gen-report-57-pitch-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f2704b0e-db0c-4c6c-bc3f-2c381c55a0af/57-pitch-editorial.png",
  },
  {
    slug: "58-pitch-ibm",
    title: "Ib Pitch Book / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `ib-pitch-book`, Enterprise tech merger pitch book with synergy analysis",
    embedUrl: "https://gen-report-58-pitch-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f009d185-fcb5-452b-85fb-794c34035ee1/58-pitch-ibm.png",
  },
  {
    slug: "59-pitch-elegant",
    title: "Ib Pitch Book / Elegant",
    prompt:
      "/gen report with design system `elegant` and template `ib-pitch-book`, IPO readiness pitch book: comps, valuation range, and use of proceeds",
    embedUrl: "https://gen-report-59-pitch-elegant-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0d5a57c1-a7cc-40fe-ae63-06ceec148bdc/59-pitch-elegant.png",
  },
  {
    slug: "60-pitch-mono",
    title: "Ib Pitch Book / Mono",
    prompt:
      "/gen report with design system `mono` and template `ib-pitch-book`, Lean restructuring pitch book with a strategic-options matrix",
    embedUrl: "https://gen-report-60-pitch-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cf02d200-23de-4131-a4c0-aeaaa34b38ba/60-pitch-mono.png",
  },
  {
    slug: "61-invoice-stripe",
    title: "Invoice / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `invoice`, SaaS subscription invoice with line items, proration, tax, and a payment link",
    embedUrl: "https://gen-report-61-invoice-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/799df9cc-ae67-4a03-9f0d-7b9b9628d09a/61-invoice-stripe.png",
  },
  {
    slug: "62-invoice-clean",
    title: "Invoice / Clean",
    prompt:
      "/gen report with design system `clean` and template `invoice`, Freelance design services invoice with hourly line items and totals",
    embedUrl: "https://gen-report-62-invoice-clean-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3d042e40-2b16-4f0a-bf9f-9d148790fd56/62-invoice-clean.png",
  },
  {
    slug: "63-invoice-minimal",
    title: "Invoice / Minimal",
    prompt:
      "/gen report with design system `minimal` and template `invoice`, Consulting retainer invoice with a milestone breakdown",
    embedUrl: "https://gen-report-63-invoice-minimal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5be9cf6d-1217-491d-9e09-1e6850ca8b4c/63-invoice-minimal.png",
  },
  {
    slug: "64-invoice-wise",
    title: "Invoice / Wise",
    prompt:
      "/gen report with design system `wise` and template `invoice`, Cross-border contractor invoice with multi-currency amounts and bank details",
    embedUrl: "https://gen-report-64-invoice-wise-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/649c166e-a682-441c-9bad-1fc1f43f8436/64-invoice-wise.png",
  },
  {
    slug: "65-invoice-paper",
    title: "Invoice / Paper",
    prompt:
      "/gen report with design system `paper` and template `invoice`, Print-ready agency invoice with itemized deliverables and VAT",
    embedUrl: "https://gen-report-65-invoice-paper-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1312c5cc-ad54-460b-853f-60a6f2d68b77/65-invoice-paper.png",
  },
  {
    slug: "66-invoice-professional",
    title: "Invoice / Professional",
    prompt:
      "/gen report with design system `professional` and template `invoice`, Enterprise software license invoice with a PO reference and net-30 terms",
    embedUrl:
      "https://gen-report-66-invoice-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c9f9cbeb-53d3-46ff-9e0a-3d026c20be46/66-invoice-professional.png",
  },
  {
    slug: "67-invoice-refined",
    title: "Invoice / Refined",
    prompt:
      "/gen report with design system `refined` and template `invoice`, Photography studio invoice with package line items",
    embedUrl: "https://gen-report-67-invoice-refined-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d338580b-a5df-411e-b9ef-867e7c75d77d/67-invoice-refined.png",
  },
  {
    slug: "68-invoice-simple",
    title: "Invoice / Simple",
    prompt:
      "/gen report with design system `simple` and template `invoice`, Small-business product invoice with quantity, unit price, and sales tax",
    embedUrl: "https://gen-report-68-invoice-simple-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/35bfcce8-a3f3-45f2-8ce9-eda77c4d8019/68-invoice-simple.png",
  },
  {
    slug: "69-last30-theverge",
    title: "Last30days / Theverge",
    prompt:
      "/gen report with design system `theverge` and template `last30days`, Last 30 days in AI agents: top launches, debates, and community trends",
    embedUrl: "https://gen-report-69-last30-theverge-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4ca6d41f-5de7-436d-a2df-dd9bbe9ae696/69-last30-theverge.png",
  },
  {
    slug: "70-last30-wired",
    title: "Last30days / Wired",
    prompt:
      "/gen report with design system `wired` and template `last30days`, 30-day trend report on the humanoid robotics space",
    embedUrl: "https://gen-report-70-last30-wired-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/42d7f3a6-7416-4619-9cb8-100d97b66952/70-last30-wired.png",
  },
  {
    slug: "71-last30-perplexity",
    title: "Last30days / Perplexity",
    prompt:
      "/gen report with design system `perplexity` and template `last30days`, Recent 30-day developments in open-source LLMs",
    embedUrl: "https://gen-report-71-last30-perplexity-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/646b269e-9c9c-4e3e-91bd-945d958adf88/71-last30-perplexity.png",
  },
  {
    slug: "72-last30-publication",
    title: "Last30days / Publication",
    prompt:
      "/gen report with design system `publication` and template `last30days`, Last 30 days in crypto and DeFi: narratives, launches, and sentiment",
    embedUrl: "https://gen-report-72-last30-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d0f2c9e5-b970-49cc-aea3-ed62a2516fd5/72-last30-publication.png",
  },
  {
    slug: "73-last30-editorial",
    title: "Last30days / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `last30days`, 30-day roundup of developer-tooling community discourse",
    embedUrl: "https://gen-report-73-last30-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a1463152-7d94-41fc-ae7a-4f9b2cf57b75/73-last30-editorial.png",
  },
  {
    slug: "74-last30-posthog",
    title: "Last30days / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `last30days`, Recent product-analytics and growth community trends over the last 30 days",
    embedUrl: "https://gen-report-74-last30-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/731cc1f9-a524-492a-82a0-820821e76cf3/74-last30-posthog.png",
  },
  {
    slug: "75-last30-mono",
    title: "Last30days / Mono",
    prompt:
      "/gen report with design system `mono` and template `last30days`, Last 30 days in the AI coding-agent ecosystem",
    embedUrl: "https://gen-report-75-last30-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7fd76294-f669-4abd-a0dd-f9e30d4b8bff/75-last30-mono.png",
  },
  {
    slug: "76-last30-x-ai",
    title: "Last30days / X Ai",
    prompt:
      "/gen report with design system `x-ai` and template `last30days`, 30-day trend report on AI safety and alignment discourse",
    embedUrl: "https://gen-report-76-last30-x-ai-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8f276042-3aed-40d4-8739-7f506e1062ec/76-last30-x-ai.png",
  },
  {
    slug: "77-live-dashboard",
    title: "Live Artifact / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `live-artifact`, Live revenue dashboard backed by Stripe data: MRR, churn, and new customers, refreshable",
    embedUrl: "https://gen-report-77-live-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/95f08782-2cc8-444c-b206-5a496d1df62e/77-live-dashboard.png",
  },
  {
    slug: "78-live-mission-control",
    title: "Live Artifact / Mission Control",
    prompt:
      "/gen report with design system `mission-control` and template `live-artifact`, Live ops dashboard for service health, incidents, and SLOs",
    embedUrl:
      "https://gen-report-78-live-mission-control-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0bb0386e-10aa-4879-8493-9c43d08fc967/78-live-mission-control.png",
  },
  {
    slug: "79-live-hud",
    title: "Live Artifact / Hud",
    prompt:
      "/gen report with design system `hud` and template `live-artifact`, Live KPI HUD for a startup: signups, activation, and revenue with auto-refresh",
    embedUrl: "https://gen-report-79-live-hud-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/65e7de3e-c0b1-4510-aea2-d31bf62cdab2/79-live-hud.png",
  },
  {
    slug: "80-live-trading-terminal",
    title: "Live Artifact / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `live-artifact`, Live portfolio tracker with positions, P&L, and market data",
    embedUrl:
      "https://gen-report-80-live-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d6a3ce09-03f8-48cc-86be-1b83bcf57679/80-live-trading-terminal.png",
  },
  {
    slug: "81-live-clickhouse",
    title: "Live Artifact / Clickhouse",
    prompt:
      "/gen report with design system `clickhouse` and template `live-artifact`, Live analytics report over an event stream with refreshable queries",
    embedUrl: "https://gen-report-81-live-clickhouse-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/abff0d0e-6c8d-44a2-8b54-a7f31ef9bc5f/81-live-clickhouse.png",
  },
  {
    slug: "82-live-sentry",
    title: "Live Artifact / Sentry",
    prompt:
      "/gen report with design system `sentry` and template `live-artifact`, Live error-monitoring artifact: error rate, top issues, and release health",
    embedUrl: "https://gen-report-82-live-sentry-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4e835f0b-5b9b-4b4e-ac7c-34a0988d92e5/82-live-sentry.png",
  },
  {
    slug: "83-live-posthog",
    title: "Live Artifact / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `live-artifact`, Live product-funnel artifact backed by analytics data",
    embedUrl: "https://gen-report-83-live-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9645b107-cea0-4a08-8a7b-c1a2d433ebe4/83-live-posthog.png",
  },
  {
    slug: "84-live-mono",
    title: "Live Artifact / Mono",
    prompt:
      "/gen report with design system `mono` and template `live-artifact`, Minimal live metrics artifact with auto-refreshing counters",
    embedUrl: "https://gen-report-84-live-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/59ff3438-6d7d-42f1-bfa8-3399f9e48bc7/84-live-mono.png",
  },
  {
    slug: "85-tweaks-framer",
    title: "Tweaks / Framer",
    prompt:
      "/gen report with design system `framer` and template `tweaks`, Landing page wrapped with a live control panel for accent color, type scale, density, and motion",
    embedUrl: "https://gen-report-85-tweaks-framer-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1877b56c-af89-4c1d-a8fd-d2cb49cafcac/85-tweaks-framer.png",
  },
  {
    slug: "86-tweaks-shadcn",
    title: "Tweaks / Shadcn",
    prompt:
      "/gen report with design system `shadcn` and template `tweaks`, Component showcase with live theme, density, and radius controls",
    embedUrl: "https://gen-report-86-tweaks-shadcn-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0bda6c75-eeb6-4af2-95cc-9114f5b022b6/86-tweaks-shadcn.png",
  },
  {
    slug: "87-tweaks-linear-app",
    title: "Tweaks / Linear App",
    prompt:
      "/gen report with design system `linear-app` and template `tweaks`, Dashboard with live parameterized controls for theme and motion",
    embedUrl: "https://gen-report-87-tweaks-linear-app-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0827d652-02aa-4d06-9fde-5d5493dfce8d/87-tweaks-linear-app.png",
  },
  {
    slug: "88-tweaks-raycast",
    title: "Tweaks / Raycast",
    prompt:
      "/gen report with design system `raycast` and template `tweaks`, Settings-style artifact with a live customization panel",
    embedUrl: "https://gen-report-88-tweaks-raycast-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/729139bd-3b7b-49d8-8021-50fee0c3792d/88-tweaks-raycast.png",
  },
  {
    slug: "89-tweaks-vercel",
    title: "Tweaks / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `tweaks`, Marketing page with real-time CSS variable tweaks and localStorage persistence",
    embedUrl: "https://gen-report-89-tweaks-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8249a3ff-ff4d-4824-a073-7fb67ade6765/89-tweaks-vercel.png",
  },
  {
    slug: "90-tweaks-figma",
    title: "Tweaks / Figma",
    prompt:
      "/gen report with design system `figma` and template `tweaks`, Design-token playground with live accent and scale controls",
    embedUrl: "https://gen-report-90-tweaks-figma-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/97dd9395-3128-4457-b8c0-82c554e3da00/90-tweaks-figma.png",
  },
  {
    slug: "91-tweaks-arc",
    title: "Tweaks / Arc",
    prompt:
      "/gen report with design system `arc` and template `tweaks`, Browser-style page with translucency and warmth controls",
    embedUrl: "https://gen-report-91-tweaks-arc-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/71883870-eae1-497a-9b17-e5cb53cfe117/91-tweaks-arc.png",
  },
  {
    slug: "92-tweaks-sleek",
    title: "Tweaks / Sleek",
    prompt:
      "/gen report with design system `sleek` and template `tweaks`, Minimal page with a live density and theme switcher",
    embedUrl: "https://gen-report-92-tweaks-sleek-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/00409223-e031-441f-b10e-330bc5d2db0f/92-tweaks-sleek.png",
  },
  {
    slug: "93-xresearch-x-ai",
    title: "X Research / X Ai",
    prompt:
      "/gen report with design system `x-ai` and template `x-research`, X sentiment research on a major AI model launch: themes, top posts, and sentiment breakdown",
    embedUrl: "https://gen-report-93-xresearch-x-ai-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4b9cf030-21bc-4ee5-a81e-e7519cde760b/93-xresearch-x-ai.png",
  },
  {
    slug: "94-xresearch-mono",
    title: "X Research / Mono",
    prompt:
      "/gen report with design system `mono` and template `x-research`, X public discourse research on a developer-tools product",
    embedUrl: "https://gen-report-94-xresearch-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/af7648f7-94f9-4e0a-9c8e-391666d6952d/94-xresearch-mono.png",
  },
  {
    slug: "95-xresearch-theverge",
    title: "X Research / Theverge",
    prompt:
      "/gen report with design system `theverge` and template `x-research`, X sentiment on a consumer hardware launch with an engagement breakdown",
    embedUrl: "https://gen-report-95-xresearch-theverge-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0d25c770-79fd-4edd-9482-9e900893fde7/95-xresearch-theverge.png",
  },
  {
    slug: "96-xresearch-perplexity",
    title: "X Research / Perplexity",
    prompt:
      "/gen report with design system `perplexity` and template `x-research`, X research on market reaction to an earnings report",
    embedUrl:
      "https://gen-report-96-xresearch-perplexity-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/79ed98b6-5a1e-4a0b-9f19-4c3f0a58cfb7/96-xresearch-perplexity.png",
  },
  {
    slug: "97-xresearch-wired",
    title: "X Research / Wired",
    prompt:
      "/gen report with design system `wired` and template `x-research`, X discourse analysis of a tech-policy debate",
    embedUrl: "https://gen-report-97-xresearch-wired-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ff5d78de-9063-46d9-8adc-c305f3057060/97-xresearch-wired.png",
  },
  {
    slug: "98-xresearch-posthog",
    title: "X Research / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `x-research`, X sentiment research on a SaaS pricing change",
    embedUrl: "https://gen-report-98-xresearch-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f8b765aa-2d63-418c-9b57-5fe0d7378479/98-xresearch-posthog.png",
  },
  {
    slug: "99-xresearch-publication",
    title: "X Research / Publication",
    prompt:
      "/gen report with design system `publication` and template `x-research`, X community research on an open-source project controversy",
    embedUrl:
      "https://gen-report-99-xresearch-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4a1768f4-81d8-4c47-9300-61436dd97afc/99-xresearch-publication.png",
  },
  {
    slug: "100-xresearch-editorial",
    title: "X Research / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `x-research`, X sentiment roundup for a product rebrand",
    embedUrl:
      "https://gen-report-100-xresearch-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/597751ca-f0eb-4452-a0c1-9159e3b2b02f/100-xresearch-editorial.png",
  },
];

export function buildReportRemixHref(item: ReportItem, appUrl: string): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
  return url.toString();
}
