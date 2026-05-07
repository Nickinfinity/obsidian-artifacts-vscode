import * as assert from 'node:assert';
import type { ParsedArtifactFile, ParsedBlock, ParsedVar } from '../src/types/parsed-artifact.types.js';
import type { VarSubSet } from '../src/types/varset.types.js';
import { extractSubSets } from '../src/services/varset.service.js';

/**
 * Unit tests for extractSubSets — flattens a `ParsedArtifactFile` into one or more
 * `VarSubSet` records, one per ## Heading block (or one synthetic sub-set when
 * the artifact is a single-block file).
 *
 * VarSubSet shape:
 *   { heading: string, vars: ParsedVar[], sourceFile: ParsedArtifactFile }
 *
 * The function does NOT exist yet — all tests should fail until
 * src/services/varset.service.ts implements `extractSubSets` and
 * src/types/varset.types.ts exports `VarSubSet`.
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Builds a `ParsedVar[]` from name strings.
 *
 * @param names - Full variable names (e.g. `'VK-host'`).
 * @returns Ordered `ParsedVar[]` with empty `defaultValue` per entry.
 *
 * @example
 * mkVars(['VK-host', 'VK-port'])
 */
function mkVars(names: string[]): ParsedVar[] {
    return names.map(n => ({ name: n, defaultValue: '' }));
}

/**
 * Builds a `ParsedBlock` test fixture with sensible defaults.
 *
 * @param heading - Block `##` heading text.
 * @param vars    - Auto-detected vars for the block.
 * @returns Fully populated `ParsedBlock`.
 *
 * @example
 * mkBlock('Development', mkVars(['VK-host']))
 */
function mkBlock(heading: string, vars: ParsedVar[]): ParsedBlock {
    return { heading, description: '', code: '', fenceLang: 'bash', vars };
}

/**
 * Builds a `ParsedArtifactFile` test fixture.
 *
 * @param overrides - Partial overrides for the default shape; spread last.
 * @returns Fully populated `ParsedArtifactFile` ready for use as a test input.
 *
 * @example
 * mkArtifact({ vars: mkVars(['VK-x']), blocks: [] })
 */
function mkArtifact(overrides: Partial<ParsedArtifactFile> = {}): ParsedArtifactFile {
    return {
        filePath:     '/tmp/vault/Variables/test.md',
        fileName:     'test',
        relativePath: 'test.md',
        frontmatter:  { type: 'variables', title: 'Test Variable Set' },
        code:         '',
        vars:         [],
        blocks:       [],
        ...overrides,
    };
}

// ── Test suite ────────────────────────────────────────────────────────────────

