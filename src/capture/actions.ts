import type { Locator as PwLocator, Page } from "playwright";
import type { Action, Flow, Locator } from "../project/schema.js";
import { WalkError } from "../util.js";

export function resolveLocator(page: Page, loc: Locator): PwLocator {
  if ("role" in loc) {
    return page.getByRole(loc.role as Parameters<Page["getByRole"]>[0], { name: loc.name, exact: loc.exact });
  }
  if ("label" in loc) return page.getByLabel(loc.label, { exact: loc.exact });
  if ("text" in loc) return page.getByText(loc.text, { exact: loc.exact });
  if ("testId" in loc) return page.getByTestId(loc.testId);
  return page.locator(loc.css);
}

export function describeLocator(loc: Locator): string {
  if ("role" in loc) return `${loc.role}${loc.name ? ` "${loc.name}"` : ""}`;
  if ("label" in loc) return `field labelled "${loc.label}"`;
  if ("text" in loc) return `text "${loc.text}"`;
  if ("testId" in loc) return `test id "${loc.testId}"`;
  return `css ${loc.css}`;
}

/** Names quoted in a Playwright aria snapshot, e.g. `- button "Accept invitation"`. */
export function snapshotNames(snapshot: string): string[] {
  const names = new Set<string>();
  for (const m of snapshot.matchAll(/^\s*-\s+[\w-]+\s+"((?:[^"\\]|\\.)*)"/gm)) names.add(m[1]!.replace(/\\"/g, '"'));
  for (const m of snapshot.matchAll(/^\s*-\s+(?:text|heading[^:]*|paragraph):\s*(.+)$/gm)) {
    const t = m[1]!.trim().replace(/^"|"$/g, "");
    if (t.length <= 80) names.add(t);
  }
  return [...names];
}

function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(1, Math.min(ta.size, tb.size));
}

export interface ResolvedTarget {
  locator: PwLocator;
  role?: string;
  name?: string;
}

/** Find exactly one visible element, or pause with an actionable error. Never guesses. */
export async function findTarget(page: Page, loc: Locator, stepId: string, timeoutMs: number): Promise<ResolvedTarget> {
  const all = resolveLocator(page, loc).filter({ visible: true });
  try {
    await all.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    const wanted = "role" in loc ? (loc.name ?? loc.role) : "label" in loc ? loc.label : "text" in loc ? loc.text : "";
    const snap = await page.locator("body").ariaSnapshot().catch(() => "");
    let near = snapshotNames(snap)
      .map((n) => ({ n, s: similarity(n, wanted) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => `"${x.n}"`);
    if (near.length === 0 && "role" in loc) {
      const sameRole = new RegExp(`^\\s*-\\s+${loc.role}\\s+"((?:[^"\\\\]|\\\\.)*)"`, "gm");
      near = [...snap.matchAll(sameRole)].slice(0, 5).map((x) => `${loc.role} "${x[1]}"`);
    }
    throw new WalkError(
      "LOCATOR_NOT_FOUND",
      `Step "${stepId}": no visible ${describeLocator(loc)} on ${page.url()}`,
      near.length
        ? `The interface may have changed. Similar labels on the page: ${near.join(", ")}. Update the step's target in flow.yaml.`
        : "The interface may have changed or the page did not load. Check the page and update flow.yaml.",
      true,
    );
  }
  const count = await all.count();
  if (count > 1) {
    throw new WalkError(
      "AMBIGUOUS_LOCATOR",
      `Step "${stepId}": ${count} visible elements match ${describeLocator(loc)}`,
      "Make the locator more specific (exact: true, a role plus name, or a test id).",
      true,
    );
  }
  const locator = all.first();
  const snap = await locator.ariaSnapshot().catch(() => "");
  const m = /^\s*-\s+([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(snap);
  return { locator, role: m?.[1], name: m?.[2] ?? ("name" in loc ? loc.name : undefined) };
}

export interface ResolvedValue {
  value: string;
  sensitive: boolean;
}

/** Expand `${testData.key}` references. Values may come from the environment so secrets stay out of flow.yaml. */
export function resolveValue(template: string, flow: Flow): ResolvedValue {
  let sensitive = false;
  const value = template.replace(/\$\{testData\.([\w-]+)\}/g, (_m, key: string) => {
    const entry = flow.testData[key];
    if (entry === undefined) throw new WalkError("TEST_DATA_MISSING", `testData.${key} is not defined in flow.yaml`);
    if (typeof entry === "string") return entry;
    sensitive ||= entry.sensitive;
    const v = entry.env ? process.env[entry.env] : entry.value;
    if (v === undefined) {
      throw new WalkError("TEST_DATA_MISSING", `testData.${key} has no value`, entry.env ? `Set ${entry.env} in the environment.` : undefined);
    }
    return v;
  });
  return { value, sensitive };
}

/** Every value marked sensitive in testData, for scrubbing evidence text. */
export function sensitiveValues(flow: Flow): string[] {
  return Object.values(flow.testData).flatMap((e) => {
    if (typeof e === "string" || !e.sensitive) return [];
    const v = e.env ? process.env[e.env] : e.value;
    return v ? [v] : [];
  });
}

/** Relative URLs resolve against the current page, or against the project's start URL on a fresh tab. */
export function resolveUrl(url: string, current: string, startUrl: string): string {
  return new URL(url, current === "about:blank" || !current ? startUrl : current).toString();
}

export async function performAction(
  page: Page,
  action: Action,
  flow: Flow,
  target: PwLocator | undefined,
  startUrl: string,
): Promise<ResolvedValue | undefined> {
  switch (action.type) {
    case "goto": {
      const r = resolveValue(action.url, flow);
      await page.goto(resolveUrl(r.value, page.url(), startUrl), { waitUntil: "domcontentloaded" });
      return undefined;
    }
    case "click":
      await target!.click();
      return undefined;
    case "fill": {
      const r = resolveValue(action.value, flow);
      await target!.fill(r.value);
      const isPassword = (await target!.getAttribute("type")) === "password";
      return { ...r, sensitive: r.sensitive || isPassword };
    }
    case "select": {
      const r = resolveValue(action.option, flow);
      // Match by visible label when one exists, else by value, without waiting on a failed attempt.
      const byLabel = await target!.evaluate(
        (el, want) => el instanceof HTMLSelectElement && [...el.options].some((o) => o.label === want || o.text.trim() === want),
        r.value,
      );
      await target!.selectOption(byLabel ? { label: r.value } : r.value);
      return r;
    }
    case "check":
      await target!.setChecked(action.checked);
      return undefined;
    case "scroll":
      if (target) await target.scrollIntoViewIfNeeded();
      else await page.mouse.wheel(0, action.y ?? 600);
      return undefined;
    case "observe":
    case "manual":
      return undefined;
  }
}
