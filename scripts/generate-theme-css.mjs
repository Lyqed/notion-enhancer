/**
 * notion-enhancer
 * (c) 2024 dragonwocky <thedragonring.bod@gmail.com> (https://dragonwocky.me/)
 * (https://notion-enhancer.github.io/) under the MIT license
 */

// notion colours its interface through css variables (e.g. --c-texPri,
// --c-bluBacSec, --ca-butHovBac) defined for .notion-light-theme and
// .notion-dark-theme. this script reads those definitions from notion's
// stylesheets and generates:
// - src/core/variables.css: the default values of the notion-enhancer's
//   --theme--* variables, taken from the notion variables they stand for
// - src/core/theme.css: overrides that redefine each notion variable as an
//   expression of --theme--* variables (the closest match to its original
//   value), so themes only need to set the small --theme--* palette
//
// usage: node scripts/generate-theme-css.mjs [notion.css ...]
// without arguments, stylesheets are downloaded from app.notion.com

import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseColour, toHex, mix, distance, chroma } from "./theme-colours.mjs";

const NOTION_URL = "https://app.notion.com",
  LIGHT_SELECTOR = ":root,.notion-light-theme",
  DARK_SELECTOR = ".notion-dark-theme",
  // maximum perceptual distance (oklab) between a notion variable's
  // original value and the theme expression chosen to replace it.
  // variables named after a colour are only matched against that
  // colour's --theme--* variables, so can be matched more loosely
  MAX_DISTANCE_EXACT = 0.03,
  MAX_DISTANCE = 0.08,
  MAX_DISTANCE_FAMILY = 0.16,
  // colours within values made up of several colours (shadows,
  // gradients) are only replaced when they match almost exactly
  MAX_DISTANCE_COMPOSITE = 0.012,
  // prefer plain variables over mixes of equal closeness
  MIX_PENALTY = 0.004,
  MIX_STEP = 5,
  ALPHA_STEP = 0.02,
  ALPHA_PENALTY = 0.05,
  // oklab chroma below which a colour is considered a shade of grey
  NEUTRAL_CHROMA = 0.03;

// [notion-enhancer colour, abbreviation used in notion's variable names]
const colours = [
    ["gray", "gra"],
    ["brown", "bro"],
    ["orange", "ora"],
    ["yellow", "yel"],
    ["green", "gre"],
    ["blue", "blu"],
    ["purple", "pur"],
    ["pink", "pin"],
    ["red", "red"],
  ],
  // the notion variable each --theme--* variable takes its default from
  anchors = {
    "fg-primary": "--c-texPri",
    "fg-secondary": "--c-texSec",
    "fg-border": "--c-borPri",
    ...Object.fromEntries(colours.map(([c, n]) => [`fg-${c}`, `--c-${n}TexSec`])),
    "bg-primary": "--c-bacPri",
    "bg-secondary": "--c-bacSec",
    "bg-hover": "--ca-butHovBac",
    "bg-overlay": "--ca-modUndBac",
    "bg-light_gray": "--c-graBacSec",
    "bg-gray": "--c-graBacTer",
    ...Object.fromEntries(
      colours.slice(1).map(([c, n]) => [`bg-${c}`, `--c-${n}BacSec`])
    ),
    "dim-light_gray": "--cl-palGra75",
    ...Object.fromEntries(colours.map(([c, n]) => [`dim-${c}`, `--c-${n}BacPri`])),
    "accent-primary": "--c-pilIcoBlu",
    "accent-primary_hover": "--c-bluButHovBac",
    "accent-primary_transparent": "--ca-palUiBlu200",
    "accent-secondary": "--c-pilIcoRed",
  },
  // which --theme--* variables (and mixes of pairs of them) may stand in
  // for a notion variable depends on what the variable is used for: e.g.
  // a background must not be built from the (often translucent) border
  // colour, and text should not take on the colour of a background
  neutralPalette = {
    text: {
      keys: ["fg-primary", "fg-secondary"],
      pairs: [
        ["fg-primary", "fg-secondary"],
        ["fg-secondary", "bg-primary"],
        ["fg-primary", "bg-primary"],
      ],
    },
    border: {
      keys: ["fg-border"],
      pairs: [
        ["fg-border", "bg-primary"],
        ["fg-border", "fg-secondary"],
        ["fg-secondary", "bg-primary"],
      ],
    },
    background: {
      keys: ["bg-primary", "bg-secondary"],
      pairs: [
        ["bg-secondary", "bg-primary"],
        ["bg-secondary", "fg-primary"],
        ["bg-primary", "fg-primary"],
      ],
    },
  },
  colourPalette = (c) => ({
    text: {
      keys: [`fg-${c}`],
      pairs: [
        [`fg-${c}`, "fg-primary"],
        [`fg-${c}`, "bg-primary"],
      ],
    },
    border: {
      keys: [`fg-${c}`, `bg-${c}`],
      pairs: [
        [`bg-${c}`, `fg-${c}`],
        [`bg-${c}`, "bg-primary"],
        [`fg-${c}`, "bg-primary"],
      ],
    },
    background: {
      keys: [`bg-${c}`, `dim-${c}`, `fg-${c}`],
      pairs: [
        [`bg-${c}`, "bg-primary"],
        [`dim-${c}`, "bg-primary"],
        [`dim-${c}`, `bg-${c}`],
        [`bg-${c}`, `fg-${c}`],
        [`fg-${c}`, "fg-primary"],
      ],
    },
  }),
  // notion's teal has no --theme--* equivalent: it is mixed from green & blue
  tealPairs = [
    ["fg-green", "fg-blue"],
    ["bg-green", "bg-blue"],
    ["dim-green", "dim-blue"],
  ],
  accentPalette = {
    keys: ["accent-primary", "accent-primary_hover", "accent-secondary"],
    pairs: [
      ["accent-primary", "bg-primary"],
      ["accent-primary", "fg-primary"],
      ["accent-secondary", "bg-primary"],
      ["accent-secondary", "fg-primary"],
    ],
  },
  roles = ["text", "border", "background"];

