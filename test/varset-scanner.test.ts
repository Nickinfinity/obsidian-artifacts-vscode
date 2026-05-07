import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import { VarSetScanner } from '../src/services/varset.service.js';

/**
 * Integration tests for VarSetScanner — recursively scans a Variables directory
 * and returns parsed `.md` artifact files, caching results until invalidated.
 *
 * The class does NOT exist yet — all tests here should fail until
 * src/services/varset.service.ts is implemented and exports `VarSetScanner`.
 *
 * Usage contract:
 *   const scanner = new VarSetScanner();
 *   const files   = await scanner.scan(variablesDirUri);
 *   scanner.invalidate();
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Creates a fresh temporary directory rooted at the OS temp dir.
 *
 * @returns Absolute path to a unique scratch directory the test owns.
 *
 * @example
 * const dir = mkTempVarsDir();
 */
function mkTempVarsDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'varset-scanner-test-'));
}

/**
 * Removes a directory tree previously returned from `mkTempVarsDir`.
 *
 * @param dir - Absolute path returned from `mkTempVarsDir`.
 * @returns void
 *
 * @example
 * rmTempVarsDir(dir);
 */
function rmTempVarsDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes a `type: variables` artifact `.md` file with a single `vars` fence.
 *
 * @param filePath - Absolute target path on disk.
 * @param env      - Frontmatter `env` value (e.g. `dev`, `prod`).
 * @param vars     - Map of `KEY=value` pairs to embed in the vars fence.
 * @returns void
 *
 * @example
 * writeVarFile('/tmp/x/dev.md', 'dev', { API_URL: 'http://localhost:3000' });
 */
