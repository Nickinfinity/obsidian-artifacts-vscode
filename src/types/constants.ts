import type { VaultDirsArray } from './vault.types.js';

export const VAULT_DIRS: VaultDirsArray = [
	{ name: 'Snippets', dir: 'Snippets', default: true },
	{ name: 'Agents Config', dir: 'AgentsConf', default: true },
	{ name: 'Commands', dir: 'Commands', default: false },
	{ name: 'Templates', dir: 'Templates', default: false },
	{ name: 'Variables', dir: 'Variables', default: false }
] as const;