suite('extractSubSets', () => {

    // ── Multi-block files ─────────────────────────────────────────────────────

    test('multi-block file with 3 ## Heading blocks → returns 3 sub-sets in document order', () => {
        const blocks: ParsedBlock[] = [
            mkBlock('Development', mkVars(['VK-API_URL', 'VK-DB_URL'])),
            mkBlock('Staging',     mkVars(['VK-API_URL', 'VK-DB_URL'])),
            mkBlock('Production',  mkVars(['VK-API_URL', 'VK-DB_URL'])),
        ];
        const artifact = mkArtifact({ blocks });
        const subSets: VarSubSet[] = extractSubSets(artifact);

        assert.strictEqual(subSets.length, 3);
        assert.strictEqual(subSets[0].heading, 'Development');
        assert.strictEqual(subSets[1].heading, 'Staging');
        assert.strictEqual(subSets[2].heading, 'Production');
    });

    test('multi-block sub-sets carry their block`s vars verbatim', () => {
        const blocks: ParsedBlock[] = [
            mkBlock('Dev',  mkVars(['VK-API_URL'])),
            mkBlock('Prod', mkVars(['VK-API_URL', 'VK-DB_URL'])),
        ];
        const artifact = mkArtifact({ blocks });
        const subSets  = extractSubSets(artifact);

        assert.deepStrictEqual(subSets[0].vars, mkVars(['VK-API_URL']));
        assert.deepStrictEqual(subSets[1].vars, mkVars(['VK-API_URL', 'VK-DB_URL']));
    });

    test('vars are scoped to their block — adjacent blocks do not share entries', () => {
        const blocks: ParsedBlock[] = [
            mkBlock('Dev',  mkVars(['VK-A', 'VK-B'])),
            mkBlock('Prod', mkVars(['VK-C'])),
        ];
        const artifact = mkArtifact({ blocks });
        const subSets  = extractSubSets(artifact);

        const devNames  = subSets[0].vars.map(v => v.name).sort();
        const prodNames = subSets[1].vars.map(v => v.name).sort();
        assert.deepStrictEqual(devNames,  ['VK-A', 'VK-B']);
        assert.deepStrictEqual(prodNames, ['VK-C']);
    });

    // ── Single-block files ────────────────────────────────────────────────────

    test('single-block file (blocks: []) → returns 1 sub-set with heading from frontmatter.title', () => {
        const artifact = mkArtifact({
            frontmatter: { type: 'variables', title: 'Express API Environments' },
            vars:        mkVars(['VK-API_URL', 'VK-DB_URL']),
            blocks:      [],
        });
        const subSets = extractSubSets(artifact);

        assert.strictEqual(subSets.length, 1);
        assert.strictEqual(subSets[0].heading, 'Express API Environments');
        assert.deepStrictEqual(subSets[0].vars, mkVars(['VK-API_URL', 'VK-DB_URL']));
    });

    test('single-block file vars come from artifact.vars (top-level), not from blocks', () => {
        const artifact = mkArtifact({
            frontmatter: { type: 'variables', title: 'Local' },
            vars:        mkVars(['VK-only']),
            blocks:      [],
        });
        const subSets = extractSubSets(artifact);
        assert.strictEqual(subSets.length, 1);
        assert.deepStrictEqual(subSets[0].vars, mkVars(['VK-only']));
    });

    // ── Empty / degenerate blocks ─────────────────────────────────────────────

    test('blocks with no vars are excluded from the result', () => {
        const blocks: ParsedBlock[] = [
            mkBlock('Has Vars',   mkVars(['VK-A'])),
            mkBlock('Empty',      mkVars([])),
            mkBlock('Has Vars 2', mkVars(['VK-B'])),
        ];
        const artifact = mkArtifact({ blocks });
        const subSets  = extractSubSets(artifact);

        assert.strictEqual(subSets.length, 2);
        const headings = subSets.map(s => s.heading);
        assert.deepStrictEqual(headings, ['Has Vars', 'Has Vars 2']);
    });

    test('multi-block file where every block is empty → returns no sub-sets', () => {
        const blocks: ParsedBlock[] = [
            mkBlock('Dev',  mkVars([])),
            mkBlock('Prod', mkVars([])),
        ];
        const artifact = mkArtifact({ blocks });
        const subSets  = extractSubSets(artifact);

        assert.deepStrictEqual(subSets, []);
    });

    // ── sourceFile back-reference ─────────────────────────────────────────────

    test('multi-block sub-sets carry sourceFile pointing to the original parsed file', () => {
        const blocks: ParsedBlock[] = [
            mkBlock('Dev',  mkVars(['VK-A'])),
            mkBlock('Prod', mkVars(['VK-B'])),
        ];
        const artifact = mkArtifact({ blocks });
        const subSets  = extractSubSets(artifact);

        assert.strictEqual(subSets[0].sourceFile, artifact);
        assert.strictEqual(subSets[1].sourceFile, artifact);
    });

    test('single-block sub-set carries sourceFile pointing to the original parsed file', () => {
        const artifact = mkArtifact({
            frontmatter: { type: 'variables', title: 'My Set' },
            vars:        mkVars(['VK-x']),
            blocks:      [],
        });
        const subSets = extractSubSets(artifact);
        assert.strictEqual(subSets[0].sourceFile, artifact);
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    test('single-block file with no title falls back to fileName (or another stable label)', () => {
        // Implementation may use frontmatter.title || fileName. We assert non-empty + stable.
        const artifact = mkArtifact({
            fileName:    'local-dev',
            frontmatter: { type: 'variables' },
            vars:        mkVars(['VK-x']),
            blocks:      [],
        });
        const subSets = extractSubSets(artifact);
        assert.strictEqual(subSets.length, 1);
        assert.ok(subSets[0].heading.length > 0, 'heading must be non-empty');
    });

    test('single-block file with empty top-level vars produces no sub-sets', () => {
        // Same exclusion rule as multi-block: a sub-set with no vars is dropped.
        const artifact = mkArtifact({
            frontmatter: { type: 'variables', title: 'Empty' },
            vars:        [],
            blocks:      [],
        });
        const subSets = extractSubSets(artifact);
        assert.deepStrictEqual(subSets, []);
    });

});
