import type { BrowserContext, Page } from "playwright";
import type { Flow, FlowStep } from "../project/schema.js";
import { WalkError } from "../util.js";
import { checkAssertion } from "./stability.js";

export interface GuardEvents {
  violations: string[];
  dialogs: { type: string; message: string }[];
  externalHosts: Set<string>;
}

/** Entries are hostnames, optionally with a port, optionally with a leading "*." wildcard. */
export function hostAllowed(url: string, permitted: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return true;
  return permitted.some((entry) => {
    const [host, port] = entry.toLowerCase().split(":");
    if (port && u.port !== port) return false;
    const h = u.hostname.toLowerCase();
    return host!.startsWith("*.") ? h === host!.slice(2) || h.endsWith(host!.slice(1)) : h === host;
  });
}

export async function installGuards(context: BrowserContext, page: Page, flow: Flow): Promise<GuardEvents> {
  const events: GuardEvents = { violations: [], dialogs: [], externalHosts: new Set() };
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (hostAllowed(url, flow.permittedDomains)) return route.continue();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      events.violations.push(url);
      return route.abort("blockedbyclient");
    }
    // Sub-resources (fonts, CDNs) are recorded, not blocked, so pages still render.
    events.externalHosts.add(new URL(url).host);
    return route.continue();
  });
  // Route interception doesn't see redirect follow-ups, so also check where the main frame actually landed.
  page.on("framenavigated", (frame) => {
    const url = frame.url();
    if (frame === page.mainFrame() && !hostAllowed(url, flow.permittedDomains) && !events.violations.includes(url)) {
      events.violations.push(url);
    }
  });
  page.on("dialog", (dialog) => {
    events.dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.dismiss().catch(() => {});
  });
  return events;
}

const RISKY_LABEL =
  /\b(delete|remove|send|purchase|buy|pay|checkout|place order|transfer|revoke|grant|permissions?|publish|deactivate|archive|unsubscribe)\b/i;

/** Mutating if declared, or if the visible label of the clicked control looks destructive or outbound. */
export function isMutating(step: FlowStep, resolvedName?: string): boolean {
  if (step.sideEffect === "mutating") return true;
  if (step.action.type !== "click") return false;
  const t = step.action.target;
  const declared = "name" in t ? t.name : "text" in t ? t.text : undefined;
  return RISKY_LABEL.test(`${declared ?? ""} ${resolvedName ?? ""}`);
}

export function assertMutationAllowed(step: FlowStep, resolvedName?: string): void {
  if (isMutating(step, resolvedName) && !step.allow) {
    throw new WalkError(
      "MUTATING_ACTION_NOT_ALLOWED",
      `Step "${step.id}" would change data (${resolvedName ?? step.action.type}) and is not allowed for this flow`,
      `If this is safe on demo data, set "allow: true" on step ${step.id} in flow.yaml and run \`walkthrough plan\` again.`,
      true,
    );
  }
}

const CAPTCHA_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i;

/** Pause conditions checked before and after every action. Throws a paused WalkError. */
export async function checkInterruptions(
  page: Page,
  flow: Flow,
  step: FlowStep,
  events: GuardEvents,
  opts: { authGate?: boolean } = {},
): Promise<void> {
  const violation = events.violations.shift();
  if (violation) {
    throw new WalkError(
      "OFF_ALLOWLIST_NAVIGATION",
      `Step "${step.id}" tried to navigate to ${violation}, which is outside the permitted domains`,
      `Add the host to permittedDomains in flow.yaml if it is part of the demo, or change the step.`,
      true,
    );
  }
  const dialog = events.dialogs.shift();
  if (dialog) {
    throw new WalkError(
      "UNEXPECTED_DIALOG",
      `A browser ${dialog.type} appeared at step "${step.id}": "${dialog.message}"`,
      "It was dismissed. Decide whether the flow should handle it, then recapture.",
      true,
    );
  }
  if (page.frames().some((f) => CAPTCHA_FRAME.test(f.url())) || (await page.getByText(/verify you are human/i).count()) > 0) {
    throw new WalkError(
      "CAPTCHA",
      `A CAPTCHA is shown at step "${step.id}"`,
      "Disable bot protection in the demo environment, or complete it in a manual step.",
      true,
    );
  }
  // Before the flow's sign-in step has run, the signed-out page is where we expect to be.
  for (const cond of opts.authGate === false ? [] : flow.signedOutWhen) {
    if (await checkAssertion(page, cond)) {
      throw new WalkError(
        "AUTH_EXPIRED",
        `The session appears signed out at step "${step.id}" (matched ${JSON.stringify(cond)})`,
        "Sign in again with `walkthrough capture --headed`, which pauses at the manual sign-in step.",
        true,
      );
    }
  }
  if (!step.dialogExpected && step.action.type !== "manual") {
    const modal = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [aria-modal="true"]:visible, dialog[open]');
    if ((await modal.count()) > 0) {
      const name = (await modal.first().getAttribute("aria-label")) ?? (await modal.first().innerText()).split("\n")[0];
      throw new WalkError(
        "UNEXPECTED_DIALOG",
        `An unexpected modal is open at step "${step.id}": "${name?.trim()}"`,
        "Dismiss it in a preceding step, or set dialogExpected: true if the step targets it.",
        true,
      );
    }
  }
}
