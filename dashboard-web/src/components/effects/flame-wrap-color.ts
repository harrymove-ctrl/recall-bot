// dashboard-web/src/components/effects/flame-wrap-color.ts
const FALLBACK_COLOR: [number, number, number] = [1, 0.42, 0.1]; // warm amber, used only if parsing fails

function hexToRgb01(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) {
    value = value.split("").map((c) => c + c).join("");
  }
  const num = Number.parseInt(value, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

export function resolveFlameColor(color: string | [number, number, number]): [number, number, number] {
  if (Array.isArray(color)) return color;
  const parsed = hexToRgb01(color);
  if (parsed) return parsed;
  console.warn(`FlameWrap: could not parse color "${color}" as hex — falling back to a default.`);
  return FALLBACK_COLOR;
}
