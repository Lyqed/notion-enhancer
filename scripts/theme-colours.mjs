/**
 * notion-enhancer
 * (c) 2024 dragonwocky <thedragonring.bod@gmail.com> (https://dragonwocky.me/)
 * (https://notion-enhancer.github.io/) under the MIT license
 */

// colour helpers for scripts/generate-theme-css.mjs.
// colours are [r, g, b, a] with channels 0-255 and alpha 0-1

const namedColours = { white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

// parses a value that is exactly one hex, rgb() or rgba() colour
const parseColour = (value) => {
  value = value?.trim().toLowerCase() ?? "";
  if (namedColours[value]) return [...namedColours[value]];
  const hex = value.match(/^#([0-9a-f]{3,8})$/)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const digits = hex.length < 6 ? [...hex].map((c) => c + c).join("") : hex,
      channel = (i) => parseInt(digits.slice(i, i + 2), 16);
    return [
      channel(0),
      channel(2),
      channel(4),
      digits.length === 8 ? channel(6) / 255 : 1,
    ];
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return null;
};

const toHex = ([r, g, b, a]) => {
  const pair = (n) => Math.round(n).toString(16).padStart(2, "0"),
    alpha = a >= 0.995 ? "" : pair(a * 255);
  return `#${pair(r)}${pair(g)}${pair(b)}${alpha}`;
};

// equivalent to color-mix(in srgb, a <ratio>, b) for opaque colours
const mix = (a, b, ratio) => [
  a[0] * ratio + b[0] * (1 - ratio),
  a[1] * ratio + b[1] * (1 - ratio),
  a[2] * ratio + b[2] * (1 - ratio),
  1,
];

const toLinear = (channel) => {
    channel /= 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  },
  // https://bottosson.github.io/posts/oklab/
  toOklab = ([r, g, b]) => {
    [r, g, b] = [toLinear(r), toLinear(g), toLinear(b)];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
      m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
      s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  },
  // perceptual distance between two colours, ignoring opacity
  distance = (a, b) => {
    const [l1, a1, b1] = toOklab(a),
      [l2, a2, b2] = toOklab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };

// how colourful a colour is: 0 for greys, ~0.3 for vivid colours
const chroma = (colour) => {
  const [, a, b] = toOklab(colour);
  return Math.hypot(a, b);
};

export { parseColour, toHex, mix, distance, chroma };
