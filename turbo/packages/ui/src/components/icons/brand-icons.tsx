import { createLucideIcon, type IconNode } from "lucide-react";

// Lucide intentionally does not ship brand marks. Keep the five product brand
// icons local while exposing the same props and rendering contract as Lucide.
const brandGithub: IconNode = [
  [
    "path",
    {
      d: "M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5",
    },
  ],
];

const brandGoogleDrive: IconNode = [
  ["path", { d: "M12 10l-6 10l-3 -5l6 -10l3 5" }],
  ["path", { d: "M9 15h12l-3 5h-12" }],
  ["path", { d: "M15 15l-6 -10h6l6 10l-6 0" }],
];

const brandNotion: IconNode = [
  ["path", { d: "M11 17.5v-6.5h.5l4 6h.5v-6.5" }],
  [
    "path",
    {
      d: "M19.077 20.071l-11.53 .887a1 1 0 0 1 -.876 -.397l-2.471 -3.294a1 1 0 0 1 -.2 -.6v-10.741a1 1 0 0 1 .923 -.997l11.389 -.876a2 2 0 0 1 1.262 .33l1.535 1.023a2 2 0 0 1 .891 1.664v12.004a1 1 0 0 1 -.923 .997",
    },
  ],
  ["path", { d: "M4.5 5.5l2.5 2.5" }],
  ["path", { d: "M20 7l-13 1v12.5" }],
];

const brandSlack: IconNode = [
  ["path", { d: "M12 12v-6a2 2 0 0 1 4 0v6m0 -2a2 2 0 1 1 2 2h-6" }],
  ["path", { d: "M12 12h6a2 2 0 0 1 0 4h-6m2 0a2 2 0 1 1 -2 2v-6" }],
  ["path", { d: "M12 12v6a2 2 0 0 1 -4 0v-6m0 2a2 2 0 1 1 -2 -2h6" }],
  ["path", { d: "M12 12h-6a2 2 0 0 1 0 -4h6m-2 0a2 2 0 1 1 2 -2v6" }],
];

const brandTelegram: IconNode = [
  ["path", { d: "M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4" }],
];

export const BrandGithub = createLucideIcon("BrandGithub", brandGithub);
export const BrandGoogleDrive = createLucideIcon(
  "BrandGoogleDrive",
  brandGoogleDrive,
);
export const BrandNotion = createLucideIcon("BrandNotion", brandNotion);
export const BrandSlack = createLucideIcon("BrandSlack", brandSlack);
export const BrandTelegram = createLucideIcon("BrandTelegram", brandTelegram);
