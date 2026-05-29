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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/54ffa35d-e0ba-4606-a672-64e3aaacf190/01-finance-trading-terminal.png",
  },
  {
    slug: "02-finance-stripe",
    title: "Finance Report / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `finance-report`, Monthly revenue report for a payments startup: MRR, churn, expansion revenue, and cohort revenue retention",
    embedUrl: "https://gen-report-02-finance-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c2082dfd-1e6a-471b-9390-bad720d2dac9/02-finance-stripe.png",
  },
  {
    slug: "03-finance-corporate",
    title: "Finance Report / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `finance-report`, FY25 annual financial report for a manufacturing company: revenue, COGS, EBITDA, capex, and free cash flow",
    embedUrl: "https://gen-report-03-finance-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ecc39e5e-3007-47e3-847d-1b76277d99bc/03-finance-corporate.png",
  },
  {
    slug: "04-finance-editorial",
    title: "Finance Report / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `finance-report`, Quarterly investor update: P&L summary, cash position, KPI highlights, and a narrative outlook section",
    embedUrl: "https://gen-report-04-finance-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bc8b1f6e-be2b-49f1-a442-cab6c9b7e964/04-finance-editorial.png",
  },
  {
    slug: "05-finance-coinbase",
    title: "Finance Report / Coinbase",
    prompt:
      "/gen report with design system `coinbase` and template `finance-report`, Crypto exchange quarterly report: trading volume, fee revenue, treasury composition, and token holdings",
    embedUrl: "https://gen-report-05-finance-coinbase-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1db57d10-e84a-4343-8858-80cc731c94cf/05-finance-coinbase.png",
  },
  {
    slug: "06-finance-vercel",
    title: "Finance Report / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `finance-report`, Developer-tools company quarterly financials: usage-based revenue, gross margin, and R&D spend breakdown",
    embedUrl: "https://gen-report-06-finance-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/513a6a4c-a518-4e0e-86fc-6496f06a3964/06-finance-vercel.png",
  },
  {
    slug: "07-finance-mono",
    title: "Finance Report / Mono",
    prompt:
      "/gen report with design system `mono` and template `finance-report`, Lean monthly burn report for an early-stage startup: cash in, cash out, runway, and default-alive analysis",
    embedUrl: "https://gen-report-07-finance-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5f558c34-c000-453a-a587-7d701fa1fdfe/07-finance-mono.png",
  },
  {
    slug: "08-finance-ibm",
    title: "Finance Report / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `finance-report`, Enterprise division financial report: segment revenue, operating margin, backlog, and full-year guidance",
    embedUrl: "https://gen-report-08-finance-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/83bd5792-c4d4-4af1-b7bb-9ea10ef025f2/08-finance-ibm.png",
  },
  {
    slug: "09-finance-dashboard",
    title: "Finance Report / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `finance-report`, SaaS finance dashboard report: MRR, ARR waterfall, CAC payback, and the magic number",
    embedUrl: "https://gen-report-09-finance-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/269d5b5d-fe7a-48b9-9b24-3747d6509d11/09-finance-dashboard.png",
  },
  {
    slug: "10-finance-mastercard",
    title: "Finance Report / Mastercard",
    prompt:
      "/gen report with design system `mastercard` and template `finance-report`, Fintech quarterly report: transaction volume, interchange revenue, active cards, and fraud rate",
    embedUrl: "https://gen-report-10-finance-mastercard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/03c2e0c9-5700-43e2-9a1c-0f865e5c0cec/10-finance-mastercard.png",
  },
  {
    slug: "11-weekly-linear-app",
    title: "Weekly Update / Linear App",
    prompt:
      "/gen report with design system `linear-app` and template `weekly-update`, Engineering team weekly: shipped features, in-flight epics, blockers, sprint velocity, and asks",
    embedUrl: "https://gen-report-11-weekly-linear-app-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5f4ce96d-12bd-453c-a796-08c1c5bd6c1b/11-weekly-linear-app.png",
  },
  {
    slug: "12-weekly-notion",
    title: "Weekly Update / Notion",
    prompt:
      "/gen report with design system `notion` and template `weekly-update`, Product team weekly update deck: launches, experiments running, key metrics, and decisions needed",
    embedUrl: "https://gen-report-12-weekly-notion-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cfd7975c-1668-431c-b2df-200cf6da02a7/12-weekly-notion.png",
  },
  {
    slug: "13-weekly-slack",
    title: "Weekly Update / Slack",
    prompt:
      "/gen report with design system `slack` and template `weekly-update`, Growth team weekly: campaigns shipped, in-flight tests, blockers, and funnel metrics",
    embedUrl: "https://gen-report-13-weekly-slack-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/488cdc1d-db67-47f0-98f9-0834e549f8fd/13-weekly-slack.png",
  },
  {
    slug: "14-weekly-github",
    title: "Weekly Update / Github",
    prompt:
      "/gen report with design system `github` and template `weekly-update`, Open-source maintainer weekly: PRs merged, issues triaged, releases cut, and community asks",
    embedUrl: "https://gen-report-14-weekly-github-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/82c4a19a-302c-44bd-bcfc-fc36a8bf80f6/14-weekly-github.png",
  },
  {
    slug: "15-weekly-framer",
    title: "Weekly Update / Framer",
    prompt:
      "/gen report with design system `framer` and template `weekly-update`, Design team weekly: shipped designs, in-review explorations, research findings, and asks",
    embedUrl: "https://gen-report-15-weekly-framer-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/256c1509-f856-4654-88b0-e13bf0b75be8/15-weekly-framer.png",
  },
  {
    slug: "16-weekly-raycast",
    title: "Weekly Update / Raycast",
    prompt:
      "/gen report with design system `raycast` and template `weekly-update`, Founder weekly update to investors: shipped, metrics, hiring progress, and asks",
    embedUrl: "https://gen-report-16-weekly-raycast-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/009e1961-1f92-4ce6-85c2-5d74e6246108/16-weekly-raycast.png",
  },
  {
    slug: "17-weekly-superhuman",
    title: "Weekly Update / Superhuman",
    prompt:
      "/gen report with design system `superhuman` and template `weekly-update`, Sales team weekly: deals closed, pipeline movement, blockers, and quota attainment",
    embedUrl: "https://gen-report-17-weekly-superhuman-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c20314a1-374e-4143-8a6f-33aae4589cde/17-weekly-superhuman.png",
  },
  {
    slug: "18-weekly-cursor",
    title: "Weekly Update / Cursor",
    prompt:
      "/gen report with design system `cursor` and template `weekly-update`, AI infra team weekly: model evals shipped, training runs in flight, GPU blockers, and metrics",
    embedUrl: "https://gen-report-18-weekly-cursor-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9c42ce1b-53e4-47aa-933e-3848aea8dfd4/18-weekly-cursor.png",
  },
  {
    slug: "19-weekly-vercel",
    title: "Weekly Update / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `weekly-update`, Platform team weekly: deploys, reliability incidents, in-progress migrations, and SLOs",
    embedUrl: "https://gen-report-19-weekly-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8ff30440-fc2f-48ea-8390-7206968fc658/19-weekly-vercel.png",
  },
  {
    slug: "20-clinical-clean",
    title: "Clinical Case Report / Clean",
    prompt:
      "/gen report with design system `clean` and template `clinical-case-report`, 54-year-old male with acute chest pain: SOAP note, ECG findings, troponin trend, and STEMI management plan",
    embedUrl: "https://gen-report-20-clinical-clean-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1e165938-a3f2-4f5a-864e-3b8fcca31ae1/20-clinical-clean.png",
  },
  {
    slug: "21-clinical-publication",
    title: "Clinical Case Report / Publication",
    prompt:
      "/gen report with design system `publication` and template `clinical-case-report`, Pediatric case of Kawasaki disease: presentation, labs, echocardiogram findings, and IVIG response",
    embedUrl:
      "https://gen-report-21-clinical-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/03c995a4-836f-4916-8e51-6b11c0568b2a/21-clinical-publication.png",
  },
  {
    slug: "22-clinical-minimal",
    title: "Clinical Case Report / Minimal",
    prompt:
      "/gen report with design system `minimal` and template `clinical-case-report`, New diagnosis of type 2 diabetes: history, HbA1c, metabolic panel, and treatment plan",
    embedUrl: "https://gen-report-22-clinical-minimal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cf96790a-206a-4ecf-88ea-3ef70fe2d229/22-clinical-minimal.png",
  },
  {
    slug: "23-clinical-paper",
    title: "Clinical Case Report / Paper",
    prompt:
      "/gen report with design system `paper` and template `clinical-case-report`, Post-operative pulmonary embolism case: vitals, D-dimer, CT-PA findings, and anticoagulation plan",
    embedUrl: "https://gen-report-23-clinical-paper-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/323cccf9-618c-485f-bf99-09ccd174753c/23-clinical-paper.png",
  },
  {
    slug: "24-clinical-refined",
    title: "Clinical Case Report / Refined",
    prompt:
      "/gen report with design system `refined` and template `clinical-case-report`, Rheumatoid arthritis flare: joint exam, inflammatory markers, imaging, and biologic escalation",
    embedUrl: "https://gen-report-24-clinical-refined-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/90271c87-9f66-49d0-9382-8ae3c57bde37/24-clinical-refined.png",
  },
  {
    slug: "25-clinical-professional",
    title: "Clinical Case Report / Professional",
    prompt:
      "/gen report with design system `professional` and template `clinical-case-report`, Community-acquired pneumonia in an elderly patient: CURB-65 score, labs, CXR, and antibiotic course",
    embedUrl:
      "https://gen-report-25-clinical-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b03afc26-4896-461a-98a1-d2394ce3e6a4/25-clinical-professional.png",
  },
  {
    slug: "26-clinical-material",
    title: "Clinical Case Report / Material",
    prompt:
      "/gen report with design system `material` and template `clinical-case-report`, Migraine with aura differential workup: neuro exam, MRI, and medication strategy",
    embedUrl: "https://gen-report-26-clinical-material-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e1439746-eb7d-4388-a7c9-446ce52ac25f/26-clinical-material.png",
  },
  {
    slug: "27-clinical-editorial",
    title: "Clinical Case Report / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `clinical-case-report`, Narrative case report of a rare autoimmune presentation prepared for grand rounds",
    embedUrl: "https://gen-report-27-clinical-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5b114832-1843-4097-a365-84c56d604bb9/27-clinical-editorial.png",
  },
  {
    slug: "28-critique-artistic",
    title: "Critique / Artistic",
    prompt:
      "/gen report with design system `artistic` and template `critique`, Design critique of a fintech landing page across philosophy, hierarchy, detail, functionality, and innovation",
    embedUrl: "https://gen-report-28-critique-artistic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/10ff738f-33f9-4713-903c-8b07a397beed/28-critique-artistic.png",
  },
  {
    slug: "29-critique-dramatic",
    title: "Critique / Dramatic",
    prompt:
      "/gen report with design system `dramatic` and template `critique`, Expert design review of an AI product dashboard with a radar chart and scored evidence",
    embedUrl: "https://gen-report-29-critique-dramatic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3fb489ee-0aa6-46cd-942e-ffc5ad3b0283/29-critique-dramatic.png",
  },
  {
    slug: "30-critique-bold",
    title: "Critique / Bold",
    prompt:
      "/gen report with design system `bold` and template `critique`, Critique of a SaaS pricing page: visual hierarchy, clarity, and conversion design",
    embedUrl: "https://gen-report-30-critique-bold-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/077dbddb-f4f2-4d0e-91aa-032e6f977d9e/30-critique-bold.png",
  },
  {
    slug: "31-critique-brutalism",
    title: "Critique / Brutalism",
    prompt:
      "/gen report with design system `brutalism` and template `critique`, Design teardown of a portfolio website with 0-10 scoring across five dimensions",
    embedUrl: "https://gen-report-31-critique-brutalism-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/165cd7e7-3538-4aa1-a101-49a13a84606a/31-critique-brutalism.png",
  },
  {
    slug: "32-critique-expressive",
    title: "Critique / Expressive",
    prompt:
      "/gen report with design system `expressive` and template `critique`, Critique of a mobile onboarding flow's visual and interaction design",
    embedUrl: "https://gen-report-32-critique-expressive-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7bd114fd-b6cc-4d36-8dcb-b39dbe55c82a/32-critique-expressive.png",
  },
  {
    slug: "33-critique-cosmic",
    title: "Critique / Cosmic",
    prompt:
      "/gen report with design system `cosmic` and template `critique`, Review of a data-visualization-heavy analytics product UI",
    embedUrl: "https://gen-report-33-critique-cosmic-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a53becde-ed26-495c-82bc-1e097e005b95/33-critique-cosmic.png",
  },
  {
    slug: "34-critique-neobrutalism",
    title: "Critique / Neobrutalism",
    prompt:
      "/gen report with design system `neobrutalism` and template `critique`, Critique of a marketing site redesign with before/after scoring",
    embedUrl:
      "https://gen-report-34-critique-neobrutalism-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8e77e916-6db0-4fe3-ab4d-e83127916f66/34-critique-neobrutalism.png",
  },
  {
    slug: "35-critique-dithered",
    title: "Critique / Dithered",
    prompt:
      "/gen report with design system `dithered` and template `critique`, Retro-styled critique of a game studio's web presence",
    embedUrl: "https://gen-report-35-critique-dithered-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3abfbc1a-9769-49d6-a5cb-6f077e37a3c3/35-critique-dithered.png",
  },
  {
    slug: "36-dcf-trading-terminal",
    title: "Dcf Valuation / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `dcf-valuation`, DCF valuation of a high-growth SaaS company with WACC sensitivity and terminal value analysis",
    embedUrl:
      "https://gen-report-36-dcf-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/00e96971-b805-4a4d-84ae-cdb590fe1b23/36-dcf-trading-terminal.png",
  },
  {
    slug: "37-dcf-corporate",
    title: "Dcf Valuation / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `dcf-valuation`, DCF intrinsic value analysis of a mature consumer-goods company",
    embedUrl: "https://gen-report-37-dcf-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0bba1225-ad39-4ae8-98ec-a95810012302/37-dcf-corporate.png",
  },
  {
    slug: "38-dcf-professional",
    title: "Dcf Valuation / Professional",
    prompt:
      "/gen report with design system `professional` and template `dcf-valuation`, DCF model for a semiconductor company: FCF projections, discount rate, and scenario analysis",
    embedUrl: "https://gen-report-38-dcf-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e0612622-e415-4588-8268-8a25d2a0bd9e/38-dcf-professional.png",
  },
  {
    slug: "39-dcf-mono",
    title: "Dcf Valuation / Mono",
    prompt:
      "/gen report with design system `mono` and template `dcf-valuation`, Lean DCF for an early profitable startup with an explicit assumptions table",
    embedUrl: "https://gen-report-39-dcf-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b7ae85c5-9977-4826-9a35-eecb78fc57df/39-dcf-mono.png",
  },
  {
    slug: "40-dcf-editorial",
    title: "Dcf Valuation / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `dcf-valuation`, Narrative DCF valuation memo for a media company",
    embedUrl: "https://gen-report-40-dcf-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b6fcd381-a5b8-4509-a2e0-de54ad3169d8/40-dcf-editorial.png",
  },
  {
    slug: "41-dcf-ibm",
    title: "Dcf Valuation / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `dcf-valuation`, Enterprise software DCF: segment FCF, WACC build-up, and a sensitivity grid",
    embedUrl: "https://gen-report-41-dcf-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e13d44b5-f969-4718-809e-a7dbc0cf595e/41-dcf-ibm.png",
  },
  {
    slug: "42-dcf-stripe",
    title: "Dcf Valuation / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `dcf-valuation`, Fintech DCF valuation with revenue ramp and margin expansion scenarios",
    embedUrl: "https://gen-report-42-dcf-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b024badc-b8a0-4755-a63e-ac1931ad83cb/42-dcf-stripe.png",
  },
  {
    slug: "43-dcf-dashboard",
    title: "Dcf Valuation / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `dcf-valuation`, DCF dashboard report with sensitivity heatmaps",
    embedUrl: "https://gen-report-43-dcf-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9678772a-30c0-4765-b825-830b44b11770/43-dcf-dashboard.png",
  },
  {
    slug: "44-ppt-corporate",
    title: "Html Ppt Weekly Report / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `html-ppt-weekly-report`, Company-wide weekly business review: 8-cell KPI grid, shipped list, and 8-week trend",
    embedUrl: "https://gen-report-44-ppt-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1e830047-2eed-41ad-a62c-ae1a147d35e6/44-ppt-corporate.png",
  },
  {
    slug: "45-ppt-enterprise",
    title: "Html Ppt Weekly Report / Enterprise",
    prompt:
      "/gen report with design system `enterprise` and template `html-ppt-weekly-report`, Regional sales weekly status deck with a KPI grid and next-week plan",
    embedUrl: "https://gen-report-45-ppt-enterprise-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4c838ef7-dbfe-446c-9c6a-e09148e329c4/45-ppt-enterprise.png",
  },
  {
    slug: "46-ppt-ant",
    title: "Html Ppt Weekly Report / Ant",
    prompt:
      "/gen report with design system `ant` and template `html-ppt-weekly-report`, Engineering org weekly report: delivery metrics, incidents, and roadmap progress",
    embedUrl: "https://gen-report-46-ppt-ant-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f33b4dc3-6e62-4ee4-9a11-abb2cb668421/46-ppt-ant.png",
  },
  {
    slug: "47-ppt-professional",
    title: "Html Ppt Weekly Report / Professional",
    prompt:
      "/gen report with design system `professional` and template `html-ppt-weekly-report`, Marketing weekly status deck: campaign KPIs, pipeline, and content shipped",
    embedUrl: "https://gen-report-47-ppt-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c27e24f1-c1d1-4447-b0d5-aa28d56fae52/47-ppt-professional.png",
  },
  {
    slug: "48-ppt-cisco",
    title: "Html Ppt Weekly Report / Cisco",
    prompt:
      "/gen report with design system `cisco` and template `html-ppt-weekly-report`, IT operations weekly review: uptime, ticket volume, projects, and risks",
    embedUrl: "https://gen-report-48-ppt-cisco-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/54ad7667-6d3b-4754-9870-d80af7838b7d/48-ppt-cisco.png",
  },
  {
    slug: "49-ppt-ibm",
    title: "Html Ppt Weekly Report / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `html-ppt-weekly-report`, Consulting engagement weekly status with milestones and budget burn",
    embedUrl: "https://gen-report-49-ppt-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f7519758-9209-4d15-a469-30c609ced3c8/49-ppt-ibm.png",
  },
  {
    slug: "50-ppt-vodafone",
    title: "Html Ppt Weekly Report / Vodafone",
    prompt:
      "/gen report with design system `vodafone` and template `html-ppt-weekly-report`, Telecom product weekly business review with subscriber metrics",
    embedUrl: "https://gen-report-50-ppt-vodafone-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/558d34c6-7f72-44df-9f02-8e38c65014ff/50-ppt-vodafone.png",
  },
  {
    slug: "51-ppt-webex",
    title: "Html Ppt Weekly Report / Webex",
    prompt:
      "/gen report with design system `webex` and template `html-ppt-weekly-report`, Cross-functional weekly sync deck with per-team status cells",
    embedUrl: "https://gen-report-51-ppt-webex-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0a63edd6-b7f2-4f59-aa96-3a7ae9257343/51-ppt-webex.png",
  },
  {
    slug: "52-ppt-mastercard",
    title: "Html Ppt Weekly Report / Mastercard",
    prompt:
      "/gen report with design system `mastercard` and template `html-ppt-weekly-report`, Payments product weekly review: volume, approval rate, and roadmap",
    embedUrl: "https://gen-report-52-ppt-mastercard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bf64bba4-c67e-47d4-9bb3-3d2909dc38d4/52-ppt-mastercard.png",
  },
  {
    slug: "53-pitch-corporate",
    title: "Ib Pitch Book / Corporate",
    prompt:
      "/gen report with design system `corporate` and template `ib-pitch-book`, Sell-side pitch book for a SaaS company: trading comps, precedent transactions, valuation football field, and DCF sensitivity",
    embedUrl: "https://gen-report-53-pitch-corporate-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/40962d9c-884e-431b-b1f6-cbf6f7dc39ba/53-pitch-corporate.png",
  },
  {
    slug: "54-pitch-premium",
    title: "Ib Pitch Book / Premium",
    prompt:
      "/gen report with design system `premium` and template `ib-pitch-book`, M&A pitch book for a luxury consumer brand acquisition",
    embedUrl: "https://gen-report-54-pitch-premium-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/81176ef8-7bdf-4b11-9cf3-c96d9c5e0a32/54-pitch-premium.png",
  },
  {
    slug: "55-pitch-professional",
    title: "Ib Pitch Book / Professional",
    prompt:
      "/gen report with design system `professional` and template `ib-pitch-book`, Strategic options pitch book for a mid-market manufacturer",
    embedUrl: "https://gen-report-55-pitch-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/af77592e-4402-437d-9ae9-28e7b483cd5c/55-pitch-professional.png",
  },
  {
    slug: "56-pitch-luxury",
    title: "Ib Pitch Book / Luxury",
    prompt:
      "/gen report with design system `luxury` and template `ib-pitch-book`, Board materials for a private equity take-private analysis",
    embedUrl: "https://gen-report-56-pitch-luxury-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/23ce967f-6f2b-47a8-9b21-c5f003d325ce/56-pitch-luxury.png",
  },
  {
    slug: "57-pitch-editorial",
    title: "Ib Pitch Book / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `ib-pitch-book`, Capital raise pitch book with a narrative thesis and valuation range",
    embedUrl: "https://gen-report-57-pitch-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/609a2b2e-838d-4483-958e-b80ae7da2ba7/57-pitch-editorial.png",
  },
  {
    slug: "58-pitch-ibm",
    title: "Ib Pitch Book / Ibm",
    prompt:
      "/gen report with design system `ibm` and template `ib-pitch-book`, Enterprise tech merger pitch book with synergy analysis",
    embedUrl: "https://gen-report-58-pitch-ibm-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6537dc97-9a69-4de0-be6e-30bb2e142fa1/58-pitch-ibm.png",
  },
  {
    slug: "59-pitch-elegant",
    title: "Ib Pitch Book / Elegant",
    prompt:
      "/gen report with design system `elegant` and template `ib-pitch-book`, IPO readiness pitch book: comps, valuation range, and use of proceeds",
    embedUrl: "https://gen-report-59-pitch-elegant-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/43c51c7b-fe2c-4c5e-9de1-ab4c6bfee92a/59-pitch-elegant.png",
  },
  {
    slug: "60-pitch-mono",
    title: "Ib Pitch Book / Mono",
    prompt:
      "/gen report with design system `mono` and template `ib-pitch-book`, Lean restructuring pitch book with a strategic-options matrix",
    embedUrl: "https://gen-report-60-pitch-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d3fbfed5-c3d8-4820-94f2-255a78b57f80/60-pitch-mono.png",
  },
  {
    slug: "61-invoice-stripe",
    title: "Invoice / Stripe",
    prompt:
      "/gen report with design system `stripe` and template `invoice`, SaaS subscription invoice with line items, proration, tax, and a payment link",
    embedUrl: "https://gen-report-61-invoice-stripe-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/27e314b7-ac9b-44e8-bfb1-63548a4e28aa/61-invoice-stripe.png",
  },
  {
    slug: "62-invoice-clean",
    title: "Invoice / Clean",
    prompt:
      "/gen report with design system `clean` and template `invoice`, Freelance design services invoice with hourly line items and totals",
    embedUrl: "https://gen-report-62-invoice-clean-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/399ba0ae-5ecf-472f-92da-798d89a29bde/62-invoice-clean.png",
  },
  {
    slug: "63-invoice-minimal",
    title: "Invoice / Minimal",
    prompt:
      "/gen report with design system `minimal` and template `invoice`, Consulting retainer invoice with a milestone breakdown",
    embedUrl: "https://gen-report-63-invoice-minimal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/792a097e-dc30-42a8-84df-99d82bffe889/63-invoice-minimal.png",
  },
  {
    slug: "64-invoice-wise",
    title: "Invoice / Wise",
    prompt:
      "/gen report with design system `wise` and template `invoice`, Cross-border contractor invoice with multi-currency amounts and bank details",
    embedUrl: "https://gen-report-64-invoice-wise-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2fbbd350-daf7-4ca6-8943-f0eeb9464fa3/64-invoice-wise.png",
  },
  {
    slug: "65-invoice-paper",
    title: "Invoice / Paper",
    prompt:
      "/gen report with design system `paper` and template `invoice`, Print-ready agency invoice with itemized deliverables and VAT",
    embedUrl: "https://gen-report-65-invoice-paper-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4996cef4-2545-4ab7-8c23-e81919957f7b/65-invoice-paper.png",
  },
  {
    slug: "66-invoice-professional",
    title: "Invoice / Professional",
    prompt:
      "/gen report with design system `professional` and template `invoice`, Enterprise software license invoice with a PO reference and net-30 terms",
    embedUrl:
      "https://gen-report-66-invoice-professional-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/99f94089-73f1-48d9-ba74-5cc341d7113a/66-invoice-professional.png",
  },
  {
    slug: "67-invoice-refined",
    title: "Invoice / Refined",
    prompt:
      "/gen report with design system `refined` and template `invoice`, Photography studio invoice with package line items",
    embedUrl: "https://gen-report-67-invoice-refined-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e8ed32c3-5659-4801-b34e-0a63db3f932a/67-invoice-refined.png",
  },
  {
    slug: "68-invoice-simple",
    title: "Invoice / Simple",
    prompt:
      "/gen report with design system `simple` and template `invoice`, Small-business product invoice with quantity, unit price, and sales tax",
    embedUrl: "https://gen-report-68-invoice-simple-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9dcf81f8-59b6-40c7-bb7f-43bbd55b3f7d/68-invoice-simple.png",
  },
  {
    slug: "69-last30-theverge",
    title: "Last30days / Theverge",
    prompt:
      "/gen report with design system `theverge` and template `last30days`, Last 30 days in AI agents: top launches, debates, and community trends",
    embedUrl: "https://gen-report-69-last30-theverge-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bb113930-1f84-4423-b2cb-2214541d249c/69-last30-theverge.png",
  },
  {
    slug: "70-last30-wired",
    title: "Last30days / Wired",
    prompt:
      "/gen report with design system `wired` and template `last30days`, 30-day trend report on the humanoid robotics space",
    embedUrl: "https://gen-report-70-last30-wired-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/43c8146d-0a0a-4b75-acac-3db43702cee5/70-last30-wired.png",
  },
  {
    slug: "71-last30-perplexity",
    title: "Last30days / Perplexity",
    prompt:
      "/gen report with design system `perplexity` and template `last30days`, Recent 30-day developments in open-source LLMs",
    embedUrl: "https://gen-report-71-last30-perplexity-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0fd4eeff-9009-422c-bb9d-50cb0885163a/71-last30-perplexity.png",
  },
  {
    slug: "72-last30-publication",
    title: "Last30days / Publication",
    prompt:
      "/gen report with design system `publication` and template `last30days`, Last 30 days in crypto and DeFi: narratives, launches, and sentiment",
    embedUrl: "https://gen-report-72-last30-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9290d77a-12ca-4115-a52d-61454b5f42b6/72-last30-publication.png",
  },
  {
    slug: "73-last30-editorial",
    title: "Last30days / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `last30days`, 30-day roundup of developer-tooling community discourse",
    embedUrl: "https://gen-report-73-last30-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/53544c97-848a-435b-a470-01e7da8d1430/73-last30-editorial.png",
  },
  {
    slug: "74-last30-posthog",
    title: "Last30days / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `last30days`, Recent product-analytics and growth community trends over the last 30 days",
    embedUrl: "https://gen-report-74-last30-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/aefc7b83-f8e4-4f1b-950f-8e7ec3ae948c/74-last30-posthog.png",
  },
  {
    slug: "75-last30-mono",
    title: "Last30days / Mono",
    prompt:
      "/gen report with design system `mono` and template `last30days`, Last 30 days in the AI coding-agent ecosystem",
    embedUrl: "https://gen-report-75-last30-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c48d06e5-ad35-46f3-bf8f-9b1aae0e5c36/75-last30-mono.png",
  },
  {
    slug: "76-last30-x-ai",
    title: "Last30days / X Ai",
    prompt:
      "/gen report with design system `x-ai` and template `last30days`, 30-day trend report on AI safety and alignment discourse",
    embedUrl: "https://gen-report-76-last30-x-ai-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6e37aebe-cae5-4be3-95cd-a6d296b520e6/76-last30-x-ai.png",
  },
  {
    slug: "77-live-dashboard",
    title: "Live Artifact / Dashboard",
    prompt:
      "/gen report with design system `dashboard` and template `live-artifact`, Live revenue dashboard backed by Stripe data: MRR, churn, and new customers, refreshable",
    embedUrl: "https://gen-report-77-live-dashboard-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1e381e20-75f4-4b62-8e34-875dadca30d1/77-live-dashboard.png",
  },
  {
    slug: "78-live-mission-control",
    title: "Live Artifact / Mission Control",
    prompt:
      "/gen report with design system `mission-control` and template `live-artifact`, Live ops dashboard for service health, incidents, and SLOs",
    embedUrl:
      "https://gen-report-78-live-mission-control-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e6418c65-ce89-43e4-9fc9-25b2022262ef/78-live-mission-control.png",
  },
  {
    slug: "79-live-hud",
    title: "Live Artifact / Hud",
    prompt:
      "/gen report with design system `hud` and template `live-artifact`, Live KPI HUD for a startup: signups, activation, and revenue with auto-refresh",
    embedUrl: "https://gen-report-79-live-hud-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9b5e2881-163a-4dfe-a5ca-8dd2666bb22c/79-live-hud.png",
  },
  {
    slug: "80-live-trading-terminal",
    title: "Live Artifact / Trading Terminal",
    prompt:
      "/gen report with design system `trading-terminal` and template `live-artifact`, Live portfolio tracker with positions, P&L, and market data",
    embedUrl:
      "https://gen-report-80-live-trading-terminal-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2961e0d5-b79f-4e3f-8a46-6902d3548051/80-live-trading-terminal.png",
  },
  {
    slug: "81-live-clickhouse",
    title: "Live Artifact / Clickhouse",
    prompt:
      "/gen report with design system `clickhouse` and template `live-artifact`, Live analytics report over an event stream with refreshable queries",
    embedUrl: "https://gen-report-81-live-clickhouse-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/44704687-2697-41e2-ab4b-d4b5f0c80c36/81-live-clickhouse.png",
  },
  {
    slug: "82-live-sentry",
    title: "Live Artifact / Sentry",
    prompt:
      "/gen report with design system `sentry` and template `live-artifact`, Live error-monitoring artifact: error rate, top issues, and release health",
    embedUrl: "https://gen-report-82-live-sentry-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1b4640aa-cb34-4839-9e42-ac37354c91b2/82-live-sentry.png",
  },
  {
    slug: "83-live-posthog",
    title: "Live Artifact / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `live-artifact`, Live product-funnel artifact backed by analytics data",
    embedUrl: "https://gen-report-83-live-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/db267293-f9de-4a8f-91c6-c3deaf2c56be/83-live-posthog.png",
  },
  {
    slug: "84-live-mono",
    title: "Live Artifact / Mono",
    prompt:
      "/gen report with design system `mono` and template `live-artifact`, Minimal live metrics artifact with auto-refreshing counters",
    embedUrl: "https://gen-report-84-live-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/61a15bad-a13f-4d78-bc17-2ea288c90116/84-live-mono.png",
  },
  {
    slug: "85-tweaks-framer",
    title: "Tweaks / Framer",
    prompt:
      "/gen report with design system `framer` and template `tweaks`, Landing page wrapped with a live control panel for accent color, type scale, density, and motion",
    embedUrl: "https://gen-report-85-tweaks-framer-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/771293e8-b5dc-46eb-b5c9-85d7a85cba3d/85-tweaks-framer.png",
  },
  {
    slug: "86-tweaks-shadcn",
    title: "Tweaks / Shadcn",
    prompt:
      "/gen report with design system `shadcn` and template `tweaks`, Component showcase with live theme, density, and radius controls",
    embedUrl: "https://gen-report-86-tweaks-shadcn-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a9747347-a334-4220-8b5d-225224a143e5/86-tweaks-shadcn.png",
  },
  {
    slug: "87-tweaks-linear-app",
    title: "Tweaks / Linear App",
    prompt:
      "/gen report with design system `linear-app` and template `tweaks`, Dashboard with live parameterized controls for theme and motion",
    embedUrl: "https://gen-report-87-tweaks-linear-app-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5ac049fb-34c2-4272-b8bf-9fe27ee968dd/87-tweaks-linear-app.png",
  },
  {
    slug: "88-tweaks-raycast",
    title: "Tweaks / Raycast",
    prompt:
      "/gen report with design system `raycast` and template `tweaks`, Settings-style artifact with a live customization panel",
    embedUrl: "https://gen-report-88-tweaks-raycast-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/69419ed5-4eb4-44df-a5e9-e2a14d05d0a0/88-tweaks-raycast.png",
  },
  {
    slug: "89-tweaks-vercel",
    title: "Tweaks / Vercel",
    prompt:
      "/gen report with design system `vercel` and template `tweaks`, Marketing page with real-time CSS variable tweaks and localStorage persistence",
    embedUrl: "https://gen-report-89-tweaks-vercel-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d4b26cde-5e85-45fd-a0a8-3e6eaf5e3fba/89-tweaks-vercel.png",
  },
  {
    slug: "90-tweaks-figma",
    title: "Tweaks / Figma",
    prompt:
      "/gen report with design system `figma` and template `tweaks`, Design-token playground with live accent and scale controls",
    embedUrl: "https://gen-report-90-tweaks-figma-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5243fb69-0c80-435a-963d-80d2e6e997f3/90-tweaks-figma.png",
  },
  {
    slug: "91-tweaks-arc",
    title: "Tweaks / Arc",
    prompt:
      "/gen report with design system `arc` and template `tweaks`, Browser-style page with translucency and warmth controls",
    embedUrl: "https://gen-report-91-tweaks-arc-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/76583bab-e6c4-4692-af8c-d82359c17b22/91-tweaks-arc.png",
  },
  {
    slug: "92-tweaks-sleek",
    title: "Tweaks / Sleek",
    prompt:
      "/gen report with design system `sleek` and template `tweaks`, Minimal page with a live density and theme switcher",
    embedUrl: "https://gen-report-92-tweaks-sleek-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bd7b97d5-5a97-46a8-a661-e8b71bd095cc/92-tweaks-sleek.png",
  },
  {
    slug: "93-xresearch-x-ai",
    title: "X Research / X Ai",
    prompt:
      "/gen report with design system `x-ai` and template `x-research`, X sentiment research on a major AI model launch: themes, top posts, and sentiment breakdown",
    embedUrl: "https://gen-report-93-xresearch-x-ai-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/291d5474-87fe-4669-9e41-44e28e3b926e/93-xresearch-x-ai.png",
  },
  {
    slug: "94-xresearch-mono",
    title: "X Research / Mono",
    prompt:
      "/gen report with design system `mono` and template `x-research`, X public discourse research on a developer-tools product",
    embedUrl: "https://gen-report-94-xresearch-mono-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e5141100-7b7c-47bb-a218-0d577c8cc71d/94-xresearch-mono.png",
  },
  {
    slug: "95-xresearch-theverge",
    title: "X Research / Theverge",
    prompt:
      "/gen report with design system `theverge` and template `x-research`, X sentiment on a consumer hardware launch with an engagement breakdown",
    embedUrl: "https://gen-report-95-xresearch-theverge-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f2cdc1b5-6f35-4660-a3fa-bd37b36b4488/95-xresearch-theverge.png",
  },
  {
    slug: "96-xresearch-perplexity",
    title: "X Research / Perplexity",
    prompt:
      "/gen report with design system `perplexity` and template `x-research`, X research on market reaction to an earnings report",
    embedUrl:
      "https://gen-report-96-xresearch-perplexity-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b44e06f1-7b34-4b2e-9308-589cebf96060/96-xresearch-perplexity.png",
  },
  {
    slug: "97-xresearch-wired",
    title: "X Research / Wired",
    prompt:
      "/gen report with design system `wired` and template `x-research`, X discourse analysis of a tech-policy debate",
    embedUrl: "https://gen-report-97-xresearch-wired-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/873cebb4-3546-439b-a11f-03e07f2d0f64/97-xresearch-wired.png",
  },
  {
    slug: "98-xresearch-posthog",
    title: "X Research / Posthog",
    prompt:
      "/gen report with design system `posthog` and template `x-research`, X sentiment research on a SaaS pricing change",
    embedUrl: "https://gen-report-98-xresearch-posthog-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e5dcdf79-72ce-4e97-8545-d04325a942d5/98-xresearch-posthog.png",
  },
  {
    slug: "99-xresearch-publication",
    title: "X Research / Publication",
    prompt:
      "/gen report with design system `publication` and template `x-research`, X community research on an open-source project controversy",
    embedUrl:
      "https://gen-report-99-xresearch-publication-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4672c0af-1c5a-45e3-ab01-8231b2dc2e9a/99-xresearch-publication.png",
  },
  {
    slug: "100-xresearch-editorial",
    title: "X Research / Editorial",
    prompt:
      "/gen report with design system `editorial` and template `x-research`, X sentiment roundup for a product rebrand",
    embedUrl:
      "https://gen-report-100-xresearch-editorial-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f3053f00-261a-4d6d-8ab2-b8bad02b1485/100-xresearch-editorial.png",
  },
];

export function buildReportRemixHref(item: ReportItem, appUrl: string): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
  return url.toString();
}
