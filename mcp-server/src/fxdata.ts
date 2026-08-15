export interface EffectInfo {
  raw: string;
  sliders: { key: string; label: string }[];
  checkboxes: { key: string; label: string }[];
  colors: string[];
  paletteEnabled: boolean;
  flags: { oneD: boolean; twoD: boolean; audioVolume: boolean; audioFrequency: boolean };
  defaults: Record<string, string>;
}

const SLIDER_KEYS = ["sx", "ix", "c1", "c2", "c3"];
const SLIDER_DEFAULT_LABELS = ["Effect speed", "Effect intensity", "Custom 1", "Custom 2", "Custom 3"];
const CHECKBOX_KEYS = ["o1", "o2", "o3"];
const CHECKBOX_DEFAULT_LABELS = ["Option 1", "Option 2", "Option 3"];
const COLOR_DEFAULT_LABELS = ["Fx", "Bg", "Cs"];

export function parseFxData(raw: string): EffectInfo {
  const [paramsPart = "", colorsPart = "", palettePart = "", flagsPart = "", defaultsPart = ""] = raw.split(";");
  const paramEntries = paramsPart.split(",");

  const sliders: { key: string; label: string }[] = [];
  const checkboxes: { key: string; label: string }[] = [];

  paramEntries.forEach((entry, i) => {
    const trimmed = entry.trim();
    if (i < SLIDER_KEYS.length) {
      if (trimmed === "") return;
      sliders.push({ key: SLIDER_KEYS[i], label: trimmed === "!" ? SLIDER_DEFAULT_LABELS[i] : trimmed });
    } else {
      const j = i - SLIDER_KEYS.length;
      if (j >= CHECKBOX_KEYS.length || trimmed === "") return;
      checkboxes.push({ key: CHECKBOX_KEYS[j], label: trimmed === "!" ? CHECKBOX_DEFAULT_LABELS[j] : trimmed });
    }
  });

  const colors = colorsPart
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "")
    .map((c, i) => (c === "!" ? COLOR_DEFAULT_LABELS[i] ?? `Color ${i + 1}` : c));

  const paletteEnabled = palettePart.trim() === "!";

  const flags = {
    oneD: flagsPart.includes("1"),
    twoD: flagsPart.includes("2"),
    audioVolume: flagsPart.includes("v"),
    audioFrequency: flagsPart.includes("f"),
  };

  const defaults: Record<string, string> = {};
  defaultsPart
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [k, v] = pair.split("=");
      if (k && v !== undefined) defaults[k.trim()] = v.trim();
    });

  return { raw, sliders, checkboxes, colors, paletteEnabled, flags, defaults };
}
