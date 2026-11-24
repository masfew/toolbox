---
name: html-page-style
description: "A house look for every HTML page Claude writes by hand to be viewed: an Artifact, a local page in an app that hosts pages, or a standalone HTML file. One shared stylesheet with neutral greys, a single blue accent, status colours and IBM Plex fonts, in light and dark mode. Use it whenever writing or rewriting such a page that isn't a plan - a write-up, handoff, report, findings or audit page, a strategy, proposal or draft to review, explainer, comparison, reference, runbook, status page or small tool - right after the Artifact tool's quickstart (or artifact-design) and before choosing any colour or font, even if the user doesn't mention style, colours or a theme. Not for plans the user asked for by name (better-plans), Artifact types such as Slides, Docs, Dashboard or Design that bring their own look, a project's own website or app, or game UI and promo art."
---

# HTML page style

Every page Claude writes by hand should look like it came from the same place, wherever it's shown: an Artifact on claude.ai, a local page in an app that hosts pages, or an HTML file opened in a browser. Left alone, each session picks a palette and fonts for the subject, so pages read as a random set. This skill fixes the look to one shared stylesheet, [assets/house.css](assets/house.css), whose colours and fonts match the plan pages of the `better-plans` skill, so design effort goes into layout and content.

## Where the other rules live

- **`artifact-design`** (whose text the Artifact tool's quickstart result carries for a plain page) still applies, when it's in play, for the page contract, layout, phone width, copy, building cleanly and the check before publishing. Skip the parts of it this skill replaces: the studio opening's visual identity for each subject, **Pair typefaces**, **Choose neutrals deliberately**, **Design both themes** and **Avoid AI-generated design** under Fundamentals, the Process's design plan (the `:root` tokens are `house.css`'s), and **When the request is editorial**. `house.css` already meets the page contract's theme rules.
- **The host's own rules** (where a page tool wants its files, how it publishes and updates them) come from that tool. This skill only sets the look.
- **Plans** made with `better-plans` use its `plan.css`, which carries the same colours plus the plan-only parts. Without `better-plans`, a plan page is a page like any other and uses this skill.
- **Charts** follow the `dataviz` skill, if it's installed, for chart form and series colours. Keep the page around a chart in the house look, and use `--accent` for a single series and the status colours for good and bad.

## Making a page

1. **Copy the files to where the page is built.** Copy `<this skill's folder>/assets/house.css` into the folder the page's file lives in, and start the page as a copy of [assets/template.html](assets/template.html) there. For the Artifact tool that folder is the working directory or the scratchpad, the only places it publishes supporting files from. The template has the title, the font link and the stylesheet link, and no doctype, `<head>`, charset or viewport tag, since the Artifact tool and most page hosts wrap the page in their own. For a standalone file opened straight in a browser, add `<!doctype html>`, `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">` at the top.
2. **Write the content** with the building blocks below.
3. **Publish `house.css` beside the page**, at the same relative path the template links (`house.css`). With the Artifact tool that's `files: {"house.css": "<scratchpad>/house.css"}`; a later republish of the page alone keeps it, so updates need no `files`. A standalone file needs `house.css` in the same folder wherever it's opened or sent.

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

- **No colours outside the tokens.** Every colour in the page is a `var(--…)` from `house.css`: `--bg`, `--surface`, `--fg`, `--muted`, `--rule`, `--rule-strong`, `--accent`, `--accent-soft`, `--row-hover`, `--code-bg`, and `--st-<status>-fg` / `--st-<status>-bg` for `todo`, `prog`, `done`, `block` and `skip`. A hex value written into the page also breaks dark mode.
- **Colour carries meaning.** Blue is for links, the main action and the one thing a diagram is about. Green, yellow, red and orange only mean a status (good, in progress, bad, warning). Everything else stays grey.
- **No other fonts.** IBM Plex Sans for text and IBM Plex Mono for code, labels and numbers, both from the template's Google Fonts link.
- **Page-specific CSS is small and uses tokens.** When a page needs an element the blocks don't cover, add a `<style>` block after the `house.css` link, marked `/* page-specific */`, using only the tokens. Never edit `house.css` for one page: every page shares it.
- **No hero banners, gradients, background images or decorative emoji.** The look is a quiet reading page.
- **Content whose look is the subject keeps its own colours.** A logo concept, a mock-up of a game screen or a colour palette being proposed is shown in its real colours inside a `.card` or `.diagram`; the page around it stays in the house look.
- **Existing pages.** A small edit to an older page with its own palette keeps that page's look. A rewrite, or any edit the user makes about the page's look, moves it to the house look.

## Files

| File | Read when |
|---|---|
| [assets/house.css](assets/house.css) | You need a token name or a block's exact classes beyond the table above |
| [assets/template.html](assets/template.html) | Starting every new page (copy it) |

## Improving this skill

New blocks go in `house.css` and the Block table together, once the same element has been needed on two or more pages. Palette or font changes go in `house.css` and, if `better-plans` is installed, in its `plan.css` in the same change. Then run `python -I ../tests/check_sync.py` from this folder, which fails when the two files' shared colour and font tokens differ.
