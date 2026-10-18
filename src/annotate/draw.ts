import type { Annotation, ProjectConfig } from "../project/schema.js";
import { escapeXml as esc } from "../util.js";

/**
 * Annotation layer as SVG in screenshot pixels. Highlights combine a dimmed
 * surround, a thick two-tone outline and a numbered badge so they never rely on colour alone.
 */
export function overlaySvg(
  annotations: Annotation[],
  frame: { width: number; height: number },
  brand: ProjectConfig["brand"],
  scale: number,
  alpha = 1,
): string {
  const parts: string[] = [];
  const r = 8 * scale;
  for (const a of annotations) {
    const { x, y, width: w, height: h } = a.rect;
    if (a.kind === "spotlight") {
      const hole = `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - 2 * r} a${r},${r} 0 0 1 -${r},-${r} v-${h - 2 * r} a${r},${r} 0 0 1 ${r},-${r} z`;
      parts.push(`<path d="M0,0 H${frame.width} V${frame.height} H0 Z ${hole}" fill="#0B1020" fill-opacity="0.42" fill-rule="evenodd"/>`);
    } else if (a.kind === "outline") {
      const sw = 3 * scale;
      parts.push(
        `<rect x="${x - sw / 2}" y="${y - sw / 2}" width="${w + sw}" height="${h + sw}" rx="${r + sw / 2}" fill="none" stroke="#0B1020" stroke-opacity="0.85" stroke-width="${sw + 2 * scale}"/>`,
        `<rect x="${x - sw / 2}" y="${y - sw / 2}" width="${w + sw}" height="${h + sw}" rx="${r + sw / 2}" fill="none" stroke="${esc(brand.accent)}" stroke-width="${sw}"/>`,
      );
    } else if (a.kind === "callout") {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rad = Math.min(w, h) / 2;
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${esc(brand.primary)}" stroke="#FFFFFF" stroke-width="${2 * scale}"/>`,
        `<text x="${cx}" y="${cy}" dy="0.35em" text-anchor="middle" font-family="${esc(brand.font)}" font-weight="700" font-size="${rad * 1.15}" fill="#FFFFFF">${esc(a.label ?? "")}</text>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}"><g opacity="${alpha}">${parts.join("")}</g></svg>`;
}

/** Title or closing card in output pixels. */
export function cardSvg(width: number, height: number, brand: ProjectConfig["brand"], eyebrow: string, title: string, subtitle?: string): string {
  const wrapLines = (text: string, max: number) => {
    const lines: string[] = [];
    let cur = "";
    for (const w of text.split(/\s+/)) {
      if ((cur + " " + w).trim().length > max && cur) {
        lines.push(cur);
        cur = w;
      } else cur = (cur + " " + w).trim();
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const titleLines = wrapLines(title, 34);
  const ty = height / 2 - ((titleLines.length - 1) * 84) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${esc(brand.background)}"/>
  <rect x="160" y="${ty - 150}" width="96" height="10" rx="5" fill="${esc(brand.accent)}"/>
  <text x="160" y="${ty - 90}" font-family="${esc(brand.font)}" font-size="34" font-weight="600" letter-spacing="2" fill="${esc(brand.accent)}">${esc(eyebrow.toUpperCase())}</text>
  ${titleLines.map((l, i) => `<text x="160" y="${ty + i * 84}" font-family="${esc(brand.font)}" font-size="72" font-weight="700" fill="${esc(brand.text)}">${esc(l)}</text>`).join("\n  ")}
  ${subtitle ? `<text x="160" y="${ty + titleLines.length * 84 + 30}" font-family="${esc(brand.font)}" font-size="34" fill="${esc(brand.text)}" fill-opacity="0.75">${esc(subtitle)}</text>` : ""}
  <text x="160" y="${height - 90}" font-family="${esc(brand.font)}" font-size="28" font-weight="600" fill="${esc(brand.text)}" fill-opacity="0.6">${esc(brand.name)}</text>
</svg>`;
}

export function watermarkSvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="${width - 330}" y="36" width="290" height="70" rx="12" fill="#B3261E" fill-opacity="0.9"/>
  <text x="${width - 185}" y="83" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="800" letter-spacing="4" fill="#FFFFFF">PREVIEW</text>
</svg>`;
}
