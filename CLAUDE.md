# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile        # One-off TypeScript build (outputs to dist/)
npm run watch          # Watch mode for development (preferred during active dev)
npm run lint           # ESLint check (runs against src/)
npm run test           # Compile + lint + run tests
```

Press **F5** in VS Code to launch the Extension Development Host.

## What This Extension Does

"Obsidian Notes & Snippets" lets developers access their Obsidian vault's notes and snippets from within VS Code, and create new ones directly from the editor. The extension is early-stage (v0.0.1).

The only active feature is a **Config page** (webview panel) where the user selects their Obsidian vault root. On selection, the vault is validated and required subdirectories are created automatically.

## Folder Structure

```
src/
├── extension.ts              # Entry point — activate() / deactivate()
├── commands/
│   └── openConfig.command.ts # Registers obsidian-notes-and-snippets.config
├── config/
│   └── settings.ts           # Config webview panel (UI + message handling)
├── services/
│   └── vault.service.ts      # validateObsidianVault(), detectVaultDirs() — reuse across features
├── types/
│   └── constants.ts          # VAULT_DIRS — list of expected subdirs with default flag
├── utils/
│   └── helpers.ts            # getNonce() for CSP nonces
├── features/                 # (empty) future domain features
├── providers/                # (empty) future VS Code providers
└── types/                    # (empty) future shared TypeScript types
media/
└── styles.css                # Webview stylesheet — loaded via webview.asWebviewUri()
test/
└── extension.test.ts         # Mocha test suite
```

## Architecture

**Entry point:** `src/extension.ts` — calls `registerOpenConfigCommand(context)` from `src/commands/openConfig.command.ts`.

**Activation flow:**
1. `activate()` in `extension.ts` registers the command `obsidian-notes-and-snippets.config` ("AI Obsidian S&T: Config").
2. The command calls `openSettingsPanel(context)` in `src/config/settings.ts`.
3. `openSettingsPanel` creates a `WebviewPanel`, loads `media/styles.css` via `webview.asWebviewUri`, and uses `getNonce()` to set the CSP.
4. When the user picks a folder, `validateObsidianVault()` checks for a `.obsidian/` dir (errors + returns false if absent).
5. `detectVaultDirs()` then checks for the directories in `VAULT_DIRS` and auto-creates any that are marked `active` but missing.
6. The saved vault path is persisted to `globalStorageUri/ai_obsidian_sandt.conf`.

**Vault directory logic** (`src/types/constants.ts` and `src/services/vault.service.ts`):
- `VAULT_DIRS` — array of `{ name, dir, default }`. `snippets` and `agents_conf` are set to `default: true` (auto-created); `commands`, `templates`, and `variables` are `default: false` (detected only).
- `detectVaultDirs()` checks for directories in `VAULT_DIRS` and auto-creates any marked `default: true` if missing.

**No runtime dependencies** — only the VS Code API, Node `fs`, and Node `path` are used.

## Key Config Files

- `tsconfig.json` — strict mode, `ES2022` target, `Node16` module resolution, `rootDir: "."`, output to `dist/`. `rootDir` is set to project root (not `src/`) so both `src/` and `test/` compile into `dist/src/` and `dist/test/` respectively.
- `package.json` — `"main": "./dist/src/extension.js"` (mirrors the `rootDir: "."` output structure)
- `eslint.config.mjs` — enforces naming conventions, curly braces, `===` equality, semicolons
- `.vscode/launch.json` — debug launch with `--extensionDevelopmentPath`; other extensions disabled in the host; `outFiles` points to `dist/`
- `.vscode/tasks.json` — `npm watch` is the default build task (runs automatically on F5)
- `.vscode-test.mjs` — test runner looks for compiled tests at `dist/test/**/*.test.js`

## VS Code Extension Notes

- `activationEvents` is `[]` in `package.json` — the extension activates on any window open. Update this to specific command activation events when commands stabilise.
- Compiled output goes to `dist/` and is **gitignored** (`.gitignore` excludes `dist`). Run `npm run compile` after cloning.
- `media/` ships in the packaged extension. `src/`, `test/`, and `dist/test/` are excluded via `.vscodeignore`.
- All imports use explicit `.js` extensions (e.g. `'./helpers.js'`) — required by `Node16` module resolution even for `.ts` source files.
- The webview's `localResourceRoots` is set to `extensionUri/media` — any new webview assets must go in `media/`.