function writeVarFile(filePath: string, env: string, vars: Record<string, string>): void {
    const lines = [
        '---',
        'type: variables',
        `env: ${env}`,
        '---',
        '',
        '```vars',
        ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
        '```',
        '',
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

/**
 * Writes a multi-block `type: variables` artifact file using `## Heading` blocks.
 *
 * @param filePath - Absolute target path on disk.
 * @param blocks   - Ordered array of `{ heading, vars }` entries.
 * @returns void
 *
 * @example
 * writeMultiBlockVarFile('/tmp/x/all.md', [
 *   { heading: 'Dev',  vars: { API_URL: 'http://localhost' } },
 *   { heading: 'Prod', vars: { API_URL: 'https://api.example.com' } },
 * ]);
 */
function writeMultiBlockVarFile(
    filePath: string,
    blocks: { heading: string; vars: Record<string, string> }[],
): void {
    const out: string[] = ['---', 'type: variables', '---', ''];
    for (const b of blocks) {
        out.push(`## ${b.heading}`, '```bash');
        for (const [k, v] of Object.entries(b.vars)) { out.push(`${k}=${v}`); }
        out.push('```', '');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, out.join('\n'), 'utf-8');
}

/**
 * Writes a non-variables artifact (`type: snippet`) for negative-path coverage.
 *
 * @param filePath - Absolute target path on disk.
 * @returns void
 *
 * @example
 * writeSnippetFile('/tmp/x/snippet.md');
 */
function writeSnippetFile(filePath: string): void {
    const content = [
        '---',
        'type: snippet',
        'title: Not A Var Set',
        '---',
        '',
        '```code',
        'console.log("hi");',
        '```',
        '',
    ].join('\n');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
}

// ── Test suite ────────────────────────────────────────────────────────────────

suite('VarSetScanner', () => {

    let tmpDir: string;

    setup(() => { tmpDir = mkTempVarsDir(); });
    teardown(() => { rmTempVarsDir(tmpDir); });

    // ── scan — basic behaviour ────────────────────────────────────────────────

    test('returns parsed .md files from the directory', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'),  'dev',  { API_URL: 'http://localhost' });
        writeVarFile(path.join(tmpDir, 'prod.md'), 'prod', { API_URL: 'https://api.example.com' });

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(files.length, 2);
        const names = files.map((f: ParsedArtifactFile) => f.fileName).sort();
        assert.deepStrictEqual(names, ['dev', 'prod']);
        assert.ok(files.every((f: ParsedArtifactFile) => f.frontmatter.type === 'variables'));
    });

    test('returns empty array for an empty directory', async () => {
        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));
        assert.deepStrictEqual(files, []);
    });

    // ── scan — filtering ──────────────────────────────────────────────────────

    test('skips non-.md files', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'), 'dev', { KEY: 'value' });
        fs.writeFileSync(path.join(tmpDir, 'notes.txt'),       'plain text', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'config.json'),     '{}',         'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'README'),          'no ext',     'utf-8');

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].fileName, 'dev');
    });

    test('skips files where frontmatter.type is not "variables"', async () => {
        writeVarFile(path.join(tmpDir, 'real-vars.md'), 'dev', { KEY: 'value' });
        writeSnippetFile(path.join(tmpDir, 'snippet.md'));
        // No frontmatter at all → falls through to default type 'snippet' → skipped.
        fs.writeFileSync(path.join(tmpDir, 'no-fm.md'), '```code\necho hi\n```\n', 'utf-8');

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].fileName, 'real-vars');
        assert.strictEqual(files[0].frontmatter.type, 'variables');
    });

    // ── scan — recursion ──────────────────────────────────────────────────────

    test('recurses into subdirectories', async () => {
        writeVarFile(path.join(tmpDir, 'top.md'),                         'dev',  { A: '1' });
        writeVarFile(path.join(tmpDir, 'envs', 'staging.md'),             'stg',  { A: '2' });
        writeVarFile(path.join(tmpDir, 'envs', 'prod', 'us-east.md'),     'prod', { A: '3' });
        writeVarFile(path.join(tmpDir, 'envs', 'prod', 'eu-west.md'),     'prod', { A: '4' });

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(files.length, 4);
        const names = files.map((f: ParsedArtifactFile) => f.fileName).sort();
        assert.deepStrictEqual(names, ['eu-west', 'staging', 'top', 'us-east']);
    });

    test('recursion still filters non-.md and non-variables files at every level', async () => {
        writeVarFile(path.join(tmpDir, 'top.md'),                       'dev',  { A: '1' });
        writeSnippetFile(path.join(tmpDir, 'sub', 'snippet.md'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'ignored.txt'), 'x', 'utf-8');
        writeVarFile(path.join(tmpDir, 'sub', 'real.md'),               'prod', { A: '2' });

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        const names = files.map((f: ParsedArtifactFile) => f.fileName).sort();
        assert.deepStrictEqual(names, ['real', 'top']);
    });

    // ── Parsed shape ─────────────────────────────────────────────────────────

    test('multi-block variable file has one block per ## heading with its own vars', async () => {
        writeMultiBlockVarFile(path.join(tmpDir, 'all.md'), [
            { heading: 'Development', vars: { API_URL: 'http://localhost:3000', DB_URL: 'mongodb://localhost' } },
            { heading: 'Production',  vars: { API_URL: 'https://api.example.com', DB_URL: 'mongodb://prod' } },
        ]);

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(files.length, 1);
        const file = files[0];
        assert.strictEqual(file.blocks.length, 2);
        assert.strictEqual(file.blocks[0].heading, 'Development');
        assert.strictEqual(file.blocks[1].heading, 'Production');
        // Each block has its own vars list — auto-detected from the block code.
        assert.ok(Array.isArray(file.blocks[0].vars));
        assert.ok(Array.isArray(file.blocks[1].vars));
    });

    test('single-block variable file has blocks: [] and vars on the top-level vars field', async () => {
        writeVarFile(path.join(tmpDir, 'simple.md'), 'dev', {
            API_URL: 'http://localhost:3000',
            DB_URL:  'mongodb://localhost:27017',
        });

        const scanner = new VarSetScanner();
        const files   = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(files.length, 1);
        const file = files[0];
        assert.deepStrictEqual(file.blocks, []);
        assert.ok(file.vars.length >= 2, `expected top-level vars to be populated, got ${JSON.stringify(file.vars)}`);
        const names = file.vars.map((v: { name: string }) => v.name).sort();
        assert.deepStrictEqual(names, ['API_URL', 'DB_URL']);
    });

    // ── Caching ───────────────────────────────────────────────────────────────

    test('second scan returns the same references without re-reading disk', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'),  'dev',  { KEY: 'a' });
        writeVarFile(path.join(tmpDir, 'prod.md'), 'prod', { KEY: 'b' });

        const scanner = new VarSetScanner();
        const first   = await scanner.scan(vscode.Uri.file(tmpDir));
        const second  = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(second.length, first.length);
        // Reference equality on each parsed entry — confirms no re-read happened.
        for (let i = 0; i < first.length; i++) {
            assert.strictEqual(second[i], first[i], `entry ${i} should be the same reference`);
        }
    });

    test('cached result is not affected by disk changes between calls', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'), 'dev', { KEY: 'original' });

        const scanner = new VarSetScanner();
        const first   = await scanner.scan(vscode.Uri.file(tmpDir));

        // Mutate disk after first scan — second scan must still return cached refs.
        writeVarFile(path.join(tmpDir, 'dev.md'),  'dev',  { KEY: 'CHANGED' });
        writeVarFile(path.join(tmpDir, 'new.md'), 'prod', { KEY: 'new'      });

        const second = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(second.length, first.length);
        for (let i = 0; i < first.length; i++) {
            assert.strictEqual(second[i], first[i], `entry ${i} should be the cached reference`);
        }
    });

    // ── invalidate ────────────────────────────────────────────────────────────

    test('invalidate clears the cache so the next scan re-reads disk', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'), 'dev', { KEY: 'a' });

        const scanner = new VarSetScanner();
        const first   = await scanner.scan(vscode.Uri.file(tmpDir));
        scanner.invalidate();
        const second  = await scanner.scan(vscode.Uri.file(tmpDir));

        // Same content, but different object identities (re-parsed from disk).
        assert.strictEqual(second.length, first.length);
        assert.notStrictEqual(second[0], first[0], 'invalidate should force a re-read — references must differ');
    });

    test('invalidate followed by scan picks up new files added since last scan', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'), 'dev', { KEY: 'a' });

        const scanner = new VarSetScanner();
        const first   = await scanner.scan(vscode.Uri.file(tmpDir));
        assert.strictEqual(first.length, 1);

        // Add a new file — without invalidate the cached result hides it.
        writeVarFile(path.join(tmpDir, 'prod.md'), 'prod', { KEY: 'b' });
        const cached = await scanner.scan(vscode.Uri.file(tmpDir));
        assert.strictEqual(cached.length, 1, 'cached scan should still report 1 file');

        scanner.invalidate();
        const refreshed = await scanner.scan(vscode.Uri.file(tmpDir));
        const names     = refreshed.map((f: ParsedArtifactFile) => f.fileName).sort();
        assert.deepStrictEqual(names, ['dev', 'prod']);
    });

    test('invalidate followed by scan reflects file removals since last scan', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'),  'dev',  { KEY: 'a' });
        writeVarFile(path.join(tmpDir, 'prod.md'), 'prod', { KEY: 'b' });

        const scanner = new VarSetScanner();
        const first   = await scanner.scan(vscode.Uri.file(tmpDir));
        assert.strictEqual(first.length, 2);

        fs.rmSync(path.join(tmpDir, 'prod.md'));
        scanner.invalidate();

        const refreshed = await scanner.scan(vscode.Uri.file(tmpDir));
        assert.strictEqual(refreshed.length, 1);
        assert.strictEqual(refreshed[0].fileName, 'dev');
    });

});
