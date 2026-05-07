import * as vscode from 'vscode';
import type { ParsedArtifactFile, ParsedVar } from '../types/parsed-artifact.types.js';
import type { ApplyChange, ApplyResult, VarSetMatch, VarSubSet } from '../types/varset.types.js';
import { parseFromContent } from './parser.service.js';

/**
 * Recursively scans a vault `Variables/` directory for `type: variables` artifact
 * files, parsing each one and caching the parsed result.
 *
 * Cache is keyed by the absolute fs path of the directory passed to `scan`.
 * `invalidate()` clears the cache so the next `scan` call re-reads from disk.
 *
 * @example
 * const scanner = new VarSetScanner();
 * const files   = await scanner.scan(vscode.Uri.file('/vault/Variables'));
 * scanner.invalidate();
 */
export class VarSetScanner {
    private cache = new Map<string, ParsedArtifactFile[]>();

    /**
     * Scans the directory and returns parsed `type: variables` artifact files.
     *
     * @param variablesDirUri - Absolute URI of the directory to scan.
     * @returns Array of parsed files; cached on first call, returned by reference on subsequent calls.
     *
     * @example
     * await scanner.scan(vscode.Uri.file('/vault/Variables'));
     */
    async scan(variablesDirUri: vscode.Uri): Promise<ParsedArtifactFile[]> {
        const key = variablesDirUri.fsPath;
        const cached = this.cache.get(key);
        if (cached) { return cached; }

        const collected: ParsedArtifactFile[] = [];
        await this.walk(variablesDirUri, variablesDirUri, collected);
        this.cache.set(key, collected);
        return collected;
    }

    /**
     * Clears the internal cache so the next `scan` re-reads from disk.
     *
     * @returns void
     *
     * @example
     * scanner.invalidate();
     */
    invalidate(): void {
        this.cache.clear();
    }

    /**
     * Recursive directory walker. Reads every `.md` file, keeps only those whose
     * frontmatter `type` is `'variables'`, and pushes them into `out`.
     *
     * @param dirUri  - Current directory being read.
     * @param rootUri - Original root URI passed to `scan` — used to compute relative paths.
     * @param out     - Accumulator that mutates in place across recursion.
     * @returns Promise that resolves when the directory tree has been fully scanned.
     *
     * @example
     * await this.walk(uri, uri, []);
     */
    private async walk(dirUri: vscode.Uri, rootUri: vscode.Uri, out: ParsedArtifactFile[]): Promise<void> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return;
        }

        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(dirUri, name);

            // Recurse into sub-directories
            if (type === vscode.FileType.Directory) {
                await this.walk(childUri, rootUri, out);
                continue;
            }

            // Skip non-files and non-.md files
            if (type !== vscode.FileType.File) { continue; }
            if (!name.endsWith('.md')) { continue; }

            // Read + parse the .md file; skip when type isn't 'variables'
            try {
                const bytes   = await vscode.workspace.fs.readFile(childUri);
                const content = new TextDecoder().decode(bytes);
                const parsed  = parseFromContent(content, childUri.fsPath, rootUri.fsPath);
                if (parsed.frontmatter.type === 'variables') { out.push(parsed); }
            } catch {
                // Unreadable / unparseable file — silently skip.
            }
        }
    }
}

/**
 * Pure scoring function — compares an artifact's `(vars, tags)` profile against
 * a candidate variable set's `(vars, tags)` profile and returns a `VarSetMatch`
 * report containing both per-var classification and a single combined score.
 *
 * Combined score: `matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3`.
 * When the artifact has no tags, the tag component is `0`. When the artifact has
 * no vars, `matchRatio` is `0`.
 *
 * @param artifactVars - Vars declared by the artifact being inserted.
 * @param artifactTags - Tags declared by the artifact's frontmatter.
 * @param setVars      - Vars declared by the candidate variable set.
 * @param setTags      - Tags declared by the candidate variable set's frontmatter.
 * @returns `VarSetMatch` report with overlap arrays, ratios, and combined score.
 *
 * @example
 * scoreVarSet(
 *   [{ name: 'VK-host', defaultValue: '' }],
 *   ['api'],
 *   [{ name: 'VK-host', defaultValue: 'localhost' }],
 *   ['api'],
 * )
 */
