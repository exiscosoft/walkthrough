import type { Annotation } from "../project/schema.js";
import { clamp, contains, intersects, padRect, WalkError, type Rect } from "../util.js";

/** Smallest zoom window, as a fraction of frame width, so UI text stays legible. */
export const MIN_CROP_FRACTION = 0.6;

export function badgeSize(scale: number): number {
  return Math.round(30 * scale);
}

/** Place a numbered badge just outside the outline, at the first corner that doesn't cover the target. */
export function placeBadge(target: Rect, outline: Rect, frame: { width: number; height: number }, d: number): Rect {
  const off = d * 0.55;
  const gap = 8;
  const midY = outline.y + outline.height / 2 - d / 2;
  const candidates = [
    // Straddling a corner of the outline, then fully outside each side.
    { x: outline.x - off, y: outline.y - off },
    { x: outline.x + outline.width - d + off, y: outline.y - off },
    { x: outline.x - off, y: outline.y + outline.height - d + off },
    { x: outline.x + outline.width - d + off, y: outline.y + outline.height - d + off },
    { x: outline.x - d - gap, y: midY },
    { x: outline.x + outline.width + gap, y: midY },
    { x: outline.x, y: outline.y + outline.height + gap },
    { x: outline.x, y: outline.y - d - gap },
  ];
  for (const c of candidates) {
    const r = { x: clamp(c.x, 0, frame.width - d), y: clamp(c.y, 0, frame.height - d), width: d, height: d };
    if (!intersects(r, target)) return r;
  }
  return { x: clamp(outline.x, 0, frame.width - d), y: clamp(outline.y - d - 6, 0, frame.height - d), width: d, height: d };
}

export function suggestAnnotations(target: Rect, frame: { width: number; height: number }, ordinal: number, scale: number): Annotation[] {
  const outline = padRect(target, 8 * scale);
  return [
    { id: "spotlight", kind: "spotlight", rect: outline },
    { id: "outline", kind: "outline", rect: outline },
    { id: "callout", kind: "callout", rect: placeBadge(target, outline, frame, badgeSize(scale)), label: String(ordinal) },
  ];
}

/**
 * 16:9 zoom window around the target (and its annotations), never narrower than
 * MIN_CROP_FRACTION of the frame and always containing the target. Null means full frame.
 */
export function suggestCrop(focus: Rect, frame: { width: number; height: number }): Rect | null {
  const aspect = frame.width / frame.height;
  let w = Math.max(frame.width * MIN_CROP_FRACTION, focus.width * 1.4, focus.height * 3 * aspect);
  if (w >= frame.width * 0.92) return null;
  let h = w / aspect;
  if (h > frame.height) {
    h = frame.height;
    w = h * aspect;
  }
  const cx = focus.x + focus.width / 2;
  const cy = focus.y + focus.height / 2;
  const crop = {
    x: Math.round(clamp(cx - w / 2, 0, frame.width - w)),
    y: Math.round(clamp(cy - h / 2, 0, frame.height - h)),
    width: Math.round(w),
    height: Math.round(h),
  };
  return contains(crop, focus) ? crop : null;
}

/** Union of rects, used as the region a crop must keep visible. */
export function unionRect(rects: Rect[]): Rect {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Make a requested zoom window renderable: it must lie inside the frame, and it is grown
 * (never shrunk) to the frame's aspect ratio around its centre so nothing asked for is cut.
 * Returns null when the result would be the whole frame.
 */
export function normalizeCrop(crop: Rect, frame: { width: number; height: number }): Rect | null {
  if (crop.width <= 0 || crop.height <= 0 || crop.x < 0 || crop.y < 0 || crop.x + crop.width > frame.width || crop.y + crop.height > frame.height) {
    throw new WalkError(
      "CROP_OUT_OF_FRAME",
      `Crop ${crop.x},${crop.y},${crop.width},${crop.height} is outside the ${frame.width}x${frame.height} screenshot`,
      "Give x,y,width,height in screenshot pixels inside the frame, or use --crop auto.",
    );
  }
  const aspect = frame.width / frame.height;
  const w = Math.max(crop.width, crop.height * aspect);
  const h = w / aspect;
  if (w >= frame.width || h >= frame.height) return null;
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  return {
    x: Math.round(clamp(cx - w / 2, 0, frame.width - w)),
    y: Math.round(clamp(cy - h / 2, 0, frame.height - h)),
    width: Math.round(w),
    height: Math.round(h),
  };
}
