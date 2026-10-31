# Performance audit

Sketch's goal is to stay as light, fast and responsive as Microsoft Paint. This file is the written process for a **full performance audit**, the budgets every action is held to, and the results of each audit so far. The quick check before each commit is in [CLAUDE.md](../CLAUDE.md) ("Speed check before committing").

## When a full audit is due

- At the end of each phase or planned feature.
- Before each release that goes to other people.
- Whenever the per-change checks start to drift: the same action coming out more than 10% slower than the last audit in two changes running, or anything going over budget.

## Running it

1. Build the release app: `npm run tauri build -- --no-bundle` (about a minute).
2. Close other heavy programs, plug in the laptop if it is one, and leave the PC alone: the run takes about 10 minutes, replaces the clipboard, briefly covers the screens with the capture overlay, and WebView2 slows its frames down when Sketch's window is covered.
3. Run `npm run perf`. It prints every timing against its budget and against the last audit on this PC, and saves the run in `perf-results/` (not committed).
4. Fix anything over budget, or anything that feels slow even within budget, then rerun just those actions (`npm run perf -- fill copy`).
5. When everything is within budget, run `npm run perf -- --baseline` to save the run as the new baseline (`perf-results/baseline.json`), and add a row to the results below. The baseline stays out of git, since timings only compare on the PC that made them; on a new PC the first `--baseline` run starts one.

`npm run perf -- --list` lists the actions. Any word picks actions: an id (`brush-4k`), part of one (`brush`, `png`, `8k`) or a group (`ui`, `draw`, `files`, `save`, `edit`, `start`).

## How each action is timed

