export type PresentationStyle = "editorial" | "swiss";

export type PresentationTheme =
  | "ink"
  | "coral"
  | "forest"
  | "ikb"
  | "lemon"
  | "lime"
  | "mono";

export interface PresentationGalleryItem {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly previewImage: string;
  readonly artifactUrl: string;
  readonly style: PresentationStyle;
  readonly theme: PresentationTheme;
  readonly slides: number;
  readonly images: number;
  readonly imageModel: string;
  readonly audience: string;
}

export const PRESENTATION_GALLERY_ITEMS: readonly PresentationGalleryItem[] = [
  {
    slug: "editorial-ink-product-launch",
    title: "Ink Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `ink`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5046fc31-02e7-4ec2-8c1d-be5600d196b9/editorial-ink-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-editorial-ink-product-launch-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "ink",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "editorial-ink-fundraising-pitch",
    title: "Ink Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `ink`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/11b85ae4-e8d0-45c1-a97a-97a2e6c26d0e/editorial-ink-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-editorial-ink-fundraising-pitch-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "ink",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "editorial-ink-strategy-memo",
    title: "Ink Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `ink`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3a1bc202-83a3-4443-84af-264de5ccf8a9/editorial-ink-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-editorial-ink-strategy-memo-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "ink",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "editorial-ink-research-report",
    title: "Ink Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `ink`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/90d3b97b-0da6-4004-8412-42b3339deb2c/editorial-ink-research-report.png",
    artifactUrl:
      "https://presentation-gallery-editorial-ink-research-report-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "ink",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "editorial-ink-sales-enablement",
    title: "Ink Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `ink`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cb81bfe1-1eb3-4d7b-9112-3d714ebaf9a1/editorial-ink-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-editorial-ink-sales-enablement-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "ink",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "editorial-ink-roadmap-planning",
    title: "Ink Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `ink`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0d16add4-33c4-4673-859e-e258569ecbd0/editorial-ink-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-editorial-ink-roadmap-planning-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "ink",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
  {
    slug: "editorial-coral-product-launch",
    title: "Coral Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `coral`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/45df176d-1a71-4097-8948-3c7c5d6f126f/editorial-coral-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-editorial-coral-product-launch-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "coral",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "editorial-coral-fundraising-pitch",
    title: "Coral Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `coral`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c417ce39-4279-41d7-bdd8-5d78b253b7b9/editorial-coral-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-editorial-coral-fundraising-pitch-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "coral",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "editorial-coral-strategy-memo",
    title: "Coral Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `coral`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/db08b7c2-cd59-492c-8324-a095b7a1f690/editorial-coral-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-editorial-coral-strategy-memo-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "coral",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "editorial-coral-research-report",
    title: "Coral Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `coral`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7ab44459-d1a1-4fc4-804b-ac52f2103568/editorial-coral-research-report.png",
    artifactUrl:
      "https://presentation-gallery-editorial-coral-research-report-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "coral",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "editorial-coral-sales-enablement",
    title: "Coral Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `coral`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8c316b67-a8b8-4217-a03a-c9b127851381/editorial-coral-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-editorial-coral-sales-enablement-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "coral",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "editorial-coral-roadmap-planning",
    title: "Coral Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `coral`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5538033d-c17b-4d7b-ad76-ef4b32ed854a/editorial-coral-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-editorial-coral-roadmap-planning-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "coral",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
  {
    slug: "editorial-forest-product-launch",
    title: "Forest Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `forest`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f9598db5-7784-4422-80b7-c60c3883507b/editorial-forest-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-editorial-forest-product-launch-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "forest",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "editorial-forest-fundraising-pitch",
    title: "Forest Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `forest`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1aff75a-f2bb-4e09-8d1c-65e986919e9f/editorial-forest-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-forest-fundraising-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "forest",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "editorial-forest-strategy-memo",
    title: "Forest Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `forest`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ddf01411-50ed-4d2c-acc4-c5ee9e39a975/editorial-forest-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-editorial-forest-strategy-memo-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "forest",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "editorial-forest-research-report",
    title: "Forest Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `forest`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5f0551f5-d568-4ede-9073-d7fa5dc9bb15/editorial-forest-research-report.png",
    artifactUrl:
      "https://presentation-gallery-editorial-forest-research-report-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "forest",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "editorial-forest-sales-enablement",
    title: "Forest Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `forest`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9d7d144c-8faf-4cdf-8c16-f9d507bb4a4b/editorial-forest-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-editorial-forest-sales-enablement-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "forest",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "editorial-forest-roadmap-planning",
    title: "Forest Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `editorial`, theme `forest`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6a27156f-cb77-4326-8873-1ba4b3e7212c/editorial-forest-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-editorial-forest-roadmap-planning-715f6d07.sites.vm0.io",
    style: "editorial",
    theme: "forest",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
  {
    slug: "swiss-ikb-product-launch",
    title: "Ikb Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `ikb`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c10e7911-ca79-4cb9-bcf4-fae6c75076e1/swiss-ikb-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-ikb-product-launch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "ikb",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "swiss-ikb-fundraising-pitch",
    title: "Ikb Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `ikb`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/55c91bb8-cab4-46e7-ba0a-1f9109d88261/swiss-ikb-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-ikb-fundraising-pitch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "ikb",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "swiss-ikb-strategy-memo",
    title: "Ikb Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `ikb`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5eb59b2e-a72c-4506-bb6d-55bbc8a5ea1c/swiss-ikb-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-swiss-ikb-strategy-memo-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "ikb",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "swiss-ikb-research-report",
    title: "Ikb Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `ikb`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a4e2b68b-a46c-4d7d-b015-e7231d60bde0/swiss-ikb-research-report.png",
    artifactUrl:
      "https://presentation-gallery-swiss-ikb-research-report-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "ikb",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "swiss-ikb-sales-enablement",
    title: "Ikb Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `ikb`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8ac6b3a2-706f-4e5d-bcfa-b0ad5a731693/swiss-ikb-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-swiss-ikb-sales-enablement-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "ikb",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "swiss-ikb-roadmap-planning",
    title: "Ikb Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `ikb`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fb88a4c9-4d7c-4f11-b415-4be3efb7828c/swiss-ikb-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-swiss-ikb-roadmap-planning-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "ikb",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
  {
    slug: "swiss-lemon-product-launch",
    title: "Lemon Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lemon`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/eec8d2ac-d131-442e-b13c-0f2a3f7dd3e1/swiss-lemon-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lemon-product-launch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lemon",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "swiss-lemon-fundraising-pitch",
    title: "Lemon Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lemon`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4e91bcf8-becd-4f86-95ee-088fb516163f/swiss-lemon-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lemon-fundraising-pitch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lemon",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "swiss-lemon-strategy-memo",
    title: "Lemon Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lemon`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4d94220e-2725-4e60-8556-d5414df1ebf8/swiss-lemon-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lemon-strategy-memo-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lemon",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "swiss-lemon-research-report",
    title: "Lemon Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lemon`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/17284a00-dc0f-4beb-9759-76e1532d8993/swiss-lemon-research-report.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lemon-research-report-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lemon",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "swiss-lemon-sales-enablement",
    title: "Lemon Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lemon`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/09c35873-7961-4484-bad9-fe2cc03e3be9/swiss-lemon-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lemon-sales-enablement-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lemon",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "swiss-lemon-roadmap-planning",
    title: "Lemon Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lemon`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/dbbd9b62-dd0f-4944-bbe7-e7a66cbe649b/swiss-lemon-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lemon-roadmap-planning-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lemon",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
  {
    slug: "swiss-lime-product-launch",
    title: "Lime Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lime`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8d6bac1e-f0d1-4407-ba3b-8f7fc6ce07ad/swiss-lime-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lime-product-launch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lime",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "swiss-lime-fundraising-pitch",
    title: "Lime Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lime`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bf74b313-5e74-4206-964e-0788efc1c775/swiss-lime-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lime-fundraising-pitch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lime",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "swiss-lime-strategy-memo",
    title: "Lime Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lime`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2542469e-1eb6-4497-ae34-1407ae21d905/swiss-lime-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lime-strategy-memo-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lime",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "swiss-lime-research-report",
    title: "Lime Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lime`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2dd2e097-5db9-453a-9710-c6a0e5d2f909/swiss-lime-research-report.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lime-research-report-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lime",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "swiss-lime-sales-enablement",
    title: "Lime Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lime`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5d116b77-d602-4f21-b74c-82a5be2c370e/swiss-lime-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lime-sales-enablement-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lime",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "swiss-lime-roadmap-planning",
    title: "Lime Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `lime`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d30e45bd-867e-4f35-b91d-6f379dceff74/swiss-lime-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-swiss-lime-roadmap-planning-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "lime",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
  {
    slug: "swiss-mono-product-launch",
    title: "Mono Product Launch Narrative",
    description:
      "A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `mono`, 10 slides, and 4 generated images, create A launch deck explaining the market shift, product promise, proof, rollout plan, and launch metrics. Audience: product and growth leaders. Cover Market shift, product promise, customer proof, launch plan, metrics, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e8f20e73-7b8b-47f1-9152-5102ae2b78b4/swiss-mono-product-launch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-mono-product-launch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 10,
    images: 4,
    imageModel: "gpt-image-1",
    audience: "product and growth leaders",
  },
  {
    slug: "swiss-mono-fundraising-pitch",
    title: "Mono Fundraising Pitch",
    description:
      "A fundraising deck with problem, market, product, traction, business model, team, and ask.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `mono`, 12 slides, and 3 generated images, create A fundraising deck with problem, market, product, traction, business model, team, and ask. Audience: seed and Series A investors. Cover Problem, market size, product wedge, traction, business model, team, ask, and use of funds.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a3911aab-4979-4dc3-9607-389510680ef1/swiss-mono-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-gallery-swiss-mono-fundraising-pitch-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 12,
    images: 3,
    imageModel: "gpt-image-1",
    audience: "seed and Series A investors",
  },
  {
    slug: "swiss-mono-strategy-memo",
    title: "Mono Strategy Memo",
    description:
      "A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `mono`, 9 slides, and 1 generated images, create A strategic planning deck with context, options, tradeoffs, recommendation, risks, and operating cadence. Audience: executive team. Cover Context, strategic options, tradeoffs, recommendation, risks, decision points, and operating cadence.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a2fb8252-a9ff-41d3-a045-0566cc145912/swiss-mono-strategy-memo.png",
    artifactUrl:
      "https://presentation-gallery-swiss-mono-strategy-memo-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 9,
    images: 1,
    imageModel: "gpt-image-1",
    audience: "executive team",
  },
  {
    slug: "swiss-mono-research-report",
    title: "Mono Research Report",
    description:
      "A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `mono`, 11 slides, and 5 generated images, create A research findings deck with methodology, user segments, insights, evidence, opportunities, and next steps. Audience: product, design, and research teams. Cover Methodology, user segments, key insights, evidence snapshots, opportunity areas, and next steps.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/598b605c-62ac-41f0-8fae-f182b8cb0d9e/swiss-mono-research-report.png",
    artifactUrl:
      "https://presentation-gallery-swiss-mono-research-report-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 11,
    images: 5,
    imageModel: "gpt-image-1",
    audience: "product, design, and research teams",
  },
  {
    slug: "swiss-mono-sales-enablement",
    title: "Mono Sales Enablement",
    description:
      "A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `mono`, 8 slides, and 2 generated images, create A sales enablement deck with buyer pain, qualification cues, demo flow, objection handling, and ROI proof. Audience: account executives and solutions engineers. Cover Buyer pain, qualification cues, demo flow, proof points, objection handling, ROI story, and close plan.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6b4f2057-3ac3-49b7-bc9e-4e0913e854fc/swiss-mono-sales-enablement.png",
    artifactUrl:
      "https://presentation-gallery-swiss-mono-sales-enablement-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 8,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "account executives and solutions engineers",
  },
  {
    slug: "swiss-mono-roadmap-planning",
    title: "Mono Roadmap Planning",
    description:
      "A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones.",
    prompt:
      "Using `zero generate presentation` with style `swiss`, theme `mono`, 10 slides, and 2 generated images, create A roadmap planning deck with bets, sequencing, dependencies, resourcing, risks, and milestones. Audience: product and engineering leadership. Cover Strategic bets, sequencing, dependencies, resourcing, risks, milestones, and review rhythm.",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b04cb6fb-ed4b-4b59-9969-08c92fc62aa3/swiss-mono-roadmap-planning.png",
    artifactUrl:
      "https://presentation-gallery-swiss-mono-roadmap-planning-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  },
];

export function buildPresentationPromptHref(
  item: PresentationGalleryItem,
  locale: string,
): string {
  const url = new URL(`/${locale}/showcase`, "https://www.vm0.ai");
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("website", item.artifactUrl);
  return `${url.pathname}${url.search}`;
}
