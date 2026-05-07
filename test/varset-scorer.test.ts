import * as assert from 'node:assert';
import type { ParsedVar } from '../src/types/parsed-artifact.types.js';
import type { VarSetMatch } from '../src/types/varset.types.js';
import { scoreVarSet } from '../src/services/varset.service.js';

/**
 * Unit tests for scoreVarSet — pure scoring function that compares an artifact's
 * variable + tag profile against a candidate variable set's profile.
 *
 * Signature:
 *   scoreVarSet(artifactVars, artifactTags, setVars, setTags): VarSetMatch
 *
 * VarSetMatch shape:
 *   { matchedVars: string[], unmatchedVars: string[], extraVars: string[],
 *     matchRatio: number, tagMatches: number, score: number }
 *
 * Score formula:
 *   score = matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3
 *
 * The function does NOT exist yet — all tests should fail until
 * src/services/varset.service.ts implements `scoreVarSet` and
 * src/types/varset.types.ts exports `VarSetMatch`.
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Builds a `ParsedVar[]` from an array of variable names; defaultValue is empty.
 *
 * @param names - Variable name strings (full token, e.g. `'VK-host'`).
 * @returns Ordered array of `ParsedVar` records.
 *
 * @example
 * mkVars(['VK-host', 'VK-port'])
 */
function mkVars(names: string[]): ParsedVar[] {
    return names.map(n => ({ name: n, defaultValue: '' }));
}

/**
 * Numeric near-equality assertion for floating-point score values.
 *
 * @param actual   - Computed value.
 * @param expected - Expected value.
 * @param epsilon  - Acceptable absolute delta (default 1e-9).
 * @returns void
 *
 * @example
 * assertClose(score, 0.7, 1e-9);
 */
function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
    assert.ok(
        Math.abs(actual - expected) <= epsilon,
        `expected ${expected} (±${epsilon}), got ${actual}`,
    );
}

// ── Test suite ────────────────────────────────────────────────────────────────

