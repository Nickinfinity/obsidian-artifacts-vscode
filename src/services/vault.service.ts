import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VAULT_DIRS } from '../types/constants.js';
import type { VaultDir } from '../types/vault.types.js';

/**
 * Extended vault directory information including existence status
 * @extends VaultDir
 * @property {boolean} exists - Whether the directory currently exists in the vault
 */
export interface VaultDirStatus extends VaultDir {
	exists: boolean;
}

/**
 * Validates that a given path is a valid Obsidian vault.
 *
 * A valid Obsidian vault must contain a `.obsidian/` directory at its root.
 * This is a core requirement for the vault to be recognized by Obsidian.
 *
 * @param {string} vaultPath - The absolute file path to validate as an Obsidian vault root
 * @returns {boolean} True if the path contains a `.obsidian/` directory, false otherwise.
 *                    Shows an error message to the user if validation fails.
 *
 * @example
 * const isValid = validateObsidianVault('/home/user/my-vault');
 * if (isValid) {
 *   console.log('Valid vault selected');
 * }
 */
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

/**
 * Detects the status of all vault directories defined in VAULT_DIRS.
 *
 * Maps through the predefined vault directory list and checks whether each
 * directory currently exists in the vault. This provides a snapshot of the
 * vault's directory structure.
 *
 * @param {string} vaultPath - The absolute file path to the Obsidian vault root
 * @returns {VaultDirStatus[]} Array of directory status objects, each containing:
 *                             - name: human-readable directory name
 *                             - dir: directory folder name
 *                             - default: whether directory should be auto-created
 *                             - exists: whether directory currently exists on disk
 *
 * @example
 * const dirs = detectVaultDirs('/home/user/my-vault');
 * // Returns: [
 * //   { name: 'Snippets', dir: 'Snippets', default: true, exists: true },
 * //   { name: 'Commands', dir: 'Commands', default: false, exists: false }
 * // ]
 */
export function detectVaultDirs(vaultPath: string): VaultDirStatus[] {
	// Map through all configured vault directories from constants
	return VAULT_DIRS.map((dir) => {
		// Construct the full path for this directory
		const dirPath = path.join(vaultPath, dir.dir);
		// Check if the directory exists on the filesystem
		const exists = fs.existsSync(dirPath);
		// Return status object combining config with current existence state
		return { ...dir, exists };
	});
}

/**
 * Checks whether a directory is empty (contains no files or subdirectories).
 *
 * Useful for safety checks before deleting a directory—we only want to delete
 * empty directories to avoid accidentally removing user data.
 *
 * @param {string} dirPath - The absolute file path to the directory to check
 * @returns {boolean} True if the directory doesn't exist or contains no files,
 *                    false if it contains any files or subdirectories
 *
 * @example
 * const empty = isDirectoryEmpty('/home/user/my-vault/Commands');
 * if (empty) {
 *   console.log('Safe to delete');
 * }
 */
export function isDirectoryEmpty(dirPath: string): boolean {
	// Non-existent directories are considered empty
	if (!fs.existsSync(dirPath)) return true;
	// Check if the directory has any entries (files or subdirectories)
	const files = fs.readdirSync(dirPath);
	return files.length === 0;
}

/**
 * Creates a vault directory if it doesn't already exist.
 *
 * Safely creates a directory with recursive parent creation enabled.
 * Idempotent—calling this multiple times is safe.
 * Shows error messages to the user if creation fails.
 *
 * @param {string} vaultPath - The absolute file path to the Obsidian vault root
 * @param {string} dirName - The directory name (folder) to create within the vault
 * @returns {boolean} True if directory was created or already existed, false on error
 *
 * @example
 * const success = createVaultDirectory('/home/user/my-vault', 'Snippets');
 * if (success) {
 *   console.log('Snippets directory is ready');
 * }
 */
export function createVaultDirectory(vaultPath: string, dirName: string): boolean {
	try {
		// Construct the full path: vaultPath/dirName
		const dirPath = path.join(vaultPath, dirName);
		// Only create if it doesn't already exist
		if (!fs.existsSync(dirPath)) {
			// recursive: true creates parent directories if needed
			fs.mkdirSync(dirPath, { recursive: true });
		}
		return true;
	} catch (error) {
		// Show error to user if directory creation fails
		vscode.window.showErrorMessage(`Failed to create directory: ${error}`);
		return false;
	}
}

/**
 * Deletes a vault directory if it exists and is empty.
 *
 * Safety check prevents accidental deletion of directories containing user data.
 * Only deletes if isDirectoryEmpty() returns true.
 * Shows error messages to the user if deletion fails.
 *
 * @param {string} vaultPath - The absolute file path to the Obsidian vault root
 * @param {string} dirName - The directory name (folder) to delete from the vault
 * @returns {boolean} True if directory was deleted, false if it's not empty or doesn't exist
 *
 * @example
 * const success = deleteVaultDirectory('/home/user/my-vault', 'Commands');
 * if (success) {
 *   console.log('Commands directory deleted');
 * } else {
 *   console.log('Directory not empty or does not exist');
 * }
 */
export function deleteVaultDirectory(vaultPath: string, dirName: string): boolean {
	try {
		// Construct the full path: vaultPath/dirName
		const dirPath = path.join(vaultPath, dirName);
		// Only delete if directory exists AND is empty (safety check)
		if (fs.existsSync(dirPath) && isDirectoryEmpty(dirPath)) {
			fs.rmdirSync(dirPath);
			return true;
		}
		return false;
	} catch (error) {
		// Show error to user if deletion fails
		vscode.window.showErrorMessage(`Failed to delete directory: ${error}`);
		return false;
	}
}
