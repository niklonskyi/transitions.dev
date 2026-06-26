// The transitions.dev motion-token vocabulary, plus a deterministic refine pass
// that maps a transition's current values onto the nearest token and proposes
// the differences. This mirrors the `transitions refine` behaviour in
// ~/.agents/skills/transitions-dev/SKILL.md so the reference agent can answer
// without an LLM. A real agent driven by the skill can do better — it infers
// *usage* (modal close vs dropdown open) from the surrounding code rather than
// snapping to the nearest number.

// Durations — from the skill's "## Motion tokens" table.
export const DURATION_TOKENS = [
  { ms: 40, name: "Stagger", usage: "per-item stagger offset" },
  { ms: 80, name: "Micro", usage: "tooltip delay, shake segment, large stagger" },
  { ms: 150, name: "Quick", usage: "modal close, dropdown close, text swap, tooltip appear" },
  { ms: 250, name: "Fast", usage: "icon swap, dropdown open, modal open, tabs sliding, page slide" },
  { ms: 350, name: "Medium", usage: "panel close, toast close" },
  { ms: 400, name: "Slow", usage: "panel open, skeleton content reveal, input clear" },
  { ms: 500, name: "Very slow", usage: "emphasis, badge appear, text reveal, success check" },
];

// The transitions.dev default ease-out — "Smooth ease out" in the skill.
export const SMOOTH_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

// Easing values that ARE motion tokens — leave these alone.
const TOKEN_EASINGS = new Set(
  [
    SMOOTH_OUT,
    "ease-in-out",
    "ease-out",
    "linear",
    "cubic-bezier(0.34, 1.36, 0.64, 1)", // bouncy overshoot (badge pop)
    "cubic-bezier(0.34, 3.85, 0.64, 1)", // strong bouncy overshoot (avatar return)
  ].map(normEase)
);

function normEase(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

function nearestDuration(ms) {
  let best = DURATION_TOKENS[0];
  let bestDelta = Infinity;
  for (const t of DURATION_TOKENS) {
    const d = Math.abs(t.ms - ms);
    if (d < bestDelta) {
      bestDelta = d;
      best = t;
    }
  }
  return { token: best, delta: bestDelta };
}

// A generic/non-token easing the skill would nudge toward the default ease-out.
function shouldRefineEasing(easing) {
  const n = normEase(easing);
  if (!n) return false;
  if (TOKEN_EASINGS.has(n)) return false;
  // "ease", "ease-in", or any hand-rolled cubic-bezier that isn't a token.
  return n === "ease" || n === "ease-in" || n.startsWith("cubic-bezier") || n.startsWith("linear(");
}

/**
 * Produce token-alignment suggestions for a list of property timings.
 * @param {{property:string,durationMs:number,delayMs:number,easing:string}[]} timings
 * @returns {object[]} suggestions
 */
export function refineTimings(timings) {
  const suggestions = [];
  if (!Array.isArray(timings)) return suggestions;

  for (const t of timings) {
    const prop = t.property || "all";

    // Duration → nearest token (skip if already on-grid or within 10ms).
    if (Number.isFinite(t.durationMs)) {
      const { token, delta } = nearestDuration(t.durationMs);
      if (delta > 10) {
        suggestions.push({
          id: `${prop}-duration`,
          kind: "duration",
          property: prop,
          title: `Duration → ${token.name}`,
          from: `${t.durationMs}ms`,
          to: `${token.ms}ms`,
          patch: { property: prop, durationMs: token.ms },
          reason: `${token.name} (${token.ms}ms) is the closest motion token — used for ${token.usage}. ${t.durationMs}ms is off-grid.`,
        });
      }
    }

    // Easing → the transitions.dev default ease-out.
    if (shouldRefineEasing(t.easing)) {
      suggestions.push({
        id: `${prop}-easing`,
        kind: "easing",
        property: prop,
        title: `Easing → Smooth ease out`,
        from: t.easing,
        to: SMOOTH_OUT,
        patch: { property: prop, easing: SMOOTH_OUT },
        reason: `"${t.easing}" is a generic curve. The transitions.dev standard ease-out reads more intentional on opens, closes, slides, and resizes.`,
      });
    }
  }

  return suggestions;
}
