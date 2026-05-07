import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactType, ParsedArtifactFile, ParsedBlock, ParsedFrontmatter, ParsedVar } from '../types/parsed-artifact.types.js';

// Accepted `type` values — any unrecognised value keeps the 'snippet' fallback.
const VALID_TYPES = new Set<string>(['snippet', 'template', 'command', 'agent', 'variables']);

/**
 * Extracts and parses the YAML frontmatter block from raw vault file content.
 *
 * Frontmatter must appear at the very start of the file between `---` fences.
 * Unknown keys are silently skipped; an invalid `type` value falls back to `'snippet'`.
 *
 * @param content - Full UTF-8 string content of the `.md` file.
 * @returns Populated `ParsedFrontmatter`; returns `{ type: 'snippet' }` when no frontmatter is found.
 *
 * @example
 * parseFrontmatter('---\ntype: template\ntitle: React Component\nlanguage: tsx\n---\n')
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
    // Match everything between the opening and closing --- fences
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    const result: ParsedFrontmatter = { type: 'snippet' };
    if (!match) { return result; }

    // Parse each `key: value` line — skip lines without a colon
    for (const line of match[1].split(/\r?\n/)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) { continue; }
        const key = line.slice(0, colonIdx).trim();
        const raw = line.slice(colonIdx + 1).trim();

        if (key === 'type') {
            // Validate against the whitelist before assigning
            if (VALID_TYPES.has(raw)) { result.type = raw as ArtifactType; }
        } else if (key === 'tags') {
            // Parse inline array syntax: `[a, b, c]` → `['a', 'b', 'c']`
            const inner = raw.replace(/^\[|\]$/g, '');
            result.tags = inner.split(',').map(t => t.trim()).filter(Boolean);
        } else if (key === 'title' || key === 'description' || key === 'language' || key === 'env' || key === 'target') {
            result[key] = raw;
        }
    }

    return result;
}

/**
 * Extracts the first fenced code block from a vault file, along with its language tag.
 *
 * The frontmatter section is stripped first to prevent false matches.
 * Trailing whitespace is removed so the inserted content does not carry an
 * unwanted trailing newline into the editor.
 *
 * @param content - Full UTF-8 string content of the `.md` file.
 * @returns `{ code, fenceLang }` — code is `''` and fenceLang is `undefined` when no fence is found.
 *
 * @example
 * parseCodeBlock('---\ntype: snippet\n---\n\n```javascript\nconsole.log("hi");\n```')
 */
function parseCodeBlock(content: string): { code: string; fenceLang?: string } {
    // Strip frontmatter before scanning to avoid matching a fence inside it
    const afterFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const match = /```(\w*)\r?\n([\s\S]*?)```/.exec(afterFrontmatter);
    if (!match) { return { code: '' }; }
    return {
        code:     match[2].trimEnd(),
        fenceLang: match[1] || undefined,
    };
}

/**
 * Converts a raw `KEY=value` block into an ordered array of `ParsedVar` objects.
 *
 * Lines that do not contain `=` are skipped. Lines starting with `#` (comments)
 * are skipped. A value may be empty (`KEY=` is valid and yields `defaultValue: ''`).
 *
 * @param raw - Multi-line string of `KEY=value` pairs.
 * @returns Ordered array of `{ name, defaultValue }` objects.
 *
 * @example
 * parseVarLines('port=8080\nimage=nginx\n')
 */
function parseVarLines(raw: string): ParsedVar[] {
    return raw
        .split(/\r?\n/)
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => {
            const eq = l.indexOf('=');
            return { name: l.slice(0, eq).trim(), defaultValue: l.slice(eq + 1).trim() };
        })
        .filter(v => v.name.length > 0);
}

/**
 * Locates and parses the variables section from raw vault file content.
 *
 * Two formats are supported, tried in priority order:
 * 1. **Fenced block** — ` ```vars\nKEY=val\n``` ` (standard for `type: variables` files).
 * 2. **Unfenced section** — a `vars:` or `vars` label on its own line followed by
 *    `KEY=value` pairs, placed after the ` ```code` block.
 *
 * @param content - Full UTF-8 string content of the `.md` file.
 * @returns Ordered array of `ParsedVar` objects, or `[]` when no vars section exists.
 *
 * @example
 * parseVars('...\n```vars\nAPI_URL=http://localhost\n```')
 *
 * parseVars('...\n```javascript\n...\n```\n\nvars:\nroute=/test\n')
 */
