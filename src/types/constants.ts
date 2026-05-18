import type { ArtifactsArray } from './artifact.types.js';

/**
 * All Obsidian vault artifact directories known to this extension.
 *
 * Each entry drives three things simultaneously:
 *  1. Which vault directories are created / detected (vault.service.ts)
 *  2. Which VS Code context keys are set (context.service.ts)
 *  3. Which insert commands are registered and where they appear (insert.command.ts + package.json)
 *
 * Context key and command ID are derived from `dir.toLowerCase()`:
 *   context key — `obsidian-artifacts.<dir.toLowerCase()>Active`
 *   command     — `obsidian-artifacts.insert.<dir.toLowerCase()>`
 *
 * `contexts: ['all']` means the artifact surfaces in every VS Code context menu.
 */
export const ARTIFACTS: ArtifactsArray = [
	{ name: 'Snippets',      dir: 'Snippets',   default: true,  contexts: ['editor'] },
	{ name: 'Agents Config', dir: 'AgentsConf', default: true,  contexts: ['explorer'] },
	{ name: 'Commands',      dir: 'Commands',   default: false, contexts: ['terminal'] },
	{ name: 'Templates',     dir: 'Templates',  default: false, contexts: ['editor', 'explorer'] },
	{ name: 'Variables',     dir: 'Variables',  default: false, contexts: ['all'] },
];