Times run from the input (the key press or pointer event's own timestamp) to the start of the first frame that shows the result, so they match what a person sees. The script drives the release app through WebView2's debugging port, as `check:native` does, with its own data folder.

| Action | How it's timed | Picture | Runs (median) | Budget |
|---|---|---|---|---|
| Start-up | Launch to the first drawn frame (the start-up probe) | New | 5 | 1 s |
| Capture keys | The helper getting the keys to the frozen screen showing, with Sketch closed | Screen | 5 | 100 ms |
| Open from Explorer | Launching `sketch.exe photo.png` while Sketch runs, to the photo on screen | 4K photo | 3 | 1 s |
| Close | Close button to the window gone, and to the app exited | New | 3 | 200 ms gone, 1 s exited |
| Change tool | Each tool key (B, P, E, G, I, T, U, A, M, C) to the options bar showing the tool; the slowest key's median | Small | 3 per key | 17 ms (a frame) |
| Change brush size | `]` and `[` to the new size showing | Small | 5 | 17 ms |
| Swap colours | X to colour 1 changing | Small | 5 | 17 ms |
| Drag an options bar label | With a rectangle picked and its Outline label being dragged (the pointer locked), a pointer move of one step to the frame that shows the restyled shape | Small | 10 | 17 ms |
| Colour popover | Clicking colour 1 to the popover showing | Small | 5 | 50 ms |
| Pick a swatch | Clicking a swatch to colour 1 changing | Small | 5 | 17 ms |
| File menu, command palette, Settings | Click or key to it showing | Small | 5 | 50 ms |
| Paste into a new picture | Ctrl+V to the picture's size showing; the clipboard holds a PNG and a bitmap, as screenshot tools leave it | 4K, 8K | 3 | 200 ms (8K 800) |
| Paste onto a picture | Ctrl+V to the floating paste showing | 4K, 8K | 3 | 200 ms (8K 800) |
| Save | Ctrl+S to the title losing its `*`, after a Save As set the file; PNG, JPEG, WebP, BMP and `.sktch` | 4K, 8K photo | 3 | 1 s (8K 4 s) |
| Copy the whole picture | Ctrl+Shift+C to the "Copied" toast | 4K, 8K | 3 | 500 ms (8K 2 s) |
| Zoom | Ctrl+= to the new zoom drawn | 4K, 8K | 5 | 17 ms |
| Undo, redo | Ctrl+Z or Ctrl+Y on a brush stroke to it drawn | 4K, 8K | 3 | 100 ms (8K 400) |
| Invert colours | Ctrl+Shift+I to it drawn | 4K, 8K | 3 | 100 ms (8K 400) |
| Strokes and drags: Pencil, Brush, Eraser, Highlighter, Blur, Pixelate, Rectangle, Ellipse, Polygon, Star, Line, Arrow, Callout, Spotlight, both selects, Crop | A 1.5 s wavy drag with pointer moves every 4 ms. Frames per second; the slowest 5% of frames; **pointer lag**, how long each pointer move waits for the frame that draws it (median and slowest 5%); and **finish**, letting go to the result drawn | 4K, 8K photo | 2 | 55 fps or more; slowest frames 33 ms; lag 17 ms, slowest 33 ms; finish 100 ms (8K 400), Callout's text box 50 ms |
| Clicks: Fill, Magic Wand, Colour Picker, Numbered Marker, Text | Click to the result drawn (the text box for Text) | 4K, 8K photo | 5 | Fill and Magic Wand 200 ms (8K 800); the rest 50 ms (8K 200), Text 50 ms |
| Autosave | The longest time the page is busy (a long task) in the 6 s after a change, while autosave writes | 4K, 8K | 1 | 100 ms |

### Test pictures

The script makes them in its temporary folder each run:

- **Small**: a new 800 × 600 picture, for the controls, which don't depend on the picture.
- **4K photo**: 3840 × 2160, smooth colour gradients with a little noise. The gradients let Fill and the Magic Wand spread over large areas, and the noise makes saving and copying work as hard as on a real photo.
- **8K photo**: 7680 × 4320, made the same way: the very large canvas.

### Reading the results

- Budgets come from the 1 second start-up budget in step 1.1, one screen frame (17 ms at 60 Hz) for anything that should feel instant, 50 ms for anything that opens, 100 ms for edits to the picture, and the speed goals checked in step 6.7 (4K paste under 200 ms, brush at 60 frames a second). Fill and the Magic Wand change or select most of the picture, so they get the paste goal's 200 ms. The 8K picture has four times the pixels, so its time budgets are four times the 4K ones; frame rate and pointer lag budgets are the same at every size.
- Each timing is also compared with the baseline, and flagged `SLOWER` when it's over 10% and over 1 ms (or 1 frame a second) worse, which is beyond run-to-run noise.
- The display's refresh rate sets the shortest possible time: on the 240 Hz screen the audits so far ran on, a frame is 4 ms, so instant actions show 2 to 6 ms. On a 60 Hz screen the same actions show up to 17 ms.
- The script can't feel anything, so after fixing the numbers, also draw, zoom and pan on a big picture by hand.

## Results

Each row is one full audit, in the order they were run. Times are medians in milliseconds unless marked.

| Date | Version | Machine | Start-up | Open 4K | Paste 4K | Copy 4K | Save 4K PNG | Fill 4K | Wand 4K | Brush 8K | Copy 8K | Paste 8K | Fill 8K |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 23 Oct 2026, before fixes | a53f6b1 | i9-13900K, 64 GB, 240 Hz | — | 170 | — | 678 | 245 | 406 | 518 | 64 fps | 2,657 | — | 1,688 |
| 23 Oct 2026, baseline | a53f6b1 with the F5 fixes | i9-13900K, 64 GB, 240 Hz | 373 | 170 | 114 | 389 | 262 | 169 | 134 | 213 fps | 1,437 | 338 | 657 |

The first audit found these over budget and fixed them all: drawing on an 8K picture (about 65 frames a second, for every tool), Fill and the Magic Wand on 4K and 8K, copying a 4K or 8K picture, and the longest autosave pause on 8K (106 ms; the `.sktch` zip now builds in the encoder worker). What changed and why is in [decisions.md](decisions.md), "Decisions for the Full Performance Audit (F5)". Paste wasn't timed before the fixes with the clipboard as screenshot tools leave it, so it has no "before". Every action in the baseline is within budget; the closest are Fill on 4K (169 of 200 ms), Fill on 8K (657 of 800), the capture keys (81 of 100) and copying 4K (389 of 500).
