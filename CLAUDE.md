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
- **Artifact picker** — a `vscode.QuickPick`-based hierarchical navigator that opens when the user triggers an insert command. The user navigates subfolders, selects a `.md` file (with a live side-by-side editor preview), fills in any `<VK-xxx>` variable values via `showInputBox`, and the resolved content is injected at the cursor (or into the terminal for `command`-type artifacts).

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
│   └── parser.service.ts             # parseArtifactFile(), parseFromContent(), parseBlocks(), extractVars(), resolveVars()
├── ui/
│   ├── panels/
│   │   ├── artifactPicker.panel.ts   # Artifact picker (QuickPick navigator + popup webview)
│   │   └── settings.panel.ts        # Settings webview panel (UI + message handling)
│   └── styles.css                   # Shared webview stylesheet — loaded via webview.asWebviewUri()
├── types/
│   ├── constants.ts                  # ARTIFACTS — master list of artifact directories
│   ├── artifact.types.ts             # Artifact, ArtifactContext, ArtifactsArray interfaces
│   └── parsed-artifact.types.ts     # ParsedArtifactFile, ParsedBlock, ParsedFrontmatter, ParsedVar, VaultEntry
├── utils/
│   └── helpers.ts                    # getNonce() for CSP nonces
├── features/                         # (empty) reserved for future domain features
└── providers/                        # (empty) reserved for future VS Code providers
test/
└── extension.test.ts                 # Mocha test suite
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
- `handleActiveChange(items)` — fires (debounced 150 ms) on `onDidChangeActive`. Block item → preview via `blockAsArtifact` adapter. Multi-block file (`blocks.length > 1`) → `showMultiBlockPreviewPanel`. Otherwise → `showPreviewPanel`.
- `handleAccept()` — directory → `loadDir`; multi-block file → `loadBlocks`; block item → `openEditMode(parent, block.code, block.vars)`; single-block file → `openEditMode(artifact)`.
- `openEditMode(artifact, codeOverride?, varsOverride?)` — ensures popup panel exists, renders `renderEditHtml`, waits for Insert/Cancel message. Overrides let a block's code/vars be shown while `artifact.frontmatter.type` drives command-vs-snippet routing.
- `showMultiBlockPreviewPanel(artifact)` — renders all blocks via `renderCodeHtml`, builds `highlightedBlocks` array (sync), renders `renderMultiBlockPreviewHtml`.

**Code preview rendering (`src/services/render.service.ts`):**
- All code previews use `renderCodeHtml(code, fenceLang?)` — never the old async `highlightCode` / `markdown.api.render` path.
- Output structure: `<div class="code-block-wrapper">` → one `<div class="code-line-row">` per line → `<span class="line-number">` + `<span class="code-content">`. The `code-line-row` class satisfies both the `code-line` and `code-line-row` CSS selectors; no separate `code-line` span exists.
- Line numbers use `.line-number` (`user-select: none; opacity: 0.5`). Lines use `white-space: pre-wrap; word-break: break-all` — no horizontal scroll.
- `<VK-xxx>` tokens are wrapped in `<span class="vk-var">` as a post-pass after syntax highlighting. Tokens are protected from hljs splitting via identifier placeholders (`__VK0__`) before the hljs pass, then restored as `vk-var` spans after.
- `.vk-var` — orange accent (`var(--vscode-charts-orange, #e8a64a)`), bold, subtle background — applied via `src/ui/styles.css`.
- All preview colors use VS Code CSS variables (`--vscode-editor-font-family`, `--vscode-editorLineNumber-foreground`, `--vscode-charts-orange`, etc.) for automatic light/dark theme compatibility.

**Module-level helpers:**
- `blockAsArtifact(block, parent)` — adapts a `ParsedBlock` into a `ParsedArtifactFile` shape for preview/insert; inherits parent frontmatter, overrides `title`, `description`, `language`, `code`, `vars`.
- `resolveVarsInteractive(vars)` — shows a `showInputBox` for each variable; returns `null` if the user cancels any box.
- `performInsert(editor, artifact, vars)` — routes resolved content to the editor cursor, active terminal (`command` type), or clipboard fallback.
- `resolveVars(code, vars)` — substitutes `<VK-xxx>` tokens from the map; unmatched tokens are left unchanged.

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
