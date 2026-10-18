import type { Page } from "playwright";
import type { Assertion } from "../project/schema.js";
import { resolveLocator } from "./actions.js";

export async function checkAssertion(page: Page, a: Assertion): Promise<boolean> {
  if ("url" in a) return new RegExp(a.url).test(page.url());
  if ("text" in a) return (await page.getByText(a.text).filter({ visible: true }).count()) > 0;
  if ("visible" in a) return (await resolveLocator(page, a.visible).filter({ visible: true }).count()) > 0;
  return (await resolveLocator(page, a.hidden).filter({ visible: true }).count()) === 0;
}

/** Poll until every assertion holds, or report the ones that never did. */
export async function waitForAssertions(
  page: Page,
  expect: Assertion[],
  timeoutMs: number,
): Promise<{ passed: boolean; failed: Assertion[] }> {
  const deadline = Date.now() + timeoutMs;
  let failed = expect;
  while (true) {
    const results = await Promise.all(failed.map((a) => checkAssertion(page, a).catch(() => false)));
    failed = failed.filter((_, i) => !results[i]);
    if (failed.length === 0) return { passed: true, failed };
    if (Date.now() > deadline) return { passed: false, failed };
    await page.waitForTimeout(150);
  }
}

/**
 * Wait for a settled page: network quiet (best effort), fonts loaded, and a
 * layout signature unchanged across consecutive animation frames.
 */
export async function waitForStable(page: Page, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(2000, timeoutMs) }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  let last = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    const sig = await page
      .evaluate(
        () =>
          new Promise<string>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const els = document.body ? document.body.getElementsByTagName("*") : [];
                const sample: number[] = [];
                const step = Math.max(1, Math.floor(els.length / 200));
                for (let i = 0; i < els.length; i += step) {
                  const r = (els[i] as Element).getBoundingClientRect();
                  sample.push(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
                }
                resolve(`${els.length}:${document.documentElement.scrollHeight}:${sample.join(",")}`);
              }),
            ),
          ),
      )
      .catch(() => "");
    stableCount = sig && sig === last ? stableCount + 1 : 0;
    if (stableCount >= 2) return true;
    last = sig;
    await page.waitForTimeout(80);
  }
  return false;
}