function parseVars(content: string): ParsedVar[] {
    // Priority 1: fenced ```vars block — used by type: variables files
    const fenced = /```vars\r?\n([\s\S]*?)```/.exec(content);
    if (fenced) { return parseVarLines(fenced[1]); }

    // Priority 2: unfenced section after the code block ("vars:" or "vars" label)
    const afterCode = content
        .replace(/^---[\s\S]*?---/, '')     // strip frontmatter
        .replace(/```\w*[\s\S]*?```/, ''); // strip code block
    const unfenced = /\bvars:?\s*\r?\n([\s\S]+?)(?:\n\n|\n*$)/.exec(afterCode);
    if (unfenced) { return parseVarLines(unfenced[1]); }

    return [];
}

/**
 * Scans raw code for `<VK-hint>` tokens and returns a deduplicated list of `ParsedVar` objects.
 *
 * A valid token must match `<VK-hint>` where `hint` starts with a letter and is followed by
 * zero or more letters, digits, or underscores. The full `VK-hint` string (without angle
 * brackets) becomes the `name` field; `defaultValue` is always `''`. Duplicate tokens
 * (same name in multiple positions) are collapsed to a single entry in first-appearance order.
 *
 * @param code - Arbitrary string, typically the content of a code block.
 * @returns Deduplicated array of `{ name, defaultValue }` objects, or `[]` when no tokens are found.
 *
 * @example
 * extractVars('curl <VK-host>/<VK-path> -H "x: <VK-host>"')
 */
export function extractVars(code: string): ParsedVar[] {
    const matches = [...code.matchAll(/<VK-([A-Za-z]\w*)>/g)];
    const seen = new Set<string>();
    const vars: ParsedVar[] = [];
    for (const m of matches) {
        const name = `VK-${m[1]}`;
        if (!seen.has(name)) {
            seen.add(name);
            vars.push({ name, defaultValue: '' });
        }
    }
    return vars;
}

/**
 * Substitutes `<VK-hint>` tokens in `code` with values from the `vars` map.
 *
 * Each occurrence of a `<VK-hint>` token whose key (`VK-hint`) appears in `vars`
 * is replaced with the corresponding value. Tokens absent from the map are left
 * unchanged so partial substitution is safe. Non-VK syntax — HTML tags, TypeScript
 * generics, template literals, Handlebars — is never touched.
 *
 * @param code - String potentially containing `<VK-hint>` tokens.
 * @param vars - Map of full token name (e.g. `'VK-host'`) to replacement value.
 * @returns The string with all resolvable tokens substituted.
 *
 * @example
 * resolveVars('http://<VK-host>:<VK-port>', { 'VK-host': 'localhost', 'VK-port': '3000' })
 *
 * @example
 * resolveVars('<VK-known> <VK-unknown>', { 'VK-known': 'hi' })
 */
export function resolveVars(code: string, vars: Record<string, string>): string {
    return code.replaceAll(/<VK-([A-Za-z]\w*)>/g, (match, hint: string) => {
        const key = `VK-${hint}`;
        return key in vars ? vars[key] : match;
    });
}

/**
 * Parses `##`-headed sections from vault file content into an ordered array of `ParsedBlock` objects.
 *
 * Detection rule: after stripping frontmatter, if the remaining content contains at least one
 * `## ` heading followed (anywhere in its section) by a fenced code block, each such section
 * is returned as a `ParsedBlock`. Returns `[]` when no qualifying sections are found, which
 * signals that the file uses the classic single-block format.
 *
 * Vars for each block are auto-detected from `<VK-hint>` tokens in the block's code via
 * `extractVars`; `defaultValue` is always `''` because there is no explicit vars section per block.
 *
 * @param content - Full UTF-8 string content of the `.md` file.
 * @returns Ordered array of `ParsedBlock` objects, or `[]` for single-block files.
 *
 * @example
 * parseBlocks('---\ntype: snippet\n---\n## Dev\ndev server\n```bash\nhttp://<VK-host>\n```\n## Prod\n```bash\nhttp://prod.example.com\n```')
 */

