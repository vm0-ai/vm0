import type { AvatarSvgConfig } from "./avatar-svg-utils.ts";

/** Preset avatar configurations rendered via SVG layer stacking. */
export function getAvatarPresets(): readonly AvatarSvgConfig[] {
  return [
    {
      rotation: 1,
      skin: 0,
      hairStyle: 1,
      hairColor: 5,
      expression: 1,
      intensity: "h",
    },
    {
      rotation: 2,
      skin: 1,
      hairStyle: 3,
      hairColor: 3,
      expression: 1,
      intensity: "m",
    },
    {
      rotation: 4,
      skin: 2,
      hairStyle: 5,
      hairColor: 4,
      expression: 3,
      intensity: "d",
    },
    {
      rotation: 3,
      skin: 3,
      hairStyle: 4,
      hairColor: 1,
      expression: 4,
      intensity: "h",
    },
    {
      rotation: 5,
      skin: 4,
      hairStyle: 2,
      hairColor: 2,
      expression: 5,
      intensity: "m",
    },
  ];
}
