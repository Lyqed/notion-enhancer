/**
 * notion-enhancer: dark+
 * (c) 2021 dragonwocky <thedragonring.bod@gmail.com> (https://dragonwocky.me/)
 * (https://notion-enhancer.github.io/) under the MIT license
 */

"use strict";

// normalises any css colour to its [r, g, b, a] channels
const parseColour = (colour) => {
    const $probe = document.createElement("span");
    $probe.style.color = colour;
    if (!$probe.style.color) return null;
    document.body.append($probe);
    const computed = getComputedStyle($probe).color;
    $probe.remove();
    const [r, g, b, a = 1] = computed.match(/[\d.]+/g).map(Number);
    return [r, g, b, a];
  },
  // black or white, whichever is more readable on the given colour
  contrastOf = ([r, g, b]) =>
    (r * 299 + g * 587 + b * 114) / 1000 >= 165 ? "#000" : "#fff",
  setVar = (name, value) =>
    document.documentElement.style.setProperty(`--dark_plus--${name}`, value);

export default async (api, db) => {
  const primary = await db.get("primary"),
    secondary = await db.get("secondary"),
    primaryRgb = parseColour(primary),
    secondaryRgb = parseColour(secondary);

  // defaults are defined by the theme's stylesheet
  if (primaryRgb && primaryRgb.join() !== "46,170,220,1") {
    setVar("accent_blue", primary);
    setVar("accent_blue-selection", `color-mix(in srgb, ${primary} 20%, transparent)`);
    setVar("accent_blue-hover", `color-mix(in srgb, ${primary} 90%, black)`);
    setVar("accent_blue-text", contrastOf(primaryRgb));
  }
  if (secondaryRgb && secondaryRgb.join() !== "235,87,87,1") {
    setVar("accent_red", secondary);
    setVar("accent_red-button", `color-mix(in srgb, ${secondary} 20%, transparent)`);
    setVar("accent_red-text", contrastOf(secondaryRgb));
  }
};
