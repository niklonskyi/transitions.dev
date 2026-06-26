---
name: refine-live
description: Become the live "Refine" agent for the Timeline Inspector. Use when the user runs `/refine live`, asks to "refine live", "go live", "answer refine jobs", or wants the timeline panel's Refine button (LLM mode) to be backed by a real agent. Long-polls the local refine relay, reasons about each CSS transition with the transitions-dev skill, and posts suggestions back to the browser panel.
---

# Refine Live

Turn yourself into the LLM behind the Timeline Inspector's **Refine** button. While
this loop runs, the panel's **LLM** tab is "available": each click sends one
transition here, you reason about it, and your suggestions appear in the panel.

You are the poller. Nothing is installed — you just talk to a small local relay
(default `http://localhost:7331`) that the `npx` injector already started.

## How it works

```
Browser (Refine, LLM tab) ──POST /jobs──► relay ──GET /jobs/next──► YOU
                          ◄──GET /jobs/:id── relay ◄──POST /jobs/:id/result── YOU
```

## The loop — stay live for the whole session

**Keep polling continuously until the user explicitly stops you.** This is the
only thing that keeps the panel's LLM tab "available", so do not give up on idle.
A long stretch of `204` responses is *normal and expected* — it just means no one
has clicked Refine yet. Re-poll immediately every time; never treat repeated
`204`s as a reason to stop. The relay reports the agent as "available" for ~120s
after your last poll, so as long as you keep looping you stay live and the user
never has to re-run `/refine live`.

