# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install           # Install deps (no node_modules by default — run after clone)
npm run compile        # One-off TypeScript build (outputs to dist/)
npm run watch          # Watch mode for development (preferred during active development)
npm run lint           # ESLint check (runs against src/)
npm run test           # Compile + lint + run all tests
npx tsc --noEmit       # Type-check only — IDE diagnostics can be stale; use this to verify
```

Press **F5** in VS Code to launch the Extension Development Host.

---

## What This Extension Does

**Obsidian Artifacts: AI Snippets & Tools** bridges an Obsidian vault and VS Code, letting developers insert vault content — snippets, templates, commands, agent configs, and variables — directly into the editor or terminal without leaving VS Code.

The current feature set:

- **Config page** — a webview panel where the user selects their Obsidian vault root, validates it, and enables or disables artifact directories.
- **Artifact picker** — a `vscode.QuickPick`-based hierarchical navigator that opens when the user triggers an insert command. The user navigates subfolders, selects a `.md` file. A side-by-side **interactive preview panel** shows the parsed metadata, an editable code area (with line numbers, syntax highlighting, and `<VK-xxx>` token spans), and variable input fields. The user fills in variable values and clicks **Insert** — resolved content is injected at the cursor or sent to the terminal. An **Edit .md** button opens the real vault file in a VS Code editor tab for permanent changes.

---

## Folder Structure

```
src/
├── extension.ts                      # Entry point — activate() / deactivate()
├── commands/
│   ├── openSettings.command.ts       # Registers obsidian-artifacts.settings
│   └── insert.command.ts             # Dynamically registers one insert command per artifact
├── services/
│   ├── vault.service.ts              # validateObsidianVault(), detectVaultDirs(), createVaultDirectory()
│   ├── context.service.ts            # setVaultContextKeys(), refreshVaultContext()
│   ├── parser.service.ts             # parseArtifactFile(), parseFromContent(), parseBlocks(), extractVars(), resolveVars()
│   ├── render.service.ts             # renderCodeHtml(), renderCodeRowsHtml(), renderLineHtml()
│   ├── artifact-patcher.service.ts   # patchFrontmatterField(), patchVarDefaults()
│   ├── preview-mode.service.ts       # PreviewModeController — mode state + section editing
│   └── temp-document.service.ts     # TempDocument — scratch VS Code editor tab for full edit
├── ui/
│   ├── panels/
│   │   ├── artifactPicker.panel.ts   # Artifact picker (QuickPick navigator + popup webview)
│   │   └── settings.panel.ts        # Settings webview panel (UI + message handling)
│   └── styles.css                   # Shared webview stylesheet — loaded via webview.asWebviewUri()
├── types/
│   ├── constants.ts                  # ARTIFACTS — master list of artifact directories
│   ├── artifact.types.ts             # Artifact, ArtifactContext, ArtifactsArray interfaces
│   ├── parsed-artifact.types.ts     # ParsedArtifactFile, ParsedBlock, ParsedFrontmatter, ParsedVar, VaultEntry
│   └── webview-messages.types.ts    # Typed message shapes exchanged between extension and webviews
├── utils/
│   └── helpers.ts                    # getNonce() for CSP nonces
├── features/                         # (empty) reserved for future domain features
└── providers/                        # (empty) reserved for future VS Code providers
test/
├── extension.test.ts                 # Mocha test suite
├── artifact-patcher.test.ts          # Unit tests for artifact-patcher.service
├── preview-modes.test.ts             # Unit tests for preview-mode.service
└── temp-document.test.ts             # Unit tests for temp-document.service
```

---

## Architecture

### Entry point

`src/extension.ts` — `activate()` registers all commands, refreshes VS Code context keys, and auto-opens the Settings panel on first use (when no vault is configured).

### Activation flow

1. `activate()` calls `registerOpenSettingsCommand(context)` and `registerInsertCommands(context)`.
2. `refreshVaultContext()` sets all VS Code context keys so context menus reflect the current vault state before the first user interaction.
3. If no vault path is stored in settings, the Settings panel opens automatically.
4. A `onDidChangeConfiguration` listener watches `obsidianArtifacts.*` for Settings Sync changes and re-creates any enabled directories that are missing.

### Settings panel (`src/ui/panels/settings.panel.ts`)

`openSettingsPanel(context)` creates a `WebviewPanel` (or reveals an existing one). When the user picks a folder:
- `validateObsidianVault()` confirms the folder contains a `.obsidian/` directory.
- `detectVaultDirs()` checks which `ARTIFACTS` directories exist on disk.
- Missing directories that are marked `default: true` in `ARTIFACTS` are auto-created.
- The vault path and feature flags are saved to `obsidianArtifacts.*` in VS Code settings (enabling Settings Sync).

### Artifact picker (`src/ui/panels/artifactPicker.panel.ts`)

`openArtifactPicker(dir, name)` validates the vault and artifact directory, then hands off to `ArtifactNavigator.run()`. There is no WebviewPanel — the entire picker is a `vscode.QuickPick`.

**`ArtifactNavigator` class:**
- Maintains a `dirStack` (parent URIs) and `currentDir` for hierarchical navigation.
- `loadDir(uri)` — reads the directory with `vscode.workspace.fs.readDirectory`, builds items with `$(folder)` / `$(file)` codicons, and updates the QuickPick title to show the breadcrumb path.
- `loadBlocks(artifact)` — replaces QuickPick items with one entry per `ParsedBlock`; pushes `currentDir` onto `dirStack` so the `..` back item works. Sets `currentArtifact` for preview/insert use.
- `handleActiveChange(items)` — fires (debounced 150 ms) on `onDidChangeActive`. Block item → preview via `blockAsArtifact` adapter. Multi-block file (`blocks.length > 1`) → `showMultiBlockPreviewPanel`. Otherwise → `showPreviewPanel` (read-only preview while navigating).
- `handleAccept()` — directory → `loadDir`; multi-block file → `loadBlocks`; block or single-block file → `keepPopupOnHide = true`, hide QuickPick, call `showPreviewPanel`, then `reveal(false)` to focus the panel. The QuickPick closes; the popup switches to interactive edit mode.
- `showPreviewPanel(artifact)` — ensures popup panel exists with `enableScripts: true`. Renders interactive HTML via `renderPreviewHtml` using `renderCodeRowsHtml` for the code area. Sends `{ command: 'switchMode', mode: 'edit' }` to the webview after file selection so the panel becomes interactive.
- `showMultiBlockPreviewPanel(artifact)` — renders all blocks via `renderCodeHtml`, builds `highlightedBlocks` array (sync), renders `renderMultiBlockPreviewHtml`. Panel created with `enableScripts: true`.
- `handleInsert(msg, artifact)` — reads edited code from the webview message, resolves `<VK-xxx>` tokens using a three-tier fallback: user-typed value → `v.defaultValue` → leave token unchanged. Calls `performInsert`.
- `handleFullEdit(artifact)` — opens the real vault `.md` file in a VS Code editor tab via `vscode.workspace.openTextDocument`. Saves write directly to disk. The popup panel remains open.

**Popup webview interactive mode (preview HTML script):**
- Code area is a `<div class="code-block-wrapper editable" contenteditable="true">` with per-line `<span class="line-number" contenteditable="false">` spans so line numbers cannot be edited.
- On `input`, debounces 150 ms then re-renders highlighted rows via the extension (posts `{ command: 'codeChanged', code }` and receives `{ command: 'updateRows', html }`), preserving caret position via text-node offset walking.
- Paste intercepted to strip HTML formatting; Enter intercepted to insert `\n` via `document.execCommand`.
- When new vars are detected (`updateVars` message), input fields are rebuilt preserving already-typed values.
- `fileUpdated` message from extension re-renders the code area and var fields (after save from full edit mode).

**Code preview rendering (`src/services/render.service.ts`):**
- Two export variants: `renderCodeHtml(code, fenceLang?)` returns a full `<div class="code-block-wrapper">…</div>` block; `renderCodeRowsHtml(code, fenceLang?)` returns only the inner rows (no wrapper). Use `renderCodeRowsHtml` when the caller supplies its own wrapper element (e.g. the editable code area in the preview panel) to avoid double-nesting.
- Output structure: one `<div class="code-line-row">` per line → `<span class="line-number" contenteditable="false">` + `<span class="code-content">`. Line numbers have `contenteditable="false"` so they cannot be edited when the wrapper is `contenteditable="true"`.
- Line numbers use `.line-number` (`user-select: none; opacity: 0.5`). Lines use `white-space: pre-wrap; word-break: break-all` — no horizontal scroll.
- `<VK-xxx>` tokens are wrapped in `<span class="vk-var">` as a post-pass after syntax highlighting. Tokens are protected from hljs splitting via identifier placeholders (`__VK0__`) before the hljs pass, then restored as `vk-var` spans after.
- `.vk-var` — orange accent (`var(--vscode-charts-orange, #e8a64a)`), bold, subtle background — applied via `src/ui/styles.css`.
- All preview colors use VS Code CSS variables (`--vscode-editor-font-family`, `--vscode-editorLineNumber-foreground`, `--vscode-charts-orange`, etc.) for automatic light/dark theme compatibility.

**Module-level helpers:**
- `blockAsArtifact(block, parent)` — adapts a `ParsedBlock` into a `ParsedArtifactFile` shape for preview/insert; inherits parent frontmatter, overrides `title`, `description`, `language`, `code`, `vars`.
- `performInsert(editor, artifact, vars)` — routes resolved content to the editor cursor, active terminal (`command` type), or clipboard fallback.
- `resolveVars(code, vars)` — substitutes `<VK-xxx>` tokens from the map; unmatched tokens are left unchanged.

**QuickPick variable display:**
- Variable names in QuickPick item descriptions strip the `VK-` prefix — e.g. `host` is shown instead of `VK-host`. The full `VK-` prefixed name is still used internally for substitution.

**Variable default value fallback:**
- In `handleInsert`, collected user input is resolved with a three-tier fallback:
  1. User-typed value (non-empty string) → used as-is.
  2. `v.defaultValue` (from the `vars:` section or auto-detected) → used if user left the field blank.
  3. Neither → token is left unchanged in the inserted code (i.e. `<VK-xxx>` is kept literally).

### Parser service (`src/services/parser.service.ts`)

Four exports: `parseArtifactFile(filePath, rootDir)` (sync, reads from disk), `parseFromContent(content, filePath, rootDir)` (takes a pre-read string — used by the QuickPick picker's async reads), `extractVars(code)`, and `resolveVars(code, vars)`. The parse functions extract:
- **Frontmatter** — YAML block between `---` fences (`type`, `title`, `description`, `language`, `tags`, `env`, `target`).
- **Code block** — content of the ` ```code ` fenced block, trailing whitespace trimmed.
- **Vars** — either a ` ```vars ` fenced block (for `type: variables`) or an unfenced `vars:` / `vars` section appearing after the code block.
- **Blocks** — `parseBlocks(content)` (also exported) scans for `## ` headings each followed by a fenced code block. Returns `ParsedBlock[]`; empty array signals a single-block file. `<VK-xxx>` vars in block code are auto-detected via `extractVars` with `defaultValue: ''`. Both parse exports assign the result to `blocks` on `ParsedArtifactFile`.

### Insert commands (`src/commands/insert.command.ts`)

`registerInsertCommands(context)` loops over `ARTIFACTS` and registers **one VS Code command per artifact** — all handled by the same `openArtifactPicker` function. This is architecturally "one insert command" (one loop, one handler, zero hardcoded names) while satisfying a hard VS Code constraint:

> VS Code derives a context-menu item's label **exclusively** from the `title` of the matching `contributes.commands` entry in `package.json`. Per-item title overrides in `contributes.menus` are silently ignored.

Because of this, showing "Insert Snippets", "Insert Templates", etc. as distinct labels requires distinct command IDs. The pattern is `obsidian-artifacts.insert.<dir.toLowerCase()>` — derived by `artifactCommandId(dir)`, which must match the IDs declared in `package.json`.

**Adding a new artifact type:**
1. Add the entry to `ARTIFACTS` in `src/types/constants.ts` — the handler auto-registers.
2. Add a matching `contributes.commands` entry in `package.json` with the correct title.
3. Add `contributes.menus` entries for the relevant context surfaces.

**Variables — special context behaviour:**
`Variables` has `contexts: ['all']`, so `insert.variables` appears in every context surface (editor, terminal, explorer) and carries the label **"See/Edit Variables"** (not "Insert…") to reflect its browse/edit semantics. In `package.json` it uses group `"2_variables@1"` while all other artifacts use `"1_insert@N"` — VS Code renders different groups with a visual separator, so Variables always appears at the bottom of the submenu, or as a standalone item below other artifacts when only it is active.

**Single entry vs. submenu:**
Each context surface shows a direct labelled entry for each active artifact when only one is active in that surface (`!obsidian-artifacts.<surface>HasMultiple`), or a collapsed "Obsidian Artifacts" submenu when two or more are active. The `*HasMultiple` context keys are managed by `context.service.ts` and updated whenever the vault configuration changes.

### Vault directory logic (`src/types/constants.ts` + `src/services/vault.service.ts`)

`ARTIFACTS` is the single source of truth for every artifact type. Each entry drives:
1. Which vault directories are created or detected.
2. Which VS Code context keys are set (via `context.service.ts`).
3. Which insert command is registered and where it appears (via `insert.command.ts` + `package.json`).

`default: true` entries (`Snippets`, `AgentsConf`) are auto-created when the vault is first selected. `default: false` entries (`Commands`, `Templates`, `Variables`) are detected but not created automatically.

### No runtime dependencies

Only the VS Code API, Node `fs`, and Node `path` are used — no third-party packages.

---

## Interactive Preview Panel

When the user presses Enter on a file in the QuickPick, the picker closes and the popup webview becomes the primary interaction surface:

- **Code area** — `<div class="code-block-wrapper editable" contenteditable="true">` with line numbers, syntax highlighting (hljs), and `<VK-xxx>` token spans. The user can type or paste directly. Line number spans are `contenteditable="false"` so they cannot be edited accidentally.
- **Variable inputs** — one `<input>` per `<VK-xxx>` token, labelled with the hint (no `VK-` prefix). Default values from the `vars:` section pre-fill each input.
- **Three buttons:**
  - **Insert** — resolves variables (user input → default → leave token) and calls `performInsert`.
  - **Edit .md** — opens the raw vault `.md` file in a real VS Code editor tab. Saving that file triggers a `fileUpdated` round-trip that refreshes the preview panel code area.
  - **Cancel** — closes the popup panel.

**CSP requirement:** The popup panel must be created with `enableScripts: true`. If it was previously created with `enableScripts: false` (e.g. while the user hovered a multi-block file first), all button handlers are silently blocked. The panel is always created with `enableScripts: true` to prevent this.

**Webview ↔ extension message protocol:**

| Direction | Command | Payload |
|---|---|---|
| webview → ext | `insert` | `{ code, vars: Record<string,string> }` |
| webview → ext | `fullEdit` | — |
| webview → ext | `cancel` | — |
| webview → ext | `codeChanged` | `{ code: string }` |
| ext → webview | `updateRows` | `{ html: string }` — re-rendered highlighted rows |
| ext → webview | `updateVars` | `{ vars: ParsedVar[] }` |
| ext → webview | `fileUpdated` | `{ code, vars }` — after .md save |
| ext → webview | `switchMode` | `{ mode: 'preview' \| 'edit' }` |

---

## Vault File Format

Each artifact is a `.md` file following this structure:

```md
---
type: snippet | template | command | agent | variables
title: Human-readable title
description: Short explanation
language: javascript
tags: [tag1, tag2]
---

```code
// Code content — <VK-xxx> tokens are replaced at insert time
const x = <VK-variableName>;
```

vars:
VK-variableName=defaultValue
VK-anotherVar=
```

A file with two or more `##` headings, each followed by a fenced code block, is a **multi-block file**. The picker shows its blocks as a sub-list; selecting one opens edit mode for that block only.

```md
---
type: snippet
title: API URLs
---

## Development
Local dev server.
\`\`\`bash
http://localhost:<VK-PORT>
\`\`\`

## Production
\`\`\`bash
https://api.example.com
\`\`\`
```

For `type: variables`, the content uses a ` ```vars ` block instead of a ` ```code ` block:

```md
---
type: variables
env: dev
---

```vars
API_URL=http://localhost:3000
DB_URL=mongodb://localhost:27017
```
```

---

## Variable Syntax — <VK-xxx>

The extension uses `<VK-xxx>` as the placeholder syntax for vault artifact variables.

- **`VK-`** is a fixed prefix. The hint after the hyphen can be any casing: `camelCase`, `UPPER_SNAKE`, `PascalCase`, `lowercase`.
- **Regex:** `/<VK-([A-Za-z][A-Za-z0-9_]*)>/g` — hint must start with a letter; subsequent characters may be letters, digits, or underscores.
- **Collision-free by design** — does not conflict with JS/TS generics or JSX, HTML tags, CSS, Vue (`v-` prefix differs), Python, Shell, Jinja, Handlebars (`{{}}` differs), or Markdown rendering. Visually distinct at a glance.
- **Token = variable name** — the full token including the `VK-` prefix is the variable name used for deduplication and substitution. `<VK-host>` → `name: 'VK-host'`.
- **Auto-detected from code** — `extractVars(code)` scans any code block for tokens automatically. A `vars:` section is still supported but only needed to supply non-empty default values; keys must also use the `VK-` prefix (e.g. `VK-host=localhost`).
- **Block-scoped in multi-block files** — in files with `## Heading` sections, each block's vars are extracted independently. The same token in two blocks produces a separate `ParsedVar` in each.

> **Rule:** When writing vault artifact `.md` files or test fixtures, always use `<VK-xxx>` syntax. Never use `{{xxx}}`.

---

## Key Config Files

| File | Purpose |
|---|---|
| `tsconfig.json` | Strict mode, `ES2022` target, `Node16` module resolution, `rootDir: "."`, output to `dist/` |
| `package.json` | `"main": "./dist/src/extension.js"` — mirrors the `rootDir: "."` output path |
| `eslint.config.mjs` | Enforces naming conventions, curly braces, `===` equality, semicolons |
| `.vscode/launch.json` | Debug launch with `--extensionDevelopmentPath`; other extensions disabled in the host |
| `.vscode/tasks.json` | `npm watch` is the default build task (runs automatically on F5) |
| `.vscode-test.mjs` | Test runner looks for compiled tests at `dist/test/**/*.test.js` |

---

## VS Code Extension Notes

- `activationEvents: []` in `package.json` — the extension activates on every window open. Narrow this to specific command events once commands stabilise.
- Compiled output goes to `dist/` and is **gitignored**. Run `npm run compile` after cloning.
- `media/` ships in the packaged extension. `src/`, `test/`, and `dist/test/` are excluded via `.vscodeignore`.
- All imports use explicit `.js` extensions (e.g. `'./helpers.js'`) — required by `Node16` module resolution even for `.ts` source files.
- Webview `localResourceRoots` is restricted to `extensionUri/src/ui` — all webview assets must live in `src/ui/`.

---

## Code Style

### Comments
- Every function and interface must have a JSDoc block that includes: a concise description, `@param` tags, a `@returns` tag, and at least one `@example`.
- Add inline section comments (e.g. `// ── Section name ───`) to visually group logical blocks within longer functions.
- Comments should explain **why**, not **what** — well-named identifiers already describe what the code does.

### File organisation
- Follow the folder structure defined above.
- Functions and classes belong in a `services/` or `utils/` file, not in command or panel files.
- Constants go in `src/types/constants.ts`.
- Types and interfaces go in `src/types/`.
- Webview panel logic (HTML generation + message handling) belongs in `src/ui/panels/`.

### ESLint gotchas
- Use `RegExp.exec(str)` not `str.match(re)` — rule `S6594`.
- Use `str.startsWith(x)` not `/^x/.test(str)` — rule `S6557`.
- No nested template literals — extract inner expression to a variable first — rule `S4624`.
- Cognitive complexity limit is 15 per function (`S3776`) — extract sub-methods when approaching it.