const readNotionStyles = async (files) => {
    if (files.length) {
      return Promise.all(files.map((file) => fsp.readFile(file, "utf-8")));
    }
    const html = await (await fetch(`${NOTION_URL}/login`)).text(),
      hrefs = [...html.matchAll(/href="(\/_assets\/[^"]+\.css)"/g)];
    if (!hrefs.length) throw new Error("no stylesheets found on notion's login page");
    return Promise.all(
      hrefs.map(async ([, href]) => (await fetch(NOTION_URL + href)).text())
    );
  },
  // collects custom property declarations by selector
  parseVariables = (stylesheets) => {
    const variables = {};
    for (const css of stylesheets) {
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const declaration of body.split(";")) {
          const i = declaration.indexOf(":"),
            name = declaration.slice(0, i).trim();
          if (!name.startsWith("--")) continue;
          (variables[selector.trim()] ??= {})[name] = declaration.slice(i + 1).trim();
        }
      }
    }
    return variables;
  };

// the colour family a notion variable belongs to, from its name
// e.g. --c-bluTexPri => blue, --c-pilBacRed => red, --c-texPri => undefined
const familyOf = (name) => {
  name = name.replace(/^--[a-z]+-/, "");
  if (/UiBlu/.test(name)) return "accent";
  if (/^tea(?=[A-Z])|[a-z]Tea(?![a-z])/.test(name)) return "teal";
  for (const [colour, abbr] of colours) {
    const upper = abbr[0].toUpperCase() + abbr.slice(1),
      pattern = new RegExp(`^${abbr}(?=[A-Z])|[a-z]${upper}(?![a-z])`);
    if (pattern.test(name)) return colour;
  }
};

// what a notion variable is used for, from its name
// e.g. --c-texPri => text, --c-pilHovBacYel => background
const roleOf = (name) => {
  name = name.replace(/^--[a-z]+-/, "");
  name = name[0].toUpperCase() + name.slice(1);
  const matches = [
    ["text", /(Tex|Ico)(?![a-z])/],
    ["border", /(Bor|Div|Out|Rin)(?![a-z])/],
    ["background", /(Bac|Bg)(?![a-z])/],
  ]
    .map(([role, pattern]) => [role, name.search(pattern)])
    .filter(([, index]) => index > -1)
    .sort(([, a], [, b]) => a - b);
  return matches[0]?.[0];
};

