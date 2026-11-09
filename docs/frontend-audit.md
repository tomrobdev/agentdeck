# Front-end audit

Step 1 of the plan "Front-end design: audit, themes, Tailwind". It covers `app/`: every file under `app/src/components/`, `app/src/styles/style.css`, and the few non-component files that carry styling (`App.vue`, `render.ts`, `index.html`, `app/src-tauri/tauri.conf.json`).

Nothing in `app/` was changed. File references are `path:line` against the tree at the time of writing, with `app/src/` dropped from component paths.

**How the numbers were produced.** This audit ran without a shell, so the contrast ratios below were calculated by hand from the sRGB formula in WCAG 2.x. Treat them as ±0.1. The theme task should re-check them with a small script before shipping (see [Proposed token set](#proposed-token-set)). A "pass" below means at least 4.5:1 for text and 3:1 for icons and control borders.

## 1. Stack and versions

| Piece        | Declared (`app/package.json`)  | Resolved (`pnpm-lock.yaml`) |
| ------------ | ------------------------------ | --------------------------- |
| Vue          | `^3.5.13`                      | 3.5.44                      |
| Vite         | `^8.0.16`                      | 8.3.4                       |
| Vue plugin   | `@vitejs/plugin-vue ^6.0.7`    | 6.0.10                      |
| TypeScript   | `~6.0.3`                       | 6.0.3                       |
| vue-tsc      | `^3.3.5`                       | 3.3.13                      |
| Tauri        | `@tauri-apps/api ^2`, `cli ^2` | api 2.12.4, cli 2.12.3      |
| highlight.js | `11.12.0`                      | 11.12.0                     |
| markdown-it  | `15.0.3`                       | 15.0.3                      |
| DOMPurify    | `3.4.17`                       | 3.4.17                      |

- **No CSS tooling.** There is no PostCSS config, no Sass and no CSS framework. The whole design system is one global `style.css` (275 lines) plus a `<style scoped>` block in almost every SFC. `Markdown.vue:27` is the one unscoped block, because it styles `v-html` output.
- **No router or state library.** `router.ts` and `lib/task/task-view.ts` are hand-rolled. This is irrelevant to styling except that dynamic class names come from `lib/task/task-view.ts` and `app/src/api/format.ts` (see section 6).
- **No component library.** Buttons, inputs, pills and popovers are all hand-styled. The code shows where Reka UI or a similar headless library would fit (`Popover.vue`, `Modal.vue`), but none is installed.
- **Theming is OS-driven only.** Dark mode is two `@media (prefers-color-scheme: dark)` blocks (`style.css:26`, `style.css:172`). There is no `data-theme` attribute, no toggle and no stored preference.
- **Webview CSP** (`src-tauri/tauri.conf.json:24`): `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`. Inline styles and generated CSS are allowed; remote fonts are not.
- **Fonts** are system stacks only. No web fonts are loaded.

## 2. Token inventory

### What exists (`style.css:1-43`, `162-182`)

| Group   | Tokens                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface | `--bg`, `--panel`, `--panel-2`, `--code-bg`                                                                                                                                                                      |
| Line    | `--border`                                                                                                                                                                                                       |
| Text    | `--text`, `--muted`                                                                                                                                                                                              |
| Accent  | `--accent`, `--accent-text`                                                                                                                                                                                      |
| Status  | `--queued`, `--running`, `--done`, `--blocked`, `--failed`, `--cancelled` (`proposed` reuses `--accent`)                                                                                                         |
| Syntax  | `--hl-keyword`, `--hl-string`, `--hl-number`, `--hl-comment`, `--hl-title`, `--hl-type`, `--hl-attr`                                                                                                             |
| Radius  | `--radius: 8px`                                                                                                                                                                                                  |
| Private | `--c`, the "current status colour". It is set by the `.s-*` classes (`style.css:115-136`) and read by `.dot`, `.pill`, `StatusIcon`, `OverviewTab`, `RunsTab`. It is a good pattern and should survive the port. |

Colour tokens are well covered and already switch in dark mode. Everything else is missing or only half-there.

### What is missing

**Spacing.** There is no scale. Values in use: padding and gap of 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26 and 28 px. The rhythm is roughly 4 px, but 5, 7, 14, 18, 22 and 26 are one-offs (for example `FileTree.vue:202` 2px 8px, `CodeTab.vue:200` 18px 26px, `DocumentsCard.vue:102` 4px 22px, `TaskPage.vue:192` 16px 24px 8px, `ChangesTab.vue:302` fixed widths).

**Type scale.** Only the root font is tokenised (`style.css:18-20`: 13px, 1.45). Sizes in use, in px: 8, 10, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 18, 20, plus `em` sizes in `Markdown.vue:46-75` (1.45, 1.2, 1.05, 0.9). The values 11.5 and 12.5 each appear in 3 to 5 places and duplicate their neighbours (`ListView.vue:175`, `BoardView.vue:180`, `SnippetPopover.vue:87`, `FileTree.vue:204`, `CodeTab.vue:162`, `ChangesTab.vue:339`, `DocumentsCard.vue:89`). `font-size: 12px` alone appears about 45 times. Weights are 400, 500, 600 and one `650` (`StatusBar.vue:75`). Line heights are 1.3, 1.45, 1.5, 1.55 and 1.6.

**Font families.** Two stacks are repeated as literals:

- Sans: `style.css:18` and `PlanCard.vue:17` (the plan iframe's own copy).
- Mono, long form `ui-monospace, 'SF Mono', Menlo, monospace`: `style.css:100`, `CodeView.vue:58`, `DiffView.vue:84`, `ReposPanel.vue:231`.
- Mono, short form `ui-monospace, Menlo, monospace`: `style.css:256`, `ChangesTab.vue:248,255,338`, `FileTree.vue:232`, `SnippetPopover.vue:86`, `QueueView.vue:172`, `CodeTab.vue:161,205`, `DocumentsCard.vue:88`, `Sidebar.vue:157`.

That is 16 copies of two almost-equal stacks. The shorthand `font: 12px ui-monospace, Menlo, monospace;` is wrapped over several lines by the formatter, which makes it hard to grep.

**Radii.** One token (`--radius: 8px`) is used in 3 places (`App.vue:191`, `LogView.vue:116`, `ReposPanel.vue:185`). The literal `8px` appears in 15 more (`App.vue:202`, `Popover.vue:48`, `SnippetPopover.vue:79`, `BoardView.vue:143`, `TaskPage.vue:277`, `CodeTab.vue:145`, `DocumentsCard.vue:62`, `ChangesTab.vue:315`, `OverviewTab.vue:122,211`, `PlanCard.vue:109`, `RunsTab.vue:72,117`, and more). Other values: 1, 3, 4, 5, 6, 10, 12, 999 px and 50%. The set that is really in use is 4 (kbd, inline code), 6 (controls), 8 (cards, popovers), 12 (modal), pill. The odd ones are 3 (progress tracks), 5 (tree rows, menu items, inline code in `TaskPage.vue:228`) and 10 (`BoardView.vue:113`).

**Shadows.** Three hard-coded, all black-alpha:

- `Modal.vue:43`: `0 20px 60px rgb(0 0 0 / 0.25)`.
- `Popover.vue:49`: `0 8px 28px rgb(0 0 0 / 0.18)`.
- `SnippetPopover.vue:81`: `0 10px 30px rgb(0 0 0 / 0.22)`.

Two more inset "selected" accents: `ListView.vue:138` and `RunsTab.vue:92` (`inset 2px 0 0 var(--accent)`). None change in dark mode, where a black shadow on near-black is almost invisible.

**Scrim.** `Modal.vue:30`: `rgb(0 0 0 / 0.35)`, same in both themes.

**Z-index.** Five bare numbers with no scale: sticky headers `1` (`ListView.vue:113`, `ChangesTab.vue:329`), modal backdrop `10` (`Modal.vue:33`), menu panel `20` (`Popover.vue:42`), snippet popover `30` (`SnippetPopover.vue:75`). The toast (`App.vue:194`) has **no** z-index, so the modal backdrop (z 10) paints over it. A message flashed while a modal is open is hidden behind the scrim.

**Motion.** Three durations (`0.12s` `ListView.vue:118`, `0.4s` `StatusBar.vue:101`, `1.4s` pulse `style.css:142`). The pulse has no `prefers-reduced-motion` guard.

**Breakpoints.** Three, each repeated: 720 px (`ListView.vue:223`, `QueueView.vue:182`, `FilterBar.vue:156`), 900 px (`ChangesTab.vue:353`, `CodeTab.vue:214`, `TaskPage.vue:299`), 1080 px (`StatusBar.vue:122`).

**Layout widths.** Sidebar 240 (`Sidebar.vue:116`), changed-files tree 260 (`ChangesTab.vue:302`), code-tab side 280 (`CodeTab.vue:129`), board column 260 (`BoardView.vue:109`), modal 560 (`Modal.vue:36`), snippet popover 550 (`SnippetPopover.vue:76`) and a matching magic `window.innerWidth - 560` in script (`SnippetPopover.vue:43`).

**Missing colour roles** (they are expressed today as one-off `color-mix` calls):

- Tints: ten different `color-mix` percentages (8, 9, 10, 12, 13, 14, 16, 18, 20, 22, 26) over `--panel` or `transparent`.
- A focus ring (only inputs get one, `style.css:91-96`; buttons rely on the browser default).
- Control border (inputs and checkboxes reuse the decorative `--border`).
- Diff colours (`DiffView.vue:125-148` builds five from `--done`, `--failed`, `--running`).
- PR-merged purple (hard-coded, see section 4).

## 3. Repeated patterns

### 3.1 Cards with a header bar (8 copies)

The same box (`1px solid var(--border)`, `border-radius: 8px`, `background: var(--panel)`, `overflow: hidden`) is redeclared in:

- `OverviewTab.vue:120` (`.box`) and `:208` (`.final`)
- `PlanCard.vue:107` (`.plan`)
- `DocumentsCard.vue:60` (`.docs`)
- `RunsTab.vue:70` (`.cards`) and `:115` (`.final`)
- `ChangesTab.vue:313` (`.file`)
- `CodeTab.vue:140` (`.viewer`)
- `BoardView.vue:140` (`.card`, 8px 10px padding)

Five of them also carry the same header strip (`--panel-2` background, bottom border, 6 to 8 px by 10 to 14 px padding): `OverviewTab.vue:126`, `PlanCard.vue:113`, `DocumentsCard.vue:66`, `ChangesTab.vue:320`, `CodeTab.vue:152`.

**Make one:** a `Card` component (or a `.card` / `.card-head` utility) with a header slot. The two "Final message" `<details>` blocks (`OverviewTab.vue:208-221`, `RunsTab.vue:115-130`) are line-for-line duplicates apart from `max-height`; they become one `FinalMessage` component.

### 3.2 Chips and pills (9 variants)

| Where                                        | Shape                         | Notes                                                            |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `style.css:150` `.pill`                      | pill, 14% tint of `--c`       | 12px, padding 2px 8px                                            |
| `TaskPage.vue:231` `.pill` (scoped override) | pill, 16% tint over `--panel` | 500 weight, padding 2px 10px; shadows the global                 |
| `ListView.vue:174` `.chip`                   | outline pill                  | 11.5px, `line-height: 18px`, `pr-*` colour variants (`:183-190`) |
| `BoardView.vue:179` `.chip`                  | outline pill                  | same as ListView but no PR colours, so the two views disagree    |
| `CodeTab.vue:173` `.chip`                    | outline pill, amber           | 11px, 0 6px                                                      |
| `FilterBar.vue:89` `.fchip`                  | outline rounded-6 with ×      | not a pill radius                                                |
| `DisplayMenu.vue:96` `.prop`                 | toggle pill                   | on-state = 12% accent tint                                       |
| `TaskPage.vue:266` `.count`                  | filled pill                   | 11px, `--panel-2`                                                |
| `ReposPanel.vue:206` `.paused`               | plain amber text              | not a chip, but a status label                                   |

**Make one:** `Chip` with `tone` (neutral, accent, and the six statuses), `variant` (outline or tint) and a `size`. The `--c` custom property already gives the tone mechanism.

### 3.3 Buttons

The base lives in `style.css:57-78` (global element selector, plus `.primary`). Everything else is a local re-skin:

- **`.mini` ×5**, all slightly different: `ChangesTab.vue:263` (1px 8px, 12px), `CodeTab.vue:186` (same), `DocumentsCard.vue:97` (0 8px, 12px), `PlanCard.vue:210` (0 8px, 12px), `Sidebar.vue:168` (0 6px, 11px). `.mini.on` exists only in `ChangesTab.vue:267`.
- **Borderless text or link buttons ×9:** `QueueView.vue:156` (`.link`), `LogView.vue:103` (`.file`), `OverviewTab.vue:141` (`.more`) and `:191` (`.runlink`), `PlanCard.vue:184` (`.step`), `DocumentsCard.vue:82` (`.name`), `ReposPanel.vue:194` (`.head`), `Sidebar.vue:135` (`button.v`), `ChangesTab.vue:331` (`.fold`). Each repeats `border: none; background: none; padding: 0`.
- **Icon-only ×3:** `Modal.vue:55` (`.x`), `FilterBar.vue:103` (`.x`), `TaskPage.vue:194` (`.back`, unstyled).
- **Dashed "add" button:** `FilterBar.vue:109`.
- **Segmented control:** `style.css:234-252` (`.seg`), well factored and used in 3 places. The tab strip in `TaskPage.vue:246-265` is the same idea with an underline, and the "on" state is spelled three ways across the app: `.on` (`.seg`, `.mini`, `.prop`, tabs), `.sel` (list rows, tree rows, board cards) and `[aria-selected]`.

**Make one:** `Button` with `variant` (default, primary, ghost, link) and `size` (sm, md), plus the existing `.seg`. The global `button` element rule should stop being the thing every ghost button has to undo.

### 3.4 Callouts and banners

There is exactly one callout, `TaskPage.vue:274-280` (`.callout`: 40% border, 9% tint, driven by `--c`), rendered three times in `TaskPage.vue:146-152`. The same idea is written differently elsewhere:

- Inline form error: `.error` is defined three times, identically (`NewTaskForm.vue:128`, `ReposPanel.vue:286`, `SettingsPanel.vue:339`).
- Hint under a column: `.hint` (`BoardView.vue:128`) and `.hint` (`SettingsPanel.vue:265`).
- Offline notice: `App.vue:180-193`.
- Toast: `App.vue:194-204`, its own dark-on-light inverted style.
- Empty or note paragraphs: `.note` (`ChangesTab.vue:237`), `.pad` (`LogView.vue:121`, `RunsTab`, `CodeTab.vue:190`, `ChangesTab.vue:346`), `.empty` (`QueueView.vue:153`).

**Make one:** `Callout` (tone, optional title) for the page-level banners and form errors, and a `Toast` that sits on the z-index scale.

### 3.5 Form fields

- Label-over-input stack: `NewTaskForm.vue:102`, `ReposPanel.vue:255`, `SettingsPanel.vue:274`. Identical `display: flex; flex-direction: column; gap: 4px`.
- Checkbox label: `.check` in `ReposPanel.vue:261`, `SettingsPanel.vue:299`, `ChangesTab.vue:270`.
- `input { width: 100% }` is global (`style.css:89`), which forces five components to undo it for checkboxes and radios with `width: auto` (`ReposPanel.vue:269`, `SettingsPanel.vue:304`, `FilterBar.vue:145`, `ChangesTab.vue:278`, `DisplayMenu.vue:80`). The global rule should target text-like inputs only.
- `.row` / `.actions` flex rows: `NewTaskForm.vue:108,118`, `ReposPanel.vue:272,276`, `SettingsPanel.vue:331`.
- The small uppercase section label: `.sec` in `DisplayMenu.vue:83` and `FilterBar.vue:127` (same declarations).

### 3.6 Tables and lists

Only one true `<table>`: `DiffView.vue:45-77` (unified and split). Markdown tables are styled in `Markdown.vue:94-103`. Everything that looks tabular elsewhere is flex rows (`ListView.vue:127` rows, `RunsTab.vue:76` cards, `Sidebar.vue:119` property rows). Each of those hand-rolls a `border-bottom: 1px solid var(--border)` row. There is no table to extract, but a `Row` pattern (min-height, padding, bottom border, selected = accent tint plus inset bar) exists in `ListView.vue:127-139` and `RunsTab.vue:76-93`.

The "+n −n" add and del counts are written twice (`ChangesTab.vue:246-259`, `FileTree.vue:231` `.meta`) and the `+`/`−` signs are different characters in places (`−` U+2212 in templates, `-` elsewhere).

### 3.7 Popovers and overlays

- `Popover.vue:39-51`: anchored menu panel (`--panel`, `--border`, 8px radius, shadow, 6px padding, z 20).
- `SnippetPopover.vue:73-84`: a second, separately styled floating panel with the same background, border, radius and shadow, positioned by hand in JS (`:43`, `:66`).
- `Modal.vue:27-44`: backdrop, dialog and header.
- Menu rows exist twice: `.opt` (`FilterBar.vue:134`) and `.line` (`DisplayMenu.vue:69`).

**Make one:** a `Surface` with `elevation` (popover, modal) that owns background, border, radius, shadow and z-index. `Popover` and `SnippetPopover` should share it.

### 3.8 Utilities that are copy-pasted

- `.spacer { flex: 1 }`: seven copies (`StatusBar.vue:119`, `BoardView.vue:162`, `SettingsPanel.vue:336`, `ChangesTab.vue:260`, `CodeTab.vue:183`, `FilterBar.vue:120`, plus a margin-left:auto variant in `FilterBar`).
- Truncate (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`): about fourteen copies.
- Two-line clamp (`-webkit-line-clamp`): `BoardView.vue:168`, `ReposPanel.vue:240`.
- `<kbd>`: `QueueView.vue:171` and `CodeTab.vue:204`, same rule.
- Mono text: see the 16 copies in section 2.

## 4. Hard-coded values

Colours that bypass the tokens:

| Value                             | Where                                                     | Problem                                             |
| --------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `#8250df` (purple)                | `ListView.vue:184-185` (`.pr-merged`)                     | Not themed. 3.3:1 on the dark panel (section 5).    |
| `rgb(0 0 0 / .35)`                | `Modal.vue:30`                                            | Same scrim in both themes.                          |
| `rgb(0 0 0 / …)`                  | `Modal.vue:43`, `Popover.vue:49`, `SnippetPopover.vue:81` | See section 2.                                      |
| `white` via `--accent-text: #fff` | `style.css:9`, never overridden in dark                   | White on the dark accent fails (section 5).         |
| `Canvas` / `CanvasText`           | `PlanCard.vue:17`                                         | Intentional (plan iframe), but follows the OS only. |
| `black` in mask                   | `OverviewTab.vue:139`                                     | Alpha mask only, fine.                              |

Everything else uses `var(--…)`, and the `color-mix` tints are all expressed against tokens. That is good: the dark theme works wherever a token is used, which is nearly everywhere.

Non-colour literals (see section 2 for the full scale gaps): 16 mono font stacks, 15 literal `8px` radii, five z-index numbers, three shadows, three breakpoints, six layout widths, the `window.innerWidth - 560` in script, and `setTimeout(…, 3500)` for the toast (`App.vue:30`).

## 5. Contrast

Ratios against WCAG 2.x. "Tint" means the 12 to 16% status tint used by pills and the 14% added-line diff background.

### 5.1 Light theme

Neutrals and accent:

| Pair                                               | Ratio     | Result                                                       |
| -------------------------------------------------- | --------- | ------------------------------------------------------------ |
| `--text` on `--panel`                              | 17.0      | pass                                                         |
| `--muted` (#6d6d68) on `--panel`                   | 5.2       | pass                                                         |
| `--muted` on `--bg`                                | 4.8       | pass                                                         |
| `--muted` on `--panel-2` (headers, `.seg.on`)      | 4.55      | pass, barely                                                 |
| `--muted` on `--code-bg`                           | 4.6       | pass, barely                                                 |
| `--muted` on diff gutter, added line (22% green)   | ≈4.0      | **fail** (`DiffView.vue:138-141`, line numbers)              |
| `--accent` (#c2622d) on `--panel`                  | 4.1       | **fail** (links, `.link`, `.more`, `.hint`, hover text)      |
| `--accent` on `--panel-2` / `--bg`                 | 3.6 / 3.8 | **fail** (`Markdown.vue:104` links on `--bg`, code-tab hint) |
| `--accent-text` (#fff) on `--accent`               | 4.1       | **fail** (every `.primary` button, 13px text)                |
| `--border` on `--panel` (input and checkbox edges) | 1.3       | **fail** for a control boundary (3:1 needed, SC 1.4.11)      |

Status colours as text on `--panel`, then on their own tint:

| Token (light)         | On panel | On its tint | Result              |
| --------------------- | -------- | ----------- | ------------------- |
| `--queued` #8a8a84    | 3.5      | ≈3.0        | **fail**            |
| `--running` #2f6fdb   | 4.75     | ≈4.0        | pill **fail**       |
| `--done` #2e8b57      | 4.2      | ≈3.6        | **fail**            |
| `--blocked` #c98a10   | 2.95     | ≈2.6        | **fail**, the worst |
| `--failed` #c94141    | 4.9      | ≈4.0        | pill **fail**       |
| `--cancelled` #9a9a94 | 2.8      | n/a         | **fail**            |

Where these are used as text: pills (`style.css:150`, `TaskPage.vue:231`), the blocked reason line (`ListView.vue:159-168`), `.paused` (`ReposPanel.vue:206`), `.chip` in CodeTab, the `ok`/`bad` run labels (`RunsTab.vue:109-114`), `OverviewTab.vue:200` outcome, `+n`/`−n` counts (`ChangesTab.vue:246-259`), the plan step icons (`PlanCard.vue:169-179`) and `.badge` letters (`style.css:264-275`). As icon fills (`StatusIcon`, `PriorityIcon`) the 3:1 non-text bar applies and every colour except `--blocked` (2.95) and `--cancelled` (2.8) clears it. Shapes already differ per state, which is the right call.

Syntax highlighting, on `--panel` (code view) and on the added-line tint (diff):

| Token (light)          | On panel | On added line | Result                                                                   |
| ---------------------- | -------- | ------------- | ------------------------------------------------------------------------ |
| `--hl-keyword` #a1328f | 6.2      | 5.2           | pass                                                                     |
| `--hl-string` #2d7d46  | 5.1      | ≈4.3          | pass on panel, **fail** in diff                                          |
| `--hl-number` #b45d06  | 4.7      | ≈3.9          | pass on panel, **fail** in diff                                          |
| `--hl-comment` #8a8a84 | 3.5      | ≈2.9          | **fail** both (`.hljs-comment` is also italic and used for `.hljs-meta`) |
| `--hl-title` #2f5fc4   | 5.9      | ≈5.0          | pass                                                                     |
| `--hl-type` #8b5a00    | 5.9      | ≈5.0          | pass                                                                     |
| `--hl-attr` #7a4fcf    | 5.5      | ≈4.6          | pass                                                                     |

### 5.2 Dark theme

| Pair                                                 | Ratio      | Result                                |
| ---------------------------------------------------- | ---------- | ------------------------------------- |
| `--text` on `--panel`                                | 13.8       | pass                                  |
| `--muted` (#9a9993) on `--panel` / `--panel-2`       | 5.8 / 5.2  | pass                                  |
| `--accent` (#e07a43) on `--panel`                    | 5.5        | pass                                  |
| `--accent-text` (#fff, not overridden) on `--accent` | 3.0        | **fail** (`.primary` buttons in dark) |
| `--border` on `--panel`                              | 1.3        | **fail** as a control edge            |
| `#8250df` (PR merged) on `--panel`                   | 3.3        | **fail**                              |
| `--hl-comment` #7f7e78 on `--panel` / `--code-bg`    | 4.1 / 4.3  | **fail**                              |
| `--cancelled` #77766f on its tint                    | ≈3.1       | **fail**                              |
| `--queued` #8f8e88 on its tint                       | ≈4.1       | **fail**, borderline                  |
| `--failed` #e36d6d on its tint                       | ≈4.3       | **fail**, borderline                  |
| `--running`, `--done`, `--blocked` on their tints    | 4.8 to 6.5 | pass                                  |
| Other `--hl-*` on `--panel`                          | 8 to 11    | pass                                  |

### 5.3 Other accessibility notes

- **No `color-scheme` on `:root`.** In dark mode the native checkbox, radio, number-spinner, select popup and scrollbars stay light. This is the cheapest visible fix in the whole app.
- **Focus.** Only text inputs have a styled focus state (`style.css:91-96`, a 40% accent outline whose real signal is the border change). Buttons use the browser default, which the many `border: none` ghost buttons keep, but there is no `:focus-visible` rule at all.
- **Reduced motion.** `pulse` (`style.css:144`) and the transitions are unconditional.
- **Colour is never the only signal**, which is good: `StatusIcon.vue:6` gives each state its own shape, and pills carry a label.
- **Disabled controls** use `opacity: .5` (`style.css:70-73`), which is exempt from the contrast rules but also makes the disabled primary button almost vanish in light mode.

## 6. Blockers for a Tailwind v4 port or a theme switch

### 6.1 Theme switch (manual light, dark, system)

1. **The dark palette is two disconnected media queries.** `style.css:26-43` (app colours) and `:172-182` (syntax colours) each repeat the full `@media (prefers-color-scheme: dark)` selector. A manual switch needs the dark values attached to an attribute (`[data-theme="dark"]`) with the media query only applying when no explicit choice is set (`:root:not([data-theme])`). That means moving the values once, not duplicating them a third time.
2. **No `color-scheme`** (section 5.3), and the `--accent-text` / `--hl-*` / purple gaps mean dark mode is not complete today.
3. **The plan iframe ignores the app.** `PlanCard.vue:15-26` injects `color-scheme: light dark` into the plan's `srcdoc`, so a plan follows the OS even if the app is forced to the other theme. The injected style must receive the active scheme, and the cached `html` (`:28`) needs re-rendering on a theme change (it is only reloaded when `plan.updated_at` moves, `:42`). A plan that ships its own styles still wins, by design.
4. **Window chrome.** Tauri's title bar follows the OS unless the native window theme is set. Forcing the app dark on a light Mac will show a light title bar unless `setTheme` is called from `native.ts`.
5. **Persistence.** `lib/task/task-view.ts` already has `loadSetting` / `saveSetting` (localStorage), which is the obvious home. The stored value must be applied before first paint (a one-line inline script in `index.html` or applying it at the top of `main.ts`) to avoid a light flash. The CSP allows inline styles but the page has no inline script today.
6. **Colour mixed in JS or class strings.** `api.ts:377-393` (`describeState`) returns class names (`s-blocked`, `s-failed`, …) as strings. That is fine for theming, but it ties the TS layer to CSS class names, which matters for the Tailwind point below.

### 6.2 Tailwind v4

1. **Unlayered global CSS beats utilities.** Tailwind v4 emits its utilities inside `@layer`. Rules outside any layer win regardless of specificity. `style.css` is entirely unlayered, so `button { background: var(--panel-2); border: … }` (`:57`), `input { width: 100% }` (`:89`) and every scoped `<style>` block would override utility classes such as `bg-transparent`, `p-0` or `w-auto`. Before any port, wrap the global element rules in `@layer base` and the shared classes (`.pill`, `.seg`, `.badge`) in `@layer components`. Scoped component styles are also unlayered and must be removed from a component as it is converted, or they will silently outrank its utilities. Port component by component, not file by file.
2. **Preflight changes the defaults the code relies on.** Preflight zeroes margins on `h1`-`h6`, `p`, `ul`, `ol`, `pre`, `figure`, `blockquote`, `dl`; removes list bullets and padding; sets `border: 0 solid` (so any `border-bottom: 1px` without a colour becomes `currentColor`); makes `img`, `svg`, `video` `display: block`; and resets button and form-control fonts and backgrounds. The app has several unstyled `<p>` / `<h4>` / `<ul>` blocks inside modals that currently depend on browser margins (for example `SettingsPanel.vue:133` hints and `ReposPanel.vue:148`). They will lose their spacing. The `.md` rules in `Markdown.vue` set their own margins and survive.
3. **The root font size is 13px, not 16px.** `style.css:19` sets 13px on `:root`, and Tailwind's scale is in `rem`. `text-sm`, `p-4` and `w-64` would all come out about 19% smaller than intended. Either set `html { font-size: 16px }` and put the 13px on `body`, or redefine `--text-*` and `--spacing` in px inside `@theme`. The proposed token set below takes the second route (`--spacing: 4px`, px type sizes).
4. **Token names do not match Tailwind's namespaces.** `--bg`, `--panel`, `--muted` would not generate `bg-panel` or `text-muted`; v4 reads `--color-*`, `--text-*`, `--radius-*`, `--shadow-*`, `--font-*`, `--spacing`, `--breakpoint-*`. Because the semantic tokens must change with the theme, define them as plain custom properties on `:root` / `[data-theme]` and expose them with `@theme inline { --color-panel: var(--panel); }`. The `inline` keyword is required, otherwise Tailwind resolves the variable at the wrong scope and the dark override never applies.
5. **Dynamic class names are invisible to the scanner.** The app builds classes from data: `` `s-${t.status}` `` (`ListView.vue:56`, `TaskPage.vue:115,146`, `RunsTab.vue:25`), `` `b-${f.status}` `` (`FileTree.vue:166`, `ChangesTab.vue:189`), `` `st-${s.status}` `` (`PlanCard.vue:82`), `` `pr-${state}` `` (`ListView.vue:75`), `` `p-${level}` `` (`PriorityIcon.vue:13`), `` `k-${e.kind}` `` (`LogView.vue:66`), plus strings returned from `api.ts:377-393`. Tailwind cannot generate utilities from `` `bg-${tone}` ``. Keep these as `data-status` / `--c` hooks with real CSS, or replace them with complete literal maps (`{ done: 'text-done', … }`).
6. **Injected HTML cannot take utilities.** `.hljs-*` (`style.css:183-231`) and `.md` (`Markdown.vue:27-114`) style `v-html` output, and `DOMPurify` strips classes it does not know. These stay as hand-written CSS in `@layer components`, reading the same tokens. The `.hljs` token colours must remain CSS variables, not utilities.
7. **`@apply` in SFC style blocks needs `@reference`.** Each `<style>` that uses `@apply` or theme variables must start with `@reference "../style.css";` (path per file). Preferred route is utilities in the template and deleting the `<style>` block, which also removes blocker 1 for that file.
8. **`color-mix(in srgb, …)` appears about 25 times.** Tailwind v4's opacity modifier (`bg-accent/10`) compiles to `color-mix(in oklab, …)`, which gives slightly different tints than today's srgb mixes, and it mixes with `transparent`, not with `--panel`. The existing tints are over a surface (for example `color-mix(in srgb, var(--blocked) 18%, var(--panel))`). Define the tints as tokens (`--accent-soft`, `--diff-add`, …) rather than rebuilding each one with a modifier.
9. **Tailwind v4 baseline browser targets** are Safari 16.4+, Chrome 111+, Firefox 128+. The Tauri webview on macOS is WKWebView, so check `bundle.macOS.minimumSystemVersion` in `app/src-tauri/tauri.conf.json` (not set in the fields read for this audit) against the macOS version that ships Safari 16.4 (macOS 13.3). The app already depends on `color-mix` (Safari 16.2), so the delta is small.
10. **Tooling compatibility must be checked, not assumed.** The app is on Vite 8. `@tailwindcss/vite` declares a peer range on Vite; confirm the installed Tailwind 4.x release accepts Vite 8 before starting. `pnpm-lock.yaml` has no Tailwind entry today. Per the project rules, adding the dependency (`tailwindcss`, `@tailwindcss/vite`) needs a stated reason; the reason is "the design system becomes tokens plus utilities instead of a scoped block per component that each redeclare the same card, chip and button". It is a build-time dependency only (`devDependencies`), so no runtime dependency is added.
11. **The CSP is not a blocker.** `style-src 'unsafe-inline'` is already allowed and Tailwind produces one static CSS file.
12. **Breakpoints and widths** (section 2) become `--breakpoint-*` and spacing multiples. The three media queries are `max-width`; Tailwind's variants are `min-width`. Convert, don't copy.
13. **`dark:` variant default is the media query.** With semantic tokens that already swap per theme, no `dark:` classes are needed. If any are used, add `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));` or they will ignore the manual switch.

### 6.3 Smaller things that would trip either task

- `h1` at `TaskPage.vue:201` and the global `button`/`input` rules assume no other base styles; do not add a Tailwind base on top without step 6.2.1.
- The `.s-*` / `--c` trick works with Tailwind via `bg-[color-mix(in_srgb,var(--c)_12%,transparent)]`, but a named `.chip` / `.pill` component class (in `@layer components`) is clearer and keeps the dynamic part in one place.
- `StatusIcon.vue` and `PriorityIcon.vue` use `var(--panel)` as the glyph colour inside filled shapes (`StatusIcon.vue:54-65`, `PriorityIcon.vue:17-19`). That is correct for both themes, but it should read as a token (`--on-status`) so a future theme with a coloured panel does not break it.
- `StatusIcon.vue:68-70` hard-wires `--blocked` for the blocked and stuck glyphs while the rest use `--c`. Harmless today, but a status that changes hue per theme will need both to agree.

## Proposed token set

For the two follow-up tasks (themes, then Tailwind). Principles:

- **Semantic names, two value sets.** Components never see a hex. The names below are the plain custom properties; the Tailwind task exposes them as `--color-*` through `@theme inline`.
- **Text-safe status colours.** The status tokens are the ones used for text, icons and pill labels, tuned to reach 4.5:1 on the panel and on their own 12% tint. The tint is a separate rule (`--tint-status`).
- **Change as little as possible.** Neutrals keep their warm grey. Only values that failed in section 5 move.
- Ratios below are hand-computed; recheck with a script (WCAG relative luminance, both themes, panel and tint) as the first act of the theme task.

### Colour

| Token            | Light           | Dark            | Notes                                                               |
| ---------------- | --------------- | --------------- | ------------------------------------------------------------------- |
| `--bg`           | `#f6f6f4`       | `#161615`       | unchanged                                                           |
| `--panel`        | `#ffffff`       | `#1f1f1d`       | unchanged                                                           |
| `--panel-2`      | `#f0f0ed`       | `#272725`       | unchanged                                                           |
| `--code-bg`      | `#f3f2ee`       | `#1a1a18`       | unchanged                                                           |
| `--border`       | `#e2e2dd`       | `#33332f`       | decorative dividers only                                            |
| `--border-input` | `#8f8f89`       | `#6f6e68`       | **new.** Control edges: 3.2:1 on panel in both themes               |
| `--text`         | `#1d1d1b`       | `#ecebe6`       | unchanged                                                           |
| `--muted`        | `#5f5f5a`       | `#9a9993`       | light darkened from `#6d6d68`: 6.4 on panel, 4.9 on the diff gutter |
| `--accent`       | `#a8501f`       | `#e07a43`       | light darkened from `#c2622d`: 5.5 on panel, 4.8 on `--panel-2`     |
| `--accent-fg`    | `#ffffff`       | `#161615`       | renamed from `--accent-text`; dark was white at 3.0, now 6.1        |
| `--focus`        | `var(--accent)` | `var(--accent)` | **new.** 2px outline for `:focus-visible` on every control          |
| `--queued`       | `#6b6b66`       | `#9a9993`       | 5.4 on panel                                                        |
| `--cancelled`    | `#6b6b66`       | `#9a9993`       | shares the grey with `--queued`; the icon shape already differs     |
| `--proposed`     | `var(--accent)` | `var(--accent)` | was an implicit alias in `.s-proposed` (`style.css:115`)            |
| `--running`      | `#2563c9`       | `#6c9bf0`       | 5.7 on panel                                                        |
| `--done`         | `#23744a`       | `#57b583`       | 5.7 on panel                                                        |
| `--blocked`      | `#8a5a00`       | `#e0ab3c`       | amber becomes a brown in light; the old `#c98a10` was 2.95          |
| `--failed`       | `#b53030`       | `#ee7f7f`       | 6.1 on panel; dark lifted from `#e36d6d`                            |
| `--merged`       | `#7340c8`       | `#b99cf5`       | **new**, replaces the hard-coded `#8250df`                          |
| `--on-status`    | `var(--panel)`  | `var(--panel)`  | **new.** Glyph colour on filled status and priority icons           |

Derived (written once, as `color-mix` over tokens, so they follow the theme):

| Token               | Definition                                             | Replaces                                                |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `--tint-status`     | `12%`                                                  | pill 14% and 16%, callout 9%                            |
| `--accent-soft`     | `color-mix(in srgb, var(--accent) 10%, var(--panel))`  | selected rows 8%, board drop 10%, tree 14%, prop on 12% |
| `--accent-line`     | `color-mix(in srgb, var(--accent) 40%, transparent)`   | dashed drop target, callout borders                     |
| `--diff-add`        | `color-mix(in srgb, var(--done) 14%, var(--panel))`    | `DiffView.vue:132`                                      |
| `--diff-add-gutter` | `color-mix(in srgb, var(--done) 22%, var(--panel))`    | `DiffView.vue:140`                                      |
| `--diff-del`        | `color-mix(in srgb, var(--failed) 13%, var(--panel))`  | `DiffView.vue:136`                                      |
| `--diff-del-gutter` | `color-mix(in srgb, var(--failed) 20%, var(--panel))`  | `DiffView.vue:144`                                      |
| `--diff-hunk`       | `color-mix(in srgb, var(--running) 9%, var(--panel))`  | `DiffView.vue:126`                                      |
| `--line-hl`         | `color-mix(in srgb, var(--blocked) 18%, var(--panel))` | `CodeView.vue:71` (gutter 26%)                          |
| `--scrim`           | `rgb(0 0 0 / .35)` light, `rgb(0 0 0 / .6)` dark       | `Modal.vue:30`                                          |

Syntax (the `.hljs-*` classes keep their names and read these):

| Token          | Light     | Dark      | Notes                                                     |
| -------------- | --------- | --------- | --------------------------------------------------------- |
| `--hl-keyword` | `#a1328f` | `#e08bd6` | unchanged                                                 |
| `--hl-string`  | `#276b3d` | `#8fd3a0` | light darkened: 5.9 on panel, 4.9 on diff add             |
| `--hl-number`  | `#9a4f05` | `#f0b070` | light darkened: 5.4 on panel, 4.5 on diff add             |
| `--hl-comment` | `#666660` | `#94938d` | light was 3.5 and dark 4.1; now 5.7 and 4.9, still italic |
| `--hl-title`   | `#2f5fc4` | `#8fb4ff` | unchanged                                                 |
| `--hl-type`    | `#8b5a00` | `#e8c47a` | unchanged                                                 |
| `--hl-attr`    | `#7a4fcf` | `#c3a6ff` | unchanged                                                 |

### Type

| Token                                                       | Value                                                                      | Replaces                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `--font-sans`                                               | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif` | `style.css:18`, `PlanCard.vue:17`                |
| `--font-mono`                                               | `ui-monospace, 'SF Mono', Menlo, monospace`                                | the 16 copies                                    |
| `--text-2xs`                                                | `10px`                                                                     | file badges, tree chevrons (8px mark becomes 10) |
| `--text-xs`                                                 | `11px`                                                                     | kbd, small print, counts; absorbs 11.5           |
| `--text-sm`                                                 | `12px`                                                                     | secondary text, chips, code; absorbs 12.5        |
| `--text-base`                                               | `13px`                                                                     | body                                             |
| `--text-md`                                                 | `14px`                                                                     | brand, plan body                                 |
| `--text-lg`                                                 | `16px`                                                                     | modal title (was 15), offline title              |
| `--text-xl`                                                 | `20px`                                                                     | task title; title input (was 18) matches it      |
| `--leading-tight`                                           | `1.3`                                                                      | headings                                         |
| `--leading-normal`                                          | `1.45`                                                                     | body                                             |
| `--leading-code`                                            | `1.5`                                                                      | code, diff (was 1.5 and 1.55)                    |
| `--leading-prose`                                           | `1.55`                                                                     | `.md`                                            |
| `--weight-normal` / `--weight-medium` / `--weight-semibold` | `400` / `500` / `600`                                                      | the `650` brand weight becomes 600               |

### Space, shape, depth

| Token                                     | Value                                                                            | Notes                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `--spacing`                               | `4px`                                                                            | The unit. Tailwind's `p-1` = 4px, `p-2` = 8px                                             |
| scale in use                              | 0.5 (2), 1 (4), 1.5 (6), 2 (8), 2.5 (10), 3 (12), 4 (16), 5 (20), 6 (24), 7 (28) | 5, 7, 14, 18, 22, 26 snap to the nearest step                                             |
| `--radius-xs`                             | `4px`                                                                            | kbd, inline code                                                                          |
| `--radius-sm`                             | `6px`                                                                            | buttons, inputs, `.seg`, tree rows (was 5)                                                |
| `--radius-md`                             | `8px`                                                                            | cards, popovers, board cards, board columns (was 10)                                      |
| `--radius-lg`                             | `12px`                                                                           | modal                                                                                     |
| `--radius-pill`                           | `999px`                                                                          | chips, pills, progress tracks (was 3)                                                     |
| `--shadow-popover`                        | light `0 8px 28px rgb(0 0 0 / .18)`, dark `0 8px 28px rgb(0 0 0 / .5)`           | menu and snippet panels (was .18 and .22)                                                 |
| `--shadow-modal`                          | light `0 20px 60px rgb(0 0 0 / .25)`, dark `0 20px 60px rgb(0 0 0 / .6)`         | dialog                                                                                    |
| `--z-sticky`                              | `1`                                                                              | list group and file headers                                                               |
| `--z-modal`                               | `10`                                                                             | backdrop                                                                                  |
| `--z-popover`                             | `20`                                                                             | menus                                                                                     |
| `--z-snippet`                             | `30`                                                                             | hover snippet                                                                             |
| `--z-toast`                               | `40`                                                                             | **new.** The toast was under the scrim                                                    |
| `--dur-fast` / `--dur`                    | `120ms` / `400ms`                                                                | caret turn, meter fill. Pulse (1.4s) stays and is disabled under `prefers-reduced-motion` |
| `--breakpoint-sm` / `-md` / `-lg`         | `720px` / `900px` / `1080px`                                                     | the three existing media queries                                                          |
| `--w-sidebar` / `--w-tree` / `--w-column` | `240px` / `260px` / `260px`                                                      | optional; `CodeTab` side (280) snaps to 260 or the tree to 280                            |

### Components these tokens should land in

In the order that removes the most duplication: `Card` (+ header) → `Chip` → `Button` (variants: default, primary, ghost, link; sizes sm and md) → `Callout` and `Toast` → `Surface` (shared by `Popover`, `SnippetPopover`, `Modal`) → form helpers (`Field`, `Check`, `FormActions`). Four small utilities cover the rest: `spacer`, `truncate`, `clamp-2`, `mono`.

### Order of work for the next two tasks

1. **Themes.** Add `color-scheme`, move the values above into `:root` and `[data-theme="dark"]` (plus the media query for "system"), fix `--accent-text`, replace `#8250df`, add `--border-input` and `:focus-visible`, add the toggle with persistence in `lib/task/task-view.ts`, apply the stored theme before first paint, pass the scheme into the plan iframe and call the native window theme. No Tailwind yet; this is pure CSS and can be checked with the contrast script.
2. **Tailwind.** Add the plugin, wrap the existing global rules in `@layer base` and `@layer components` first (blocker 6.2.1), map the tokens with `@theme inline`, then convert one component family at a time (the card and chip components first, since they remove the most CSS). Leave `.hljs-*` and `.md` as CSS.