export function scoreVarSet(
    artifactVars: ParsedVar[],
    artifactTags: string[],
    setVars: ParsedVar[],
    setTags: string[],
): VarSetMatch {
    const artifactNames = new Set(artifactVars.map(v => v.name));
    const setNames      = new Set(setVars.map(v => v.name));

    const matchedVars:   string[] = [];
    const unmatchedVars: string[] = [];
    const extraVars:     string[] = [];

    for (const v of artifactVars) {
        if (setNames.has(v.name)) { matchedVars.push(v.name); }
        else                      { unmatchedVars.push(v.name); }
    }
    for (const v of setVars) {
        if (!artifactNames.has(v.name)) { extraVars.push(v.name); }
    }

    const matchRatio = artifactVars.length === 0
        ? 0
        : matchedVars.length / artifactVars.length;

    const setTagSet = new Set(setTags);
    const tagMatches = artifactTags.reduce((acc, t) => acc + (setTagSet.has(t) ? 1 : 0), 0);
    const tagComponent = artifactTags.length === 0
        ? 0
        : tagMatches / artifactTags.length;

    const score = matchRatio * 0.7 + tagComponent * 0.3;

    return { matchedVars, unmatchedVars, extraVars, matchRatio, tagMatches, score };
}

/**
 * Pure transform — flattens a parsed variable artifact file into one or more
 * `VarSubSet` entries. Multi-block files yield one sub-set per `## Heading` that
 * has at least one var. Single-block files yield one sub-set wrapping the
 * top-level `vars` and using `frontmatter.title || fileName` as the heading.
 * Sub-sets with no vars are excluded.
 *
 * @param artifact - Fully parsed variable file.
 * @returns Ordered array of `VarSubSet`; `[]` when no qualifying sub-set exists.
 *
 * @example
 * extractSubSets(parsedFile)
 */
export function extractSubSets(artifact: ParsedArtifactFile): VarSubSet[] {
    if (artifact.blocks.length > 0) {
        return artifact.blocks
            .filter(b => b.vars.length > 0)
            .map(b => ({ heading: b.heading, vars: b.vars, sourceFile: artifact }));
    }

    if (artifact.vars.length === 0) { return []; }

    const heading = artifact.frontmatter.title || artifact.fileName;
    return [{ heading, vars: artifact.vars, sourceFile: artifact }];
}

/**
 * Pure merge — applies a variable set's defaults on top of the user's current
 * input values, returning the merged map plus a per-var change log.
 *
 * Action rules:
 *   - `'filled'`     — old empty, set provides a value (including `''`).
 *   - `'overridden'` — old non-empty, set provides a value.
 *   - `'kept'`       — set does not provide this var; old value preserved.
 *
 * The `changes` array contains one entry per var in the union of
 * `Object.keys(currentValues)` and `setVars.map(v => v.name)`.
 *
 * @param currentValues - User-typed values keyed by full var name.
 * @param setVars       - Variable set to apply on top.
 * @returns `ApplyResult` containing merged values and per-var changes.
 *
 * @example
 * applyVarSet(
 *   { 'VK-host': 'old' },
 *   [{ name: 'VK-host', defaultValue: 'new' }, { name: 'VK-port', defaultValue: '8080' }],
 * )
 */
export function applyVarSet(
    currentValues: Record<string, string>,
    setVars: ParsedVar[],
): ApplyResult {
    const setMap = new Map(setVars.map(v => [v.name, v.defaultValue]));
    const allNames = new Set<string>([...Object.keys(currentValues), ...setMap.keys()]);

    const values: Record<string, string> = {};
    const changes: ApplyChange[] = [];

    for (const name of allNames) {
        const oldValue = currentValues[name] ?? '';
        if (setMap.has(name)) {
            const newValue = setMap.get(name) ?? '';
            const action: ApplyChange['action'] = oldValue === '' ? 'filled' : 'overridden';
            values[name] = newValue;
            changes.push({ name, oldValue, newValue, action });
        } else {
            values[name] = oldValue;
            changes.push({ name, oldValue, newValue: oldValue, action: 'kept' });
        }
    }

    return { values, changes };
}
