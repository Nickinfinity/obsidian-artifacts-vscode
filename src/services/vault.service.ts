import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VAULT_DIRS } from './vault.constants.js';

export interface VaultDirStatus {
	name: string;
	active: boolean;
	exists: boolean;
}

export function validateObsidianVault(vaultPath: string): boolean {
	const obsidianDir = path.join(vaultPath, '.obsidian');
	if (!fs.existsSync(obsidianDir)) {
		vscode.window.showErrorMessage(
			`"${vaultPath}" is not a valid Obsidian vault. The selected folder must contain a .obsidian directory.`
		);
		return false;
	}
	return true;
}

export function detectVaultDirs(vaultPath: string): VaultDirStatus[] {
	return VAULT_DIRS.map((dir) => {
		const dirPath = path.join(vaultPath, dir.name);
		let exists = fs.existsSync(dirPath);
		if (dir.active && !exists) {
			fs.mkdirSync(dirPath, { recursive: true });
			exists = true;
		}
		return { ...dir, exists };
	});
}
