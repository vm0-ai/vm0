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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c6c75152-d6f5-4949-9fb1-aa209a01139f/editorial-ink-product-launch.png",
    artifactUrl:
      "https://presentation-real-editorial-ink-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b9c771c6-8549-423a-b15b-0158e74e970c/editorial-ink-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-editorial-ink-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0f083e9f-559a-410a-99e3-9136e8bf4036/editorial-ink-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-editorial-ink-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/927d1b40-e601-44eb-a60e-36479b096745/editorial-ink-research-report.png",
    artifactUrl:
      "https://presentation-real-editorial-ink-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a466db3c-1f09-4583-ac4e-393deca54919/editorial-ink-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-editorial-ink-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/af7fca9a-bb17-49c5-bb90-e53f7bffd468/editorial-ink-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-editorial-ink-roadmap-planning-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ac619f30-585f-4890-ad52-aab38c42ead5/editorial-coral-product-launch.png",
    artifactUrl:
      "https://presentation-real-editorial-coral-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8e64fad0-405d-44c8-8399-916a50cc7cec/editorial-coral-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-editorial-coral-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/652756c0-da99-48d3-b453-08073e35dc0d/editorial-coral-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-editorial-coral-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8c6134e4-2195-4082-aa21-101944026c13/editorial-coral-research-report.png",
    artifactUrl:
      "https://presentation-real-editorial-coral-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a5b340f9-b3ff-4f2e-984b-2510827e54fc/editorial-coral-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-editorial-coral-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/00012544-3d7b-42b0-9b69-2301af6d27a9/editorial-coral-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-editorial-coral-roadmap-planning-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c4489a4f-18de-4aeb-9886-a4e77e04dac9/editorial-forest-product-launch.png",
    artifactUrl:
      "https://presentation-real-editorial-forest-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c1bd7250-8816-40cf-967e-27906cfdd2a7/editorial-forest-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-editorial-forest-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3ca2ea6b-694d-4ec3-989b-05360cf67a1a/editorial-forest-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-editorial-forest-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9acf6e48-7a92-49ab-9d79-0787ecbe2e07/editorial-forest-research-report.png",
    artifactUrl:
      "https://presentation-real-editorial-forest-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fa5c50fa-dc8b-471d-bd97-5c56093dab59/editorial-forest-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-editorial-forest-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e7aa9c1a-919d-4a43-ac47-c82fa1b93a1c/editorial-forest-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-editorial-forest-roadmap-planning-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8e479d0a-2945-4f64-bb60-9258f14cac72/swiss-ikb-product-launch.png",
    artifactUrl:
      "https://presentation-real-swiss-ikb-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3955b9b1-f75b-4cfb-8040-483606901796/swiss-ikb-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-swiss-ikb-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ad72fab9-e4df-4b09-ba9f-a58338c0d0c7/swiss-ikb-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-swiss-ikb-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/176d0b44-f45d-4110-a4b3-90367ad50cee/swiss-ikb-research-report.png",
    artifactUrl:
      "https://presentation-real-swiss-ikb-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/49394e7c-1b56-468a-bbd0-71b9a74f7777/swiss-ikb-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-swiss-ikb-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2884be61-b2d2-4431-b540-91fc3380d175/swiss-ikb-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-swiss-ikb-roadmap-planning-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5c731686-218c-438d-8bb6-ead0fef654f7/swiss-lemon-product-launch.png",
    artifactUrl:
      "https://presentation-real-swiss-lemon-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8771328d-914c-475d-8ffc-97acf03e894e/swiss-lemon-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-swiss-lemon-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6ac7f64e-8775-4cb1-bf1c-4d053fbc45af/swiss-lemon-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-swiss-lemon-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f63fdb15-dfd6-4f16-a8ae-c0e5f13ef2e7/swiss-lemon-research-report.png",
    artifactUrl:
      "https://presentation-real-swiss-lemon-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1112b1e3-4ea4-4581-af06-5c8e224aa46a/swiss-lemon-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-swiss-lemon-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f6f1d015-8891-4fc9-93b0-c9ca6f20d201/swiss-lemon-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-swiss-lemon-roadmap-planning-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6a137d40-746b-4dd8-a446-1fb51d9e764f/swiss-lime-product-launch.png",
    artifactUrl:
      "https://presentation-real-swiss-lime-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c5df08a7-25bd-4a48-8105-6ac13b6e846e/swiss-lime-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-swiss-lime-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1adebb40-33bb-4f91-bb34-bc5b4581b91a/swiss-lime-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-swiss-lime-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5f26a75f-8171-447d-8501-4f0a8e0e3770/swiss-lime-research-report.png",
    artifactUrl:
      "https://presentation-real-swiss-lime-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/63a77d56-0a51-4959-aea5-ad5a6ea7548e/swiss-lime-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-swiss-lime-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8362eb0f-69d0-4742-9ea8-f7786958f234/swiss-lime-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-swiss-lime-roadmap-planning-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e40503ff-dd17-44bb-a4e8-d221320dd40d/swiss-mono-product-launch.png",
    artifactUrl:
      "https://presentation-real-swiss-mono-product-launch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/1aaf3b28-b496-4dec-9fb9-ac5d98388fe0/swiss-mono-fundraising-pitch.png",
    artifactUrl:
      "https://presentation-real-swiss-mono-fundraising-pitch-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/96fb7a52-6f2d-468e-9001-7f6028950d0d/swiss-mono-strategy-memo.png",
    artifactUrl:
      "https://presentation-real-swiss-mono-strategy-memo-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9d6e794e-71b0-4593-843e-36d4771644c1/swiss-mono-research-report.png",
    artifactUrl:
      "https://presentation-real-swiss-mono-research-report-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/456f0b18-240f-4c57-89c8-58e16bfd3ad3/swiss-mono-sales-enablement.png",
    artifactUrl:
      "https://presentation-real-swiss-mono-sales-enablement-715f6d07.sites.vm0.io",
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
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/66af7d8c-ffda-43d1-aeb6-a9a8b8485b15/swiss-mono-roadmap-planning.png",
    artifactUrl:
      "https://presentation-real-swiss-mono-roadmap-planning-715f6d07.sites.vm0.io",
    style: "swiss",
    theme: "mono",
    slides: 10,
    images: 2,
    imageModel: "gpt-image-1",
    audience: "product and engineering leadership",
  }
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