// every expression of --theme--* variables a notion variable
// could be replaced with, alongside the colour it evaluates to
const buildCandidates = (theme) => {
  const ref = (key) => `var(--theme--${key})`,
    expand = ({ keys = [], pairs = [] }) => [
      ...keys.map((key) => ({ css: ref(key), rgba: theme[key], cost: 0 })),
      ...pairs.flatMap(([a, b]) => {
        const steps = [];
        for (let p = MIX_STEP; p < 100; p += MIX_STEP) {
          steps.push({
            css: `color-mix(in srgb,${ref(a)} ${p}%,${ref(b)})`,
            rgba: mix(theme[a], theme[b], p / 100),
            cost: MIX_PENALTY,
          });
        }
        return steps;
      }),
    ],
    // a variable with no recognisable role may use any role's candidates
    byRole = (palette) => {
      const expanded = Object.fromEntries(
        roles.map((role) => [role, expand(palette[role])])
      );
      return { ...expanded, any: roles.flatMap((role) => expanded[role]) };
    },
    families = { neutral: byRole(neutralPalette) },
    accent = expand(accentPalette),
    teal = expand({ pairs: tealPairs });
  families.accent = { ...families.neutral, any: accent };
  for (const role of roles) families.accent[role] = accent;
  families.teal = { any: teal };
  for (const role of roles) families.teal[role] = teal;
  for (const [colour] of colours) families[colour] = byRole(colourPalette(colour));
  return { families, accent };
};

const withAlpha = (css, alpha) =>
    alpha >= 0.995
      ? css
      : `color-mix(in srgb,${css} ${+(alpha * 100).toFixed(1)}%,transparent)`,
  // variables named after a colour are matched against that colour's
  // --theme--* variables. unnamed variables are matched against the
  // neutral palette unless they are visibly coloured themselves
  poolFor = (rgba, { family, role = "any" }, { families, accent }, background) => {
    const neutral = families.neutral[role],
      // faint tints are judged by how they look over the background
      visible = mix(rgba, background, rgba[3]);
    if (family) {
      // notion's blues and reds double as its interface accent colours
      const accented = ["blue", "red", "accent"].includes(family) ? accent : [];
      return [...new Set([...families[family][role], ...neutral, ...accented])];
    }
    if (chroma(visible) < NEUTRAL_CHROMA) return neutral;
    return [
      ...Object.values(families).flatMap((palette) => palette[role]),
      ...accent,
    ];
  },
  closest = (pool, score) => {
    let best, bestScore = Infinity;
    for (const candidate of pool) {
      const candidateScore = score(candidate);
      if (candidateScore < bestScore) [best, bestScore] = [candidate, candidateScore];
    }
    return [best, bestScore];
  },
  // finds the theme expression closest to a colour, ignoring its
  // opacity (which is then reapplied to the expression exactly)
  fitOpaque = (rgba, pool, maxDistance) => {
    const [best, score] = closest(
      pool,
      (candidate) => distance(rgba, candidate.rgba) + candidate.cost
    );
    return score <= maxDistance ? withAlpha(best.css, rgba[3]) : null;
  },
  // translucent colours are often more saturated than any opaque theme
  // colour: finds the expression and opacity that look closest to the
  // colour once both are layered over the primary background
  fitLayered = (rgba, pool, background, maxDistance) => {
    const target = mix(rgba, background, rgba[3]);
    let best, bestScore = Infinity;
    for (let alpha = ALPHA_STEP; alpha <= 1; alpha += ALPHA_STEP) {
      const [candidate, score] = closest(
        pool,
        (candidate) =>
          distance(target, mix(candidate.rgba, background, alpha)) +
          candidate.cost +
          // stay close to the original opacity where possible
          Math.abs(alpha - rgba[3]) * ALPHA_PENALTY
      );
      if (score < bestScore) [best, bestScore] = [withAlpha(candidate.css, alpha), score];
    }
    return bestScore <= maxDistance ? best : null;
  },
  fit = (rgba, usage, candidates, background, { exact, loose }) => {
    if (rgba[3] === 0) return null;
    const pool = poolFor(rgba, usage, candidates, background),
      expression = fitOpaque(rgba, pool, exact);
    if (expression || rgba[3] >= 0.995) return expression ?? fitOpaque(rgba, pool, loose);
    return fitLayered(rgba, pool, background, loose) ?? fitOpaque(rgba, pool, loose);
  };