suite('scoreVarSet', () => {

    // ── Perfect match ─────────────────────────────────────────────────────────

    test('perfect var match — all artifact vars present in set → matchRatio: 1.0', () => {
        const result: VarSetMatch = scoreVarSet(
            mkVars(['VK-host', 'VK-port', 'VK-path']),
            [],
            mkVars(['VK-host', 'VK-port', 'VK-path']),
            [],
        );
        assertClose(result.matchRatio, 1.0);
        assert.deepStrictEqual(result.matchedVars.sort(),   ['VK-host', 'VK-path', 'VK-port']);
        assert.deepStrictEqual(result.unmatchedVars,        []);
        assert.deepStrictEqual(result.extraVars,            []);
    });

    test('perfect var match with no tags → score = 0.7', () => {
        const result = scoreVarSet(
            mkVars(['VK-a', 'VK-b']),
            [],
            mkVars(['VK-a', 'VK-b']),
            [],
        );
        assertClose(result.score, 0.7);
    });

    // ── Partial match ─────────────────────────────────────────────────────────

    test('3 of 4 artifact vars match → matchRatio: 0.75 and the missing var is in unmatchedVars', () => {
        const result = scoreVarSet(
            mkVars(['VK-host', 'VK-port', 'VK-path', 'VK-token']),
            [],
            mkVars(['VK-host', 'VK-port', 'VK-path']),
            [],
        );
        assertClose(result.matchRatio, 0.75);
        assert.deepStrictEqual(result.matchedVars.sort(),   ['VK-host', 'VK-path', 'VK-port']);
        assert.deepStrictEqual(result.unmatchedVars,        ['VK-token']);
        assert.deepStrictEqual(result.extraVars,            []);
    });

    test('partial match score: matchRatio 0.5 + 0 tags → score = 0.35', () => {
        const result = scoreVarSet(
            mkVars(['VK-a', 'VK-b']),
            [],
            mkVars(['VK-a']),
            [],
        );
        assertClose(result.matchRatio, 0.5);
        assertClose(result.score,      0.35);
    });

    // ── No match ──────────────────────────────────────────────────────────────

    test('zero overlap → matchRatio: 0.0 and score: 0 when no tags either', () => {
        const result = scoreVarSet(
            mkVars(['VK-host']),
            [],
            mkVars(['VK-other']),
            [],
        );
        assertClose(result.matchRatio, 0.0);
        assertClose(result.score,      0.0);
        assert.deepStrictEqual(result.matchedVars,     []);
        assert.deepStrictEqual(result.unmatchedVars,   ['VK-host']);
        assert.deepStrictEqual(result.extraVars,       ['VK-other']);
    });

    test('zero var overlap but tags match — score reflects only tag component', () => {
        // 2 of 2 tags match → tag component = 1.0 * 0.3 = 0.3
        const result = scoreVarSet(
            mkVars(['VK-host']),
            ['api', 'web'],
            mkVars(['VK-other']),
            ['api', 'web'],
        );
        assertClose(result.matchRatio, 0.0);
        assertClose(result.score,      0.3);
        assert.strictEqual(result.tagMatches, 2);
    });

    // ── Extra set vars ───────────────────────────────────────────────────────

    test('extra vars in set that artifact does not need — listed in extraVars and do not lower score', () => {
        const result = scoreVarSet(
            mkVars(['VK-host', 'VK-port']),
            [],
            mkVars(['VK-host', 'VK-port', 'VK-extra1', 'VK-extra2']),
            [],
        );
        assertClose(result.matchRatio, 1.0);
        assertClose(result.score,      0.7);
        assert.deepStrictEqual(result.extraVars.sort(), ['VK-extra1', 'VK-extra2']);
        assert.deepStrictEqual(result.unmatchedVars,    []);
    });

    // ── Tag scoring ──────────────────────────────────────────────────────────

    test('2 of 3 artifact tags match set → tagMatches: 2', () => {
        const result = scoreVarSet(
            mkVars(['VK-x']),
            ['api', 'web', 'auth'],
            mkVars(['VK-x']),
            ['api', 'web', 'unrelated'],
        );
        assert.strictEqual(result.tagMatches, 2);
    });

    test('all artifact tags match set → tagMatches equals total tag count', () => {
        const result = scoreVarSet(mkVars([]), ['a', 'b'], mkVars([]), ['a', 'b']);
        assert.strictEqual(result.tagMatches, 2);
    });

    test('zero tag overlap → tagMatches: 0', () => {
        const result = scoreVarSet(mkVars([]), ['a', 'b'], mkVars([]), ['c', 'd']);
        assert.strictEqual(result.tagMatches, 0);
    });

    // ── Combined score formula ────────────────────────────────────────────────

    test('combined score = matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3', () => {
        // 3/4 vars match (0.75) and 2/3 tags match (~0.6667)
        // => 0.75 * 0.7 + (2/3) * 0.3 = 0.525 + 0.2 = 0.725
        const result = scoreVarSet(
            mkVars(['VK-a', 'VK-b', 'VK-c', 'VK-d']),
            ['t1', 't2', 't3'],
            mkVars(['VK-a', 'VK-b', 'VK-c']),
            ['t1', 't2', 'other'],
        );
        assertClose(result.matchRatio, 0.75);
        assert.strictEqual(result.tagMatches, 2);
        assertClose(result.score, 0.725, 1e-9);
    });

    test('full var match + full tag match → score = 1.0', () => {
        const result = scoreVarSet(
            mkVars(['VK-a']),
            ['api'],
            mkVars(['VK-a']),
            ['api'],
        );
        assertClose(result.matchRatio, 1.0);
        assertClose(result.score,      1.0);
    });

    // ── Artifact has no tags ──────────────────────────────────────────────────

    test('artifact with no tags → tag component is 0 → score derives only from var match', () => {
        // 4/4 vars match → matchRatio 1.0 → score = 0.7
        const result = scoreVarSet(
            mkVars(['VK-a', 'VK-b', 'VK-c', 'VK-d']),
            [],
            mkVars(['VK-a', 'VK-b', 'VK-c', 'VK-d']),
            ['anything', 'else'],
        );
        assert.strictEqual(result.tagMatches, 0);
        assertClose(result.score, 0.7);
    });

    // ── Artifact has no vars ──────────────────────────────────────────────────

    test('artifact with no vars → matchRatio: 0 → score derives only from tag match', () => {
        // 1/1 tags match → tag component = 0.3
        const result = scoreVarSet(
            mkVars([]),
            ['only-tag'],
            mkVars(['VK-x']),
            ['only-tag'],
        );
        assertClose(result.matchRatio, 0.0);
        assert.strictEqual(result.tagMatches, 1);
        assertClose(result.score, 0.3);
    });

    test('artifact with no vars and no tags → score is 0 regardless of set', () => {
        const result = scoreVarSet(
            mkVars([]),
            [],
            mkVars(['VK-x', 'VK-y']),
            ['t1', 't2'],
        );
        assertClose(result.matchRatio, 0.0);
        assert.strictEqual(result.tagMatches, 0);
        assertClose(result.score, 0.0);
    });

    // ── Empty set vars ────────────────────────────────────────────────────────

    test('empty set vars → matchRatio: 0 and all artifact vars are unmatched', () => {
        const result = scoreVarSet(
            mkVars(['VK-host', 'VK-port']),
            [],
            mkVars([]),
            [],
        );
        assertClose(result.matchRatio, 0.0);
        assert.deepStrictEqual(result.matchedVars,        []);
        assert.deepStrictEqual(result.unmatchedVars.sort(), ['VK-host', 'VK-port']);
        assert.deepStrictEqual(result.extraVars,          []);
    });

    test('empty set vars but tags match → score reflects tags only', () => {
        const result = scoreVarSet(
            mkVars(['VK-x']),
            ['t1'],
            mkVars([]),
            ['t1'],
        );
        assertClose(result.matchRatio, 0.0);
        assert.strictEqual(result.tagMatches, 1);
        assertClose(result.score, 0.3);
    });

    // ── Var name matching is exact string on .name field ──────────────────────

    test('matching is by exact .name string, not by hint or by case-folding', () => {
        // 'VK-host' vs 'VK-Host' must NOT match (case-sensitive).
        const result = scoreVarSet(
            mkVars(['VK-host']),
            [],
            mkVars(['VK-Host']),
            [],
        );
        assertClose(result.matchRatio, 0.0);
        assert.deepStrictEqual(result.matchedVars,   []);
        assert.deepStrictEqual(result.unmatchedVars, ['VK-host']);
        assert.deepStrictEqual(result.extraVars,     ['VK-Host']);
    });

    test('VK- prefix is part of the name and required for the match', () => {
        // 'VK-host' vs 'host' must NOT match.
        const result = scoreVarSet(
            mkVars(['VK-host']),
            [],
            [{ name: 'host', defaultValue: '' }],
            [],
        );
        assertClose(result.matchRatio, 0.0);
        assert.deepStrictEqual(result.matchedVars, []);
    });

    // ── Stability of returned arrays ──────────────────────────────────────────

    test('matchedVars + unmatchedVars partition the artifact var name set exactly', () => {
        const result = scoreVarSet(
            mkVars(['VK-a', 'VK-b', 'VK-c']),
            [],
            mkVars(['VK-a', 'VK-c']),
            [],
        );
        const recombined = [...result.matchedVars, ...result.unmatchedVars].sort();
        assert.deepStrictEqual(recombined, ['VK-a', 'VK-b', 'VK-c']);
    });

});
