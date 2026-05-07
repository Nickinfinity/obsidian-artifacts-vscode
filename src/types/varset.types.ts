import type { ParsedArtifactFile, ParsedVar } from './parsed-artifact.types.js';

/**
 * Score and overlap report produced by `scoreVarSet`.
 *
 * The report compares one artifact's variable + tag profile against one
 * candidate variable set's profile so the picker can rank sub-sets by
 * combined similarity.
 *
 * @example
 * {
 *   matchedVars:   ['VK-host', 'VK-port'],
 *   unmatchedVars: ['VK-token'],
 *   extraVars:     ['VK-debug'],
 *   matchRatio:    0.6667,
 *   tagMatches:    1,
 *   score:         0.5667,
 * }
 */
export interface VarSetMatch {
    /** Var names present in both the artifact and the set. */
    matchedVars: string[];
    /** Artifact var names that the set does not provide. */
    unmatchedVars: string[];
    /** Set var names that the artifact does not require. */
    extraVars: string[];
    /** Fraction of artifact vars matched by the set — `matched / totalArtifact`, 0 when artifact has no vars. */
    matchRatio: number;
    /** Number of artifact tags that also appear in the set's tag list. */
    tagMatches: number;
    /** Combined score: `matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3`. */
    score: number;
}

/**
 * One independently-applicable variable set extracted from a `ParsedArtifactFile`.
 *
 * For multi-block files, one `VarSubSet` is produced per `## Heading` block.
 * For single-block files, one `VarSubSet` wraps the file's top-level `vars`.
 *
 * @example
 * {
 *   heading:    'Local Development',
 *   vars:       [{ name: 'VK-API_URL', defaultValue: 'http://localhost:3000' }],
 *   sourceFile: <ParsedArtifactFile>,
 * }
 */
export interface VarSubSet {
    /** Display heading — block heading or, for single-block files, the parent file title/fileName. */
    heading: string;
    /** Variables this sub-set defines. */
    vars: ParsedVar[];
    /** Back-reference to the parsed file the sub-set was extracted from. */
    sourceFile: ParsedArtifactFile;
}

/**
 * One row in an `ApplyResult.changes` array — describes the per-var transition
 * produced by applying a variable set on top of the user's current input values.
 */
export interface ApplyChange {
    /** Full var name (e.g. `'VK-host'`). */
    name: string;
    /** Value before apply (`''` when the var was not set). */
    oldValue: string;
    /** Value after apply (`''` when no incoming value was provided). */
    newValue: string;
    /**
     * - `'filled'`     — old value was empty; set provided a value (incl. empty string).
     * - `'overridden'` — old value was non-empty; set replaced it.
     * - `'kept'`       — set did not provide this var; old value preserved.
     */
    action: 'filled' | 'overridden' | 'kept';
}

/**
 * Result of `applyVarSet` — merged values plus per-var change log.
 */
export interface ApplyResult {
    /** Final merged value map, keyed by full var name. */
    values: Record<string, string>;
    /** One entry per var in the union of `current` and `set` keys. */
    changes: ApplyChange[];
}
