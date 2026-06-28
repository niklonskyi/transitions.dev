---
name: refine-live
description: Become the live "Refine" agent for the Timeline Inspector. Use when the user runs `/refine live`, asks to "refine live", "go live", "answer refine jobs", or wants the timeline panel's Refine button (LLM mode), Accept button, or grouped scan to be backed by a real agent. Long-polls the local refine relay, reasons about each CSS transition with the transitions-dev skill, posts suggestions back to the browser panel, for "scan" jobs groups the page's transitions into components with open/close phases by reading the source, and for "apply" jobs writes the accepted timing changes into the user's source code.
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

   - **If `request.kind === "scan"`** this is not a suggestion job — the panel is
     asking you to group the page's transitions by reading the source. Jump to
     [`## Scan jobs`](#scan-jobs-group-from-source) and return `groups` instead of
     suggestions.
   - **If `request.kind === "apply"`** this is not a suggestion job — the user
     pressed **Accept** to write changes to their code. Jump to
     [`## Apply jobs`](#apply-jobs-write-to-source) and edit the source instead of
     posting suggestions. Everything below (refineType, steps 3–4) is for the
     normal Refine flow.
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

## Scan jobs (group from source)

When a claimed job has `request.kind === "scan"`, the panel wants you to turn a
flat list of DOM-detected transitions into **components with phases**. A naive
DOM scan only sees each element's *current* computed transition — it can't tell
open from close, and lists related elements (panel, backdrop, staggered items)
separately. You fix that by reading the source. The request looks like:

```json
{
  "id": "uuid",
  "request": {
    "kind": "scan",
    "url": "http://localhost:5173/",
    "raw": [
      { "label": "div.dropdown-panel", "selector": ".dropdown-panel",
        "properties": ["opacity","transform"],
        "timings": [{ "property": "opacity", "durationMs": 200, "delayMs": 0, "easing": "ease-out" }],
        "cssRules": [
          ".dropdown .dropdown-panel { opacity: 0; transition: opacity 200ms ease-out 0ms, transform 200ms cubic-bezier(0.22, 1, 0.36, 1) 0ms; }",
          ".dropdown.is-open .dropdown-panel { opacity: 1; transform: translateY(0); }",
          ".dropdown.is-closing .dropdown-panel { transition: opacity 150ms ease-in 0ms; opacity: 0; }"
        ] }
    ]
  }
}
```

**Be fast.** The `raw.timings` are already accurate for each element's *current*
on-screen state — treat them as ground truth and reuse them verbatim. Most `raw`
entries also carry **`cssRules`**: the CSS rules harvested live from the page
(CSSOM) that drive that element across *all* states (base + open + close), with
`var()` already resolved to concrete values.

**Fast path — prefer `cssRules` over the filesystem.** When an entry has
`cssRules`, they are authoritative and contain everything you need: the opposite
phase's timings live on a state-variant selector inside them (e.g.
`.dd.is-closing .dd-panel`, `.modal[data-closing] .dialog`), and the toggled
state is visible in those selectors. Derive grouping, phases, toggled state, and
opposite-phase timings **directly from `cssRules` + `timings`** — do **not**
glob/grep/read files for any element whose `cssRules` is non-empty; it only
wastes time. Only fall back to reading source for entries with an empty/missing
`cssRules` (CORS-locked sheets, styled-components, Tailwind, etc.), and even then
read the minimum.

Do this:

1. **Identify each animated component** the raw entries belong to (dropdown,
   modal, tooltip, accordion, drawer, toast…). The selectors/labels usually make
   this obvious — only read source (plain CSS / CSS Modules,
   styled-components/emotion, Tailwind, inline styles, Motion/Framer variants)
   when the grouping is genuinely unclear.
2. **Split each component into phases** — usually `open` and `close` (a hover-only
   component can be a single phase). The phase matching the current DOM reuses the
   provided timings; the *opposite* phase often lives on a different selector
   (`.is-open` vs `.is-closing`) with different timings — take it from the entry's
   `cssRules` (or, only if it has none, read source). Report **both** even though
   only one is in the DOM right now.
3. **List each phase's members** — the elements that animate in that phase. Give
   each a stable `id`, a human `label`, a live-resolvable CSS `selector`, an
   optional `toState` hint (the class/attribute that drives the phase, e.g.
   `.is-open`), and its `propertyTimings`. For the current-state phase, **copy the
   provided `raw.timings` verbatim**; for the opposite phase, **quote the real
   timings from the entry's `cssRules`** (already var()-resolved) — or from source
   if it has none — **never invent.**
4. **Post the groups** (this completes the job):

   ```bash
   curl -s -X POST http://localhost:7331/jobs/<id>/result \
     -H 'Content-Type: application/json' \
     -d '{
       "summary": "Grouped Dropdown into Open/Close.",
       "groups": [
         { "id": "dropdown", "label": "Dropdown", "component": "src/Dropdown.tsx",
           "phases": [
             { "id": "dropdown:open", "phase": "open", "label": "Open", "members": [
               { "id": "panel", "label": "Panel", "selector": ".dropdown-panel", "toState": ".is-open",
                 "propertyTimings": [
                   { "property": "opacity", "durationMs": 200, "delayMs": 0, "easing": "ease-out" },
                   { "property": "transform", "durationMs": 200, "delayMs": 0, "easing": "cubic-bezier(0.22, 1, 0.36, 1)" }
                 ] }
             ] },
             { "id": "dropdown:close", "phase": "close", "label": "Close", "members": [
               { "id": "panel", "label": "Panel", "selector": ".dropdown-panel", "toState": ".is-closing",
                 "propertyTimings": [
                   { "property": "opacity", "durationMs": 150, "delayMs": 0, "easing": "ease-in" }
                 ] }
             ] }
           ] }
       ]
     }'
   ```

   If you can't confidently group anything, post `{"groups":[],"summary":"…"}` —
   the panel keeps its flat DOM scan. Reserve `/jobs/<id>/error` for unexpected
   failures.

Then go back to step 1 of the loop.

## Apply jobs (write to source)

When a claimed job has `request.kind === "apply"`, the user accepted their current
timeline values and wants them written to the codebase. The request looks like:

```json
{
  "id": "uuid",
  "request": {
    "kind": "apply",
    "label": "Dropdown · Close",
    "selector": ".dropdown-panel",
    "component": "src/Dropdown.tsx",
    "group": "Dropdown",
    "phase": "close",
    "changes": [
      { "property": "opacity", "member": "Panel", "selector": ".dropdown-panel",
        "from": { "durationMs": 300, "delayMs": 0, "easing": "ease" },
        "to": { "durationMs": 150, "delayMs": 0, "easing": "cubic-bezier(0.4, 0, 1, 1)" } }
    ]
  }
}
```

Do this:

1. **Locate the real declaration in the source.** The `selector` is a DOM-path
   *hint*, not necessarily the source selector. Use the `component` hint and search
   by the label/class names; handle whatever the project uses: plain CSS / CSS
   Modules, styled-components or emotion template literals, Tailwind utilities
   (`duration-300`, arbitrary `[transition-duration:300ms]`, or the
   `tailwind.config` theme), inline `style={{ transition: … }}` objects, and
   Motion/Framer variants. Match by the `from` values to disambiguate.
   - **If `phase` is set** (e.g. `"open"`/`"close"`), edit only that state's rule
     (the `.is-open` rule for open, the `.is-closing`/base rule for close) — not
     the other phase. Each change's `member` + `selector` says which element.
2. **Edit each change's property** to its `to` values (`durationMs` ms, `easing`,
   `delayMs` ms) on the right member + phase. Keep the file's existing unit/format
   (`0.25s` vs `250ms`) and touch only that property's timing. If a CSS variable /
   design token backs the value, update it at the single most sensible place.
3. **Minimal edit** — no reformatting or unrelated changes.
4. **Post the outcome** (this completes the job):

   ```bash
   curl -s -X POST http://localhost:7331/jobs/<id>/result \
     -H 'Content-Type: application/json' \
     -d '{"applied":true,"summary":"Set .t-modal transition to 150ms ease-in","files":["src/Modal.css:42"]}'
   ```

   If you cannot confidently find the declaration, post
   `{"applied":false,"summary":"<what you searched and why not found>"}` (still a
   `result`, not an `error`). Reserve `/jobs/<id>/error` for unexpected failures.

Then go back to step 1 of the loop.

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
