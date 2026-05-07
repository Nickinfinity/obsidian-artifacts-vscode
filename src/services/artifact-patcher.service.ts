
// ── patchFrontmatterField ─────────────────────────────────────────────────────

/**
 * Wraps a YAML scalar value in quotes when the bare form would be ambiguous.
 *
 * - Value containing `"` → single-quoted  (`'…'`)
 * - Value containing `:`  → double-quoted (`"…"`)
 * - All other values      → returned as-is
 *
 * @param value - The raw string value to encode.
 * @returns A YAML-safe representation of the value.
 *
 * @example
 * yamlQuote('https://example.com')  // → '"https://example.com"'
 * yamlQuote('He said "hi"')         // → "'He said \"hi\"'"
 * yamlQuote('plain text')           // → 'plain text'
 */
function yamlQuote(value: string): string {
    if (value.includes('"')) { return `'${value}'`; }
    if (value.includes(':')) { return `"${value}"`; }
    return value;
}

/**
 * Updates or inserts a single YAML frontmatter field in a `.md` artifact file.
 *
 * The frontmatter block is the content between the opening `---` and the first
 * closing `---`. If the file has no frontmatter the content is returned unchanged.
 * Values containing `:` are double-quoted; values containing `"` are single-quoted.
 *
 * @param content - Raw `.md` file content string.
 * @param field   - YAML key to update (e.g. `'title'`, `'description'`).
 * @param value   - New value for the key.
 * @returns Updated content string, or the original string when no frontmatter is found.
 *
 * @example
 * patchFrontmatterField(raw, 'title', 'New Title')
 * patchFrontmatterField(raw, 'language', 'python')   // inserts if absent
 */
export function patchFrontmatterField(content: string, field: string, value: string): string {
    if (!content.startsWith('---\n')) { return content; }

    const rest       = content.slice(4);
    const closeMatch = /^---$/m.exec(rest);
    if (!closeMatch) { return content; }

    const closeIdx = closeMatch.index;
    const fmBody   = rest.slice(0, closeIdx);
    const afterFm  = rest.slice(closeIdx);
    const formatted = field + ': ' + yamlQuote(value);
    const fieldRe   = new RegExp('^' + field + ':.*$', 'm');

    let newFmBody: string;
    if (fieldRe.test(fmBody)) {
        newFmBody = fmBody.replace(fieldRe, formatted);
    } else {
        // Append before the closing --- (fmBody always ends with \n in valid files).
        newFmBody = fmBody.endsWith('\n')
            ? fmBody + formatted + '\n'
            : formatted + '\n';
    }

    return '---\n' + newFmBody + afterFm;
}

// ── patchVarDefaults ──────────────────────────────────────────────────────────

/**
 * Returns the index of the last line that is exactly ` ``` ` (a closing code fence).
 * Returns `-1` when no such line is found.
 *
 * @param lines - Split content lines.
 * @returns Zero-based line index, or `-1`.
 *
 * @example
 * lastFenceIndex(['```code', 'x = 1', '```'])  // → 2
 */
function lastFenceIndex(lines: string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i] === '```') { return i; }
    }
    return -1;
}

/**
 * Merges `defaults` into an already-present `vars:` section, updating existing
 * entries and appending new ones.  Entries absent from `defaults` are preserved.
 *
 * @param lines    - Split content lines.
 * @param hdrIdx   - Index of the `vars:` header line.
 * @param defaults - Map of `VK-name → value` to merge.
 * @returns Updated joined content string.
 *
 * @example
 * mergeIntoExistingVarsSection(lines, 8, { 'VK-host': 'prod.example.com' })
 */
function mergeIntoExistingVarsSection(
    lines: string[],
    hdrIdx: number,
    defaults: Record<string, string>,
): string {
    // ── Collect existing var lines ────────────────────────────────────────────
    let sectionEnd = hdrIdx + 1;
    while (sectionEnd < lines.length && /^VK-[A-Za-z]/.test(lines[sectionEnd])) {
        sectionEnd++;
    }

    const existingLines = lines.slice(hdrIdx + 1, sectionEnd);
    const existingVars  = existingLines.map(l => {
        const eq = l.indexOf('=');
        return { name: l.slice(0, eq), value: l.slice(eq + 1) };
    });

    // ── Merge: update matching entries, preserve others, append new ones ──────
    const merged = existingVars.map(v => ({
        name:  v.name,
        value: v.name in defaults ? defaults[v.name] : v.value,
    }));

    const existingNames = new Set(existingVars.map(v => v.name));
    for (const [name, value] of Object.entries(defaults)) {
        if (!existingNames.has(name)) { merged.push({ name, value }); }
    }

    const mergedLines = merged.map(v => v.name + '=' + v.value);
    return [
        ...lines.slice(0, hdrIdx + 1),
        ...mergedLines,
        ...lines.slice(sectionEnd),
    ].join('\n');
}

/**
 * Appends a new `vars:` section immediately after the last closing code fence.
 * Falls back to appending at the end of the file when no fence is found.
 *
 * @param lines    - Split content lines.
 * @param defaults - Map of `VK-name → value` to write.
 * @returns Updated joined content string.
 *
 * @example
 * appendVarsSection(lines, { 'VK-message': 'hello' })
 */
function appendVarsSection(lines: string[], defaults: Record<string, string>): string {
    const varLines  = Object.entries(defaults).map(([k, v]) => k + '=' + v);
    const fenceIdx  = lastFenceIndex(lines);
    const insertAt  = fenceIdx === -1 ? lines.length : fenceIdx + 1;

    return [
        ...lines.slice(0, insertAt),
        '',
        'vars:',
        ...varLines,
        ...lines.slice(insertAt),
    ].join('\n');
}

/**
 * Merges variable default values into the `vars:` section of a `.md` artifact file.
 *
 * - When a `vars:` section exists: existing entries are updated if their name appears
 *   in `defaults`; new entries are appended; entries absent from `defaults` are kept.
 * - When no `vars:` section exists: a new one is appended after the last code fence.
 * - An empty `defaults` map returns the content unchanged.
 *
 * @param content  - Raw `.md` file content string.
 * @param defaults - Map of `VK-name → default value` (keys must include the `VK-` prefix).
 * @returns Updated content string.
 *
 * @example
 * patchVarDefaults(raw, { 'VK-host': 'localhost', 'VK-port': '3000' })
 */
export function patchVarDefaults(content: string, defaults: Record<string, string>): string {
    if (Object.keys(defaults).length === 0) { return content; }

    const lines  = content.split('\n');
    const hdrIdx = lines.indexOf('vars:');

    if (hdrIdx !== -1) {
        return mergeIntoExistingVarsSection(lines, hdrIdx, defaults);
    }

    return appendVarsSection(lines, defaults);
}