const colourPattern = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi,
  mapVariables = (notion, theme, anchored) => {
    const candidates = buildCandidates(theme),
      mapped = {},
      skipped = [];
    for (const [name, value] of Object.entries(notion)) {
      if (anchored[name]) {
        mapped[name] = `var(--theme--${anchored[name]})`;
        continue;
      }
      const family = familyOf(name),
        usage = { family, role: roleOf(name) },
        isSingle = parseColour(value) !== null,
        loose = family ? MAX_DISTANCE_FAMILY : MAX_DISTANCE,
        limits = isSingle
          ? { exact: MAX_DISTANCE_EXACT, loose }
          : { exact: MAX_DISTANCE_COMPOSITE, loose: MAX_DISTANCE_COMPOSITE };
      let replaced = 0;
      const css = value.replace(colourPattern, (colour) => {
        const rgba = parseColour(colour),
          expression =
            rgba && fit(rgba, usage, candidates, theme["bg-primary"], limits);
        if (expression) replaced++;
        return expression ?? colour;
      });
      if (replaced) mapped[name] = css;
      else if (colourPattern.test(value)) skipped.push(name);
      colourPattern.lastIndex = 0;
    }
    return { mapped, skipped };
  };

const block = (selector, declarations) =>
    `${selector}{${Object.entries(declarations)
      .map(([name, value]) => `${name}:${value}`)
      .join(";")}}`,
  generate = async (files) => {
    const variables = parseVariables(await readNotionStyles(files)),
      light = variables[LIGHT_SELECTOR],
      // variables not redefined for dark mode keep their light mode value
      dark = { ...light, ...variables[DARK_SELECTOR] };
    if (!light || !variables[DARK_SELECTOR]) {
      throw new Error("notion's theme variables could not be found");
    }

    const root = new URL("../src/core/", import.meta.url),
      variablesPath = fileURLToPath(new URL("variables.css", root)),
      themePath = fileURLToPath(new URL("theme.css", root)),
      staticPath = fileURLToPath(new URL("theme.static.css", root));
    let variablesCss = await fsp.readFile(variablesPath, "utf-8");
    const themeCss = [],
      report = {};
    for (const [mode, notion, selector] of [
      ["dark", dark, "body.dark"],
      ["light", light, "body:not(.dark)"],
    ]) {
      const theme = {},
        anchored = {};
      for (const [key, name] of Object.entries(anchors)) {
        theme[key] = parseColour(notion[name]);
        if (!theme[key]) throw new Error(`${name} is not a colour (${mode})`);
        // the first --theme--* variable anchored to a notion variable owns it
        anchored[name] ??= key;
        // update the default value of the --theme--* variable
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          declaration = new RegExp(
            `(${escaped}\\s*\\{[^}]*?--theme--${key}:)[^;}]*`
          );
        if (!declaration.test(variablesCss)) {
          throw new Error(`--theme--${key} is missing from ${selector}`);
        }
        variablesCss = variablesCss.replace(declaration, `$1${toHex(theme[key])}`);
      }
      const { mapped, skipped } = mapVariables(notion, theme, anchored),
        // nested elements may opt in to a mode explicitly
        nested = `${selector} .notion-${mode}-theme`;
      themeCss.push(block(`${selector},${nested}`, mapped));
      report[mode] = {
        variables: Object.keys(notion).length,
        mapped: Object.keys(mapped).length,
        skipped,
      };
    }
    // rules that cannot be expressed through notion's variables
    themeCss.push((await fsp.readFile(staticPath, "utf-8")).trim());
    await fsp.writeFile(variablesPath, variablesCss);
    await fsp.writeFile(themePath, themeCss.join("\n") + "\n");
    return report;
  };

const report = await generate(process.argv.slice(2));
for (const [mode, { variables, mapped, skipped }] of Object.entries(report)) {
  console.log(`${mode}: mapped ${mapped} of ${variables} notion variables`);
  if (skipped.length) console.log(`  left as-is: ${skipped.join(" ")}`);
}
