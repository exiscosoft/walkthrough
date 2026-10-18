import type { FlowStep, StepState } from "../project/schema.js";

// Phrases that assert the result happened. Instructions like "Complete the form" or
// "you can now choose…" are not claims, so bare "complete" and "you can now" are excluded.
const OUTCOME_CLAIM = /\b(success(?:fully)?|is (?:now )?ready|you(?:'re| are) (?:all )?(?:set|done)|(?:has|have) been (?:created|saved|sent|updated|completed)|is (?:now )?complete)\b/i;

export interface GroundingIssue {
  step: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * FR05 guardrails: never narrate an unobserved step or an outcome that was not
 * captured, and flag quoted UI names that do not appear in the observed labels.
 */
export function checkGrounding(flowSteps: FlowStep[], steps: StepState[]): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  let outcomeSeen = false;
  steps.forEach((st, i) => {
    const fs = flowSteps[i];
    const text = st.narration?.text;
    if (!fs || !text) return;
    if (!st.capture || st.status !== "captured") {
      issues.push({ step: st.id, severity: "error", message: "Narration exists for a step that has not been observed in the browser." });
      return;
    }
    if (fs.outcome && st.capture.expectPassed) outcomeSeen = true;
    if (OUTCOME_CLAIM.test(text) && !outcomeSeen && !(fs.expect.length > 0 && st.capture.expectPassed)) {
      issues.push({
        step: st.id,
        severity: "error",
        message: `Narration claims an outcome ("${OUTCOME_CLAIM.exec(text)![0]}") before any verified outcome was captured.`,
      });
    }
    const labels = st.capture.labels.map((l) => l.toLowerCase());
    for (const m of text.matchAll(/"([^"]+)"|“([^”]+)”/g)) {
      const quoted = (m[1] ?? m[2])!.toLowerCase();
      if (!labels.some((l) => l.includes(quoted))) {
        issues.push({ step: st.id, severity: "warning", message: `"${m[1] ?? m[2]}" is not a label observed on this screen.` });
      }
    }
  });
  return issues;
}