export function parseBlocks(content: string): ParsedBlock[] {
    // Strip frontmatter before scanning
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

    // Split on ## headings — keep delimiter at start of each chunk via lookahead
    const sections = body.split(/(?=^## )/m).filter(s => s.startsWith('## '));
    if (sections.length === 0) { return []; }

    const blocks: ParsedBlock[] = [];
    for (const section of sections) {
        // ── Extract heading ──────────────────────────────────────────────────
        const headingMatch = /^## (.+)/.exec(section);
        if (!headingMatch) { continue; }
        const heading = headingMatch[1].trim();

        // ── Extract fenced code block ────────────────────────────────────────
        const fenceMatch = /```(\w*)\r?\n([\s\S]*?)```/.exec(section);
        if (!fenceMatch) { continue; }  // heading without code block — skip
        const fenceLang = fenceMatch[1] || undefined;
        const code = fenceMatch[2].trimEnd();

        // ── Description: text between heading line and the opening fence ─────
        const headingEnd = section.indexOf('\n') + 1;
        const fenceStart = section.indexOf('```');
        const descRaw = section.slice(headingEnd, fenceStart).trim();

        // ── Auto-detect vars from <VK-xxx> tokens ────────────────────────────
        const vars = extractVars(code);

        blocks.push({ heading, description: descRaw, code, fenceLang, vars });
    }

    // Only return blocks when at least one qualified section was found
    return blocks.length > 0 ? blocks : [];
}

/**
 * Reads and fully parses a single vault `.md` artifact file into a structured object.
 *
 * Combines frontmatter, code block, and vars section into a `ParsedArtifactFile`
 * that the picker panel uses for display and insert-time variable resolution.
 *
 * @param filePath - Absolute path to the `.md` file on disk.
 * @param artifactRootDir - Absolute path to the artifact's root directory
 *   (e.g. `/vault/Snippets`). Used to compute the `relativePath` field.
 * @returns A fully populated `ParsedArtifactFile`, or `null` if the file cannot be read.
 *
 * @example
 * parseArtifactFile('/vault/Snippets/Web/express-route.md', '/vault/Snippets')
 */

/**
 * Parses pre-read vault `.md` file content into a structured object.
 *
 * Functionally identical to `parseArtifactFile` but accepts the file content
 * as a string rather than reading it from disk. Intended for async callers
 * (e.g. the QuickPick picker) that read file bytes via `vscode.workspace.fs`.
 *
 * @param content         - UTF-8 file content string.
 * @param filePath        - Absolute OS path to the file (used to compute `fileName` and `relativePath`).
 * @param artifactRootDir - Absolute path to the artifact root directory.
 * @returns Fully populated `ParsedArtifactFile`.
 *
 * @example
 * const bytes = await vscode.workspace.fs.readFile(uri);
 * const content = new TextDecoder().decode(bytes);
 * parseFromContent(content, uri.fsPath, rootUri.fsPath);
 */

export function parseFromContent(content: string, filePath: string, artifactRootDir: string): ParsedArtifactFile {
    const frontmatter = parseFrontmatter(content);
    const { code, fenceLang } = parseCodeBlock(content);
    if (!frontmatter.language && fenceLang) { frontmatter.language = fenceLang; }
    return {
        filePath,
        fileName:     path.basename(filePath, '.md'),
        relativePath: path.relative(artifactRootDir, filePath),
        frontmatter,
        code,
        vars:         parseVars(content),
        blocks:       parseBlocks(content),
    };
}

export function parseArtifactFile(filePath: string, artifactRootDir: string): ParsedArtifactFile | null {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        const { code, fenceLang } = parseCodeBlock(content);
        if (!frontmatter.language && fenceLang) { frontmatter.language = fenceLang; }
        return {
            filePath,
            fileName:     path.basename(filePath, '.md'),
            relativePath: path.relative(artifactRootDir, filePath),
            frontmatter,
            code,
            vars:         parseVars(content),
            blocks:       parseBlocks(content),
        };
    } catch {
        // File unreadable or parse error — caller shows appropriate UI feedback
        return null;
    }
}
