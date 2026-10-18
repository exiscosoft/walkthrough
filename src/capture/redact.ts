import type { Frame, Page } from "playwright";
import sharp from "sharp";
import type { ProjectConfig, Redaction } from "../project/schema.js";
import { scaleRect, type Rect } from "../util.js";

interface FoundBox {
  rect: Rect; // CSS pixels, viewport-relative
  reason: Redaction["reason"];
  detail: string;
  confidence: Redaction["confidence"];
  value: string;
}

/**
 * Scan one frame for sensitive regions, including open shadow roots. Runs in the page.
 * Rects are relative to that frame's viewport. Field values come back only so evidence
 * text can be scrubbed; they are never persisted. (Closed shadow roots are unreachable.)
 */
function scanFrame({ selectors, allow, heuristics }: { selectors: string[]; allow: string[]; heuristics: boolean }): FoundBox[] {
  const out: FoundBox[] = [];
  const seen = new Set<Element>();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const roots: (Document | ShadowRoot)[] = [document];
  const collect = (root: Document | ShadowRoot) => {
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        collect(el.shadowRoot);
      }
    });
  };
  collect(document);
  const all = (sel: string) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
  const visibleRect = (r: DOMRect) => {
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(vw, r.right) - x;
    const h = Math.min(vh, r.bottom) - y;
    return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
  };
  const valueOf = (el: Element) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? "").trim();
  const describe = (el: Element) =>
    el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : "");
  const add = (el: Element, reason: FoundBox["reason"], confidence: FoundBox["confidence"]) => {
    if (seen.has(el)) return;
    const rect = visibleRect(el.getBoundingClientRect());
    if (!rect) return;
    seen.add(el);
    out.push({ rect, reason, detail: describe(el), confidence, value: valueOf(el) });
  };
  const allowed = (el: Element) => allow.some((sel) => el.matches(sel));

  all('input[type="password"]').forEach((el) => add(el, "password", "high"));
  for (const sel of selectors) all(sel).forEach((el) => add(el, "selector", "high"));
  if (!heuristics) return out;

  const fieldPattern = /token|secret|api[-_]?key|ssn|social|card|cvv|cvc|iban|account[-_]?number|otp/i;
  all("input, textarea").forEach((el) => {
    if (allowed(el)) return;
    const ac = el.getAttribute("autocomplete") ?? "";
    const type = el.getAttribute("type") ?? "";
    const key = `${el.getAttribute("name") ?? ""} ${el.id} ${el.getAttribute("aria-label") ?? ""}`;
    if (/^cc-|one-time-code/.test(ac) || fieldPattern.test(key) || type === "email" || type === "tel") add(el, "heuristic", "low");
  });
  const tokenText = /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}|\b[A-Fa-f0-9]{32,}\b/g;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || allowed(parent) || seen.has(parent)) continue;
      // Every match in the node, not just the first.
      for (const m of (n.textContent ?? "").matchAll(tokenText)) {
        const range = document.createRange();
        range.setStart(n, m.index!);
        range.setEnd(n, m.index! + m[0].length);
        const rect = visibleRect(range.getBoundingClientRect());
        if (rect) out.push({ rect, reason: "heuristic", detail: "token-like text", confidence: "low", value: m[0] });
      }
    }
  }
  return out;
}

/** Content-box origin of a frame in main-viewport CSS pixels. */
async function frameOrigin(frame: Frame): Promise<{ x: number; y: number } | null> {
  const parent = frame.parentFrame();
  if (!parent) return { x: 0, y: 0 };
  const base = await frameOrigin(parent);
  const el = await frame.frameElement().catch(() => null);
  if (!base || !el) return null;
  const o = await el.evaluate((node) => {
    const f = node as Element;
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    return { x: r.left + f.clientLeft + parseFloat(cs.paddingLeft), y: r.top + f.clientTop + parseFloat(cs.paddingTop) };
  });
  return { x: base.x + o.x, y: base.y + o.y };
}

