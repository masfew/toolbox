---
name: artifact-style
description: "A house look for every Artifact page Claude writes by hand: one shared stylesheet with neutral greys, a single blue accent, status colours and IBM Plex fonts, in light and dark mode. Use it whenever publishing or rewriting an HTML Artifact page that isn't a plan - a write-up, handoff, report, findings or audit page, explainer, comparison, reference, runbook, status page or small tool - right after artifact-design and before choosing any colour or font, even if the user doesn't mention style, colours or a theme. Not for plans made with better-plans (which has this look built in), Artifact types such as Slides, Docs, Dashboard or Design that bring their own look, or game UI and promo art."
---

# Artifact style

Every Artifact page should look like it came from the same place. Left alone, each session picks its own palette and fonts for the subject (a green-tinted page about merges, a warm one about cooking), so pages read as a random set. This skill fixes the look to one shared stylesheet, [house.css](house.css), whose colours and fonts match the plan pages of the `better-plans` skill. Sessions then spend their design effort on layout and content, not on choosing colours.

## Where the other rules live

- **`artifact-design`** still applies to everything except colours and fonts: the page contract (title, description, script and font origins, size), layout, phone width and the rest. Where it asks you to choose a palette or typeface, use this skill instead. `house.css` already meets its theming rules: tokens on `:root`, dark mode under both selectors, and an explicit `body` background.
- **Plans** made with `better-plans` use its `plan.css`, which carries the same colours plus the plan-only parts. Without `better-plans`, a plan page is a page like any other and uses this skill.
- **Charts** follow the `dataviz` skill, if it's installed, for chart form and series colours. Keep the page around a chart in the house look, and use `--accent` for a single series and the status colours for good and bad.

## Making a page

1. **Copy the files into the scratchpad.** The Artifact tool only publishes supporting files from the working directory or the scratchpad: `cp <this skill's folder>/house.css <scratchpad>/house.css`. Start the page from [template.html](template.html) (copy it to `<scratchpad>/<name>.html`), which already has the title, the font link and the stylesheet link. Add no doctype, `<head>`, charset or viewport tag: the Artifact tool wraps the page in its own.
2. **Write the content** with the building blocks below. Follow `artifact-design` for layout and what goes on the page.
3. **Publish** with `files: {"house.css": "<scratchpad>/house.css"}`. A later republish of the page alone keeps `house.css`, so updates need no `files`.

| Block | Markup |
|---|---|
| Page column | `<main class="page">`; `<main class="page wide">` for tables or grids that need 72rem |
| Header | `<header class="page-header">` with `.eyebrow` (project, topic, date), `h1`, `p.lede` |
| Section | `<section class="block">` with `h2`, then `.prose` for running text and `h3` subheadings |
| Table | `.table-wrap` > `table.table`; a narrow status column takes `class="st"` |
| Status pill | `<span class="status" data-status="done">Merged</span>`; `todo` (neutral, default), `progress` (in progress or caution), `done` (good), `blocked` (bad), `skipped` (warning). `.status` is reserved for this pill: name other elements differently |
| Aside | `.note`, optional `.note-label`, optional `data-tone` for a coloured left edge: `done` for confirmed, `progress` for caution or not yet tested, `blocked` for a problem, `accent` for a key point |
| Card and grid | `.card` (with `.card-head` for a label and buttons) inside `.grid` |
| Code | `<code>` inline, `<pre>` for blocks |
| Buttons | `button`; `button.primary` for the one main action |
| Diagram | inline SVG in `.diagram`, coloured only with `d-box`, `d-main`, `d-edge`, `d-head`, `d-name`, `d-sub`, `d-main-sub` (same classes as `better-plans`) |
| Quieter text | `.muted` |

## Rules

- **No colours outside the tokens.** Every colour in the page is a `var(--…)` from `house.css`: `--bg`, `--surface`, `--fg`, `--muted`, `--rule`, `--rule-strong`, `--accent`, `--accent-soft`, `--row-hover`, `--code-bg`, and `--st-<status>-fg` / `--st-<status>-bg` for `todo`, `prog`, `done`, `block` and `skip`. A hex value written into the page is the drift this skill exists to stop, and it also breaks dark mode.
- **Colour carries meaning.** Blue is for links, the main action and the one thing a diagram is about. Green, yellow, red and orange only mean a status (good, in progress, bad, warning). Everything else stays grey, so a coloured mark always tells the reader something.
- **No other fonts.** IBM Plex Sans for text and IBM Plex Mono for code, labels and numbers, both from the template's Google Fonts link.
- **Page-specific CSS is small and uses tokens.** When a page needs an element the blocks don't cover, add a `<style>` block after the `house.css` link, marked `/* page-specific */`, using only the tokens. Never edit `house.css` for one page: every page shares it. When the same extra element keeps coming back, add it to `house.css` and this table (Improving this skill).
- **No hero banners, gradients, background images or decorative emoji.** The look is a quiet reading page.
- **Content whose look is the subject keeps its own colours.** A logo concept, a mock-up of a game screen or a colour palette being proposed is shown in its real colours inside a `.card` or `.diagram`; the page around it stays in the house look.
- **Existing pages.** A small edit to an older page with its own palette keeps that page's look. A rewrite, or any edit the user makes about the page's look, moves it to the house look.

## Files

| File | Read when |
|---|---|
| [house.css](house.css) | You need a token name or a block's exact classes beyond the table above |
| [template.html](template.html) | Starting every new page (copy it) |

## Improving this skill

New blocks go in `house.css` and the Block table together, once the same element has been needed on two or more pages. Palette or font changes go in `house.css` and, if `better-plans` is installed, in its `plan.css` in the same change. Then run `python -I ../tests/check_sync.py` from this folder, which fails when the two files' shared colour and font tokens differ.