1. **Claim the next job (long-poll).** This call blocks up to ~25s, then returns.

   ```bash
   curl -s http://localhost:7331/jobs/next
   ```

   - HTTP `204` / empty body → no work yet. Immediately call it again.
   - HTTP `200` with JSON → a job. Shape:

     ```json
     {
       "id": "uuid",
       "request": {
         "label": "Resize + Color",
         "selector": ".box-resize",
         "mode": "llm",
         "refineType": "small",
         "timings": [
           { "property": "width", "durationMs": 400, "delayMs": 0, "easing": "ease-out" },
           { "property": "background", "durationMs": 400, "delayMs": 0, "easing": "ease-out" }
         ]
       }
     }
     ```

   - `refineType` chooses what kinds of suggestions to make (it mirrors the
     panel's two tabs):
     - `"small"` (or missing) → **Small refinements**: nudge the existing
       declarations toward the motion tokens (step 3a) **and**, when it's possible
       and sensible, *also* suggest swapping the whole transition for a
       transitions.dev recipe (step 3b).
     - `"replace"` → **Replace transition**: suggest a whole-transition recipe
       swap **only** (step 3b). Do **not** propose motion-token tweaks — skip
       step 3a entirely.

2. **(Optional) post progress** so the panel shows what you're doing:

   ```bash
   curl -s -X POST http://localhost:7331/jobs/<id>/status \
     -H 'Content-Type: application/json' \
     -d '{"message":"Matching to transitions.dev motion tokens…"}'
   ```

3. **Reason about the transition.** Read `transitions-dev` and apply its
   `transitions refine` behaviour. Which steps you run depends on `refineType`:
   - `refineType === "small"` → do step 3a **and** step 3b.
   - `refineType === "replace"` → do step 3b **only** (skip 3a — no token tweaks).

   First, infer each declaration's **usage** from `label` + `selector` (modal
   close, dropdown open, tooltip, badge, resize, color/theme change…). Every
   decision below keys off that usage — match on **intent, not the nearest
   number**.

   **3a. Motion-token tweaks (only for `refineType === "small"`).** Using
   `## Motion tokens`:
   - Pick the motion token that fits the usage — a modal close wants a fast exit;
     a color/theme change can be slower; spring/back easings suit playful slides,
     not opacity.
   - Only propose a change where the current value actually differs.

   **3b. Replace the whole transition (for `small` when sensible, always
   considered for `replace`).** Judge whether this transition would be better off
   re-built as one of the twenty-one transitions.dev recipes:
   - The `transitions-dev` skill stays in the loop — run its `## Decision rules`
     against the inferred usage to pick the **single** best-fit recipe, then open
     that recipe's reference file (e.g. `06-modal.md`, `05-menu-dropdown.md`) to
     read its real timings, easing, distance, scale, and blur.
   - Only propose a replacement when it is **possible and sensible**: the current
     declarations are clearly a hand-rolled version of a catalogued recipe, or are
     missing the structure the usage calls for (e.g. an opacity-only "modal" that
     should scale, a width tween that should be the card-resize recipe). If the
     transition already *is* the right recipe, or no recipe genuinely fits, **do
     not** force one.
     - For `refineType === "small"`: skip the replace suggestion and let the 3a
       token tweaks stand alone.
     - For `refineType === "replace"`: there are no token tweaks to fall back on,
       so return an **empty** `suggestions` array with a short `summary` saying the
       transition already fits / no recipe applies.
   - Emit at most **one** `kind: "replace"` suggestion per job. For `small` it sits
     alongside the token tweaks (don't drop those); for `replace` it is the only
     suggestion.
   - Make its `patch` apply what the panel *can* apply live — the recipe's
     recommended duration/easing for the property that already transitions (or
     `"all"`). Name the recipe and its reference file in `title` + `reason` so the
     user knows the structural parts (keyframes, extra properties, JS hooks) come
     from running `transitions apply <recipe>` / pasting that reference file. Never
     invent timings — quote the ones from the reference file.

4. **Post the result** (this completes the job and renders cards in the panel):

   ```bash
   curl -s -X POST http://localhost:7331/jobs/<id>/result \
     -H 'Content-Type: application/json' \
     -d '{
       "summary": "Tightened the resize and softened the color fade.",
       "suggestions": [
         {
           "id": "width-duration",
           "kind": "duration",
           "property": "width",
           "title": "Duration → Snappy (250ms)",
           "from": "400ms",
           "to": "250ms",
           "patch": { "property": "width", "durationMs": 250 },
           "reason": "A size change reads as direct manipulation — snappy is more responsive than 400ms."
         }
       ]
     }'
   ```

   The example above is a `small` job (token tweaks). When a recipe genuinely
   fits, include a `kind: "replace"` card — alongside the token tweaks for
   `small`, or as the **only** suggestion for `replace`:

   ```json
   {
     "id": "replace-card-resize",
     "kind": "replace",
     "property": "width",
     "title": "Replace with Card resize",
     "from": "hand-rolled width tween",
     "to": "transitions.dev · Card resize",
     "patch": { "property": "width", "durationMs": 250, "easing": "cubic-bezier(0.22, 1, 0.36, 1)" },
     "reference": "transitions-dev/01-card-resize.md",
     "reason": "This is a width tween on layout change — the Card resize recipe handles it properly. Apply nudges the live timing; paste 01-card-resize.md (run `transitions apply card-resize`) for the full recipe."
   }
   ```

   If nothing should change, post `"suggestions": []` with a short `summary`.
   If something goes wrong, report it instead:

   ```bash
   curl -s -X POST http://localhost:7331/jobs/<id>/error \
     -H 'Content-Type: application/json' -d '{"message":"…"}'
   ```

5. **Go back to step 1.** Keep looping indefinitely. **Only stop when the user
   explicitly tells you to** (e.g. "stop refine", "exit live"). Do not stop just
   because it's been quiet — idle is the normal state between clicks. If you do
   stop, tell them the LLM tab will go unavailable and how to restart
   (`/refine live`).

## Suggestion shape (must match the panel)

Each suggestion object:

| field | meaning |
| --- | --- |
| `id` | unique within the job (e.g. `"width-duration"`) — used to track "Applied" |
| `kind` | `"duration"` \| `"delay"` \| `"easing"` for token tweaks, or `"replace"` for a whole-transition swap (drives the card label) |
| `property` | the CSS property this targets, or `"all"` |
| `title` | short label shown on the card |
| `from` / `to` | human-readable before → after |
| `patch` | **what actually gets applied** — `{ "property", "durationMs"?, "delayMs"?, "easing"? }`. Include only changed fields; `property` must match an input property (or `"all"`). For a `replace`, use the chosen recipe's recommended timing here so Apply still does something live. |
| `reference` | *(replace only, optional)* the transitions.dev reference file the user should paste for the full recipe, e.g. `"transitions-dev/06-modal.md"`. |
| `reason` | one sentence of *why*, in usage terms |

The panel applies `patch` live in the browser via the property override. Values
are not written to source files — the user copies the ones they keep.

## Notes

- Relay port: `http://localhost:7331` unless `REFINE_RELAY_PORT` was changed.
- Only **LLM**-mode jobs reach you; **Deterministic**-mode jobs are answered by
  the relay itself (nearest-token snapping) and never appear here. Whole-transition
  **replace** suggestions are therefore LLM-only — the deterministic path can't
  infer usage well enough to pick a recipe, so a Deterministic + "Replace
  transition" job just returns an empty result pointing the user back to the Agent
  tab.
- A `replace` card's Apply only changes the live timing in the patch. The recipe's
  structural parts (keyframes, extra properties, JS hooks) aren't applied in the
  browser — that's why the card points the user at the reference file to paste.
- The relay errors a waiting job after ~120s, so answer promptly once you claim
  one. The long-poll itself returning `204` is normal — just poll again.