/**
 * Sensitive regions across the main frame and every child frame. A frame that can't be
 * inspected (e.g. it is mid-navigation) is masked whole rather than trusted.
 */
async function findSensitive(page: Page, cfg: ProjectConfig["redaction"]): Promise<FoundBox[]> {
  const arg = { selectors: cfg.selectors, allow: cfg.allow, heuristics: cfg.heuristics };
  const out: FoundBox[] = [];
  for (const frame of page.frames()) {
    const origin = await frameOrigin(frame).catch(() => null);
    try {
      if (!origin) throw new Error("frame not positioned");
      for (const b of await frame.evaluate(scanFrame, arg)) {
        out.push({ ...b, rect: { ...b.rect, x: b.rect.x + origin.x, y: b.rect.y + origin.y } });
      }
    } catch {
      const box = await (await frame.frameElement().catch(() => null))?.boundingBox().catch(() => null);
      if (box) out.push({ rect: box, reason: "heuristic", detail: `iframe ${frame.url()} (not inspectable)`, confidence: "low", value: "" });
    }
  }
  return out;
}

/** Jump finite animations to their end and cancel infinite ones, as the screenshot will, so boxes don't move after measuring. */
async function freezeAnimations(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        // Document.getAnimations covers shadow-including descendants.
        for (const a of document.getAnimations()) {
          try {
            a.finish();
          } catch {
            a.cancel();
          }
        }
      })
      .catch(() => {});
  }
}

const PAD = 4; // CSS px around each masked box

/** Paint opaque masks over sensitive regions. The caller never writes the unmasked buffer. */
export async function maskPng(png: Buffer, rects: Rect[]): Promise<Buffer> {
  if (rects.length === 0) return png;
  const meta = await sharp(png).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const shapes = rects
    .map((r) => {
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      const w = Math.min(W - x, Math.ceil(r.width));
      const h = Math.min(H - y, Math.ceil(r.height));
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#3A3F4B"/>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="url(#hatch)"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="7" height="14" fill="#4A505E"/></pattern></defs>${shapes}</svg>`;
  return sharp(png).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

export interface RedactedShot {
  png: Buffer;
  redactions: Omit<Redaction, "id" | "confirmed">[];
  scrub: string[];
}

/**
 * Screenshot the viewport with sensitive regions already masked. Boxes are measured
 * before and after the screenshot and both are masked, so anything that moved anyway
 * is still covered.
 */
export async function redactedScreenshot(page: Page, project: ProjectConfig, extraScrub: string[]): Promise<RedactedShot> {
  await freezeAnimations(page);
  const before = await findSensitive(page, project.redaction);
  const raw = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "device" });
  const after = await findSensitive(page, project.redaction);
  const key = (f: FoundBox) => `${f.detail}|${Math.round(f.rect.x)},${Math.round(f.rect.y)},${Math.round(f.rect.width)},${Math.round(f.rect.height)}`;
  const found = [...new Map([...before, ...after].map((f) => [key(f), f])).values()];
  const k = project.viewport.deviceScaleFactor;
  const pxRects = found.map((f) => scaleRect({ x: f.rect.x - PAD, y: f.rect.y - PAD, width: f.rect.width + 2 * PAD, height: f.rect.height + 2 * PAD }, k));
  const png = await maskPng(raw, pxRects);
  // Wipe the unmasked pixels from memory; with nothing to mask, raw *is* the result.
  if (png !== raw) raw.fill(0);
  return {
    png,
    redactions: found.map((f, i) => ({ rect: pxRects[i]!, reason: f.reason, detail: f.detail, confidence: f.confidence })),
    scrub: [...extraScrub, ...found.map((f) => f.value)].filter((v) => v && v.length >= 3),
  };
}

/** Replace every scrub value in text. Longest first so substrings don't leave fragments. */
export function scrubText(text: string, scrub: string[]): string {
  let out = text;
  for (const v of [...new Set(scrub)].sort((a, b) => b.length - a.length)) out = out.split(v).join("[redacted]");
  return out;
}
