import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getNonce } from '../utils/helpers.js';
import { validateObsidianVault, detectVaultDirs, createVaultDirectory, deleteVaultDirectory, isDirectoryEmpty } from '../services/vault.service.js';
import { VAULT_DIRS } from '../types/constants.js';

/**
 * Opens the configuration panel webview where users can:
 * 1. Select their Obsidian vault root directory
 * 2. Choose which vault feature directories to create/maintain
 *
 * The panel displays a folder selector, vault directory checkboxes, and handles
 * all user interactions including folder selection and directory toggling.
 *
 * @param {vscode.ExtensionContext} context - Extension context providing global storage paths
 *                                            and extension URI for loading assets
 *
 * @example
 * openSettingsPanel(context);
 * // Opens a webview panel allowing vault configuration
 */
export function openSettingsPanel(context: vscode.ExtensionContext) {
	// Path to store the selected vault root directory persistently
	const configFilePath = path.join(context.globalStorageUri.fsPath, 'ai_obsidian_sandt.conf');

	const panel = vscode.window.createWebviewPanel(
		'settings',
		'AI Obsidian Snippets & Tools - Settings',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
		}
	);

	panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

	// Listen for messages from the webview (user interactions)
	panel.webview.onDidReceiveMessage(async (message) => {
		// HANDLER: User clicked "Select Vault Folder" button
		if (message.command === 'selectFolder') {
			// Show native file picker dialog - users can only select folders, not files
			const folderUri = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Select Vault'
			});

			if (folderUri && folderUri[0]) {
				// User selected a folder
				const selectedFolderPath = folderUri[0].fsPath;

				// Validate the selected path is a valid Obsidian vault (contains .obsidian/)
				if (!validateObsidianVault(selectedFolderPath)) {
					// validateObsidianVault shows error message to user, so just return early
					return;
				}

				// Get the status of all predefined vault directories in this vault
				const detectedDirs = detectVaultDirs(selectedFolderPath);

				// Ensure global storage directory exists for saving the config file
				if (!fs.existsSync(context.globalStorageUri.fsPath)) {
					fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
				}

				// Persist the vault path to disk so it loads on extension restart
				fs.writeFileSync(configFilePath, selectedFolderPath, 'utf8');
				vscode.window.showInformationMessage(`Obsidian vault path saved: ${selectedFolderPath}`);

				// Send vault path and directory status back to webview to update UI
				panel.webview.postMessage({ command: 'updatePath', path: selectedFolderPath, dirs: detectedDirs });
			} else {
				vscode.window.showWarningMessage('No folder selected.');
			}
		}
		// HANDLER: User toggled a vault directory checkbox
		else if (message.command === 'dirToggle') {
			// Extract parameters from the checkbox toggle message
			const vaultPath = message.vaultPath;
			const dirName = message.dirName;
			const isChecked = message.isChecked;

			// Safety check: ensure a vault has been selected before allowing directory operations
			if (!vaultPath) {
				vscode.window.showWarningMessage('Please select a vault first.');
				return;
			}

			if (isChecked) {
				// User checked the checkbox: CREATE the directory
				createVaultDirectory(vaultPath, dirName);
			} else {
				// User unchecked the checkbox: DELETE the directory (if empty)
				// First check if directory is empty to prevent accidental data loss
				if (!isDirectoryEmpty(path.join(vaultPath, dirName))) {
					vscode.window.showWarningMessage(`Cannot delete "${dirName}" because it is not empty.`);
					return;
				}
				deleteVaultDirectory(vaultPath, dirName);
			}

			// Refresh the directory status in the UI after the operation
			const updatedDirs = detectVaultDirs(vaultPath);
			panel.webview.postMessage({ command: 'updateDirs', dirs: updatedDirs });
		}
	});

	// On panel open, load any previously saved vault path from persistent storage
	if (fs.existsSync(configFilePath)) {
		const savedPath = fs.readFileSync(configFilePath, 'utf8');
		// Detect directory status for the saved vault and send to webview
		const detectedDirs = detectVaultDirs(savedPath);
		panel.webview.postMessage({ command: 'updatePath', path: savedPath, dirs: detectedDirs });
	}
}

/**
 * Generates the HTML/CSS/JS content for the settings webview panel.
 *
 * This function creates a complete self-contained webview with:
 * - Introduction text explaining the extension
 * - Vault folder selector button
 * - Checkbox list for vault directories (shown only after vault selection)
 * - CSS styling using VS Code theme variables for consistent appearance
 * - JavaScript for handling user interactions and webview communication
 *
 * @param {vscode.Webview} webview - The webview object for loading assets and CSP headers
 * @param {vscode.Uri} extensionUri - The extension's URI for resolving media asset paths
 * @returns {string} Complete HTML document as a string ready for webview.html assignment
 *
 * @description
 * The webview communicates with the extension via postMessage for:
 * - selectFolder: when user clicks folder selector
 * - dirToggle: when user toggles directory checkboxes
 *
 * Receives messages from extension:
 * - updatePath: when vault is selected (includes vault path and directory status)
 * - updateDirs: when directory status changes (refreshes checkbox states)
 */
function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
	// Generate a random nonce for Content Security Policy (prevents inline script injection attacks)
	const nonce = getNonce();
	// Load external CSS stylesheet from media folder (loaded as URI for security)
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Content Security Policy: inline scripts only allowed with matching nonce, styles from webview host -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
  <!-- Load external stylesheet from extension media folder -->
  <link rel="stylesheet" href="${styleUri}">
  <title>AI Obsidian Snippets & Tools - CONFIG</title>
</head>
<body>
  <div id="webviewContent">
    <!-- Header: extension logo and title -->
    <div class="logo-row">
      <span class="logo-icon">🔮</span>
      <h1>Obsidian Notes &amp; Snippets</h1>
    </div>
    <p class="tagline">Bring your Obsidian vault into VS Code</p>

    <hr>

    <!-- Introduction section explaining what the extension does -->
    <div class="intro">
      <p>This extension connects VS Code to your <strong>Obsidian vault</strong>, letting you browse notes, insert snippets, and create new entries without leaving the editor.</p>
      <p>To get started, point the extension to your vault's root folder — the directory that contains your <code>.obsidian/</code> folder. Your selection is saved locally and persists across sessions.</p>
    </div>

    <!-- Vault Location section: shows selected path and folder picker button -->
    <p class="section-label">Vault Location</p>

    <div class="vault-card">
      <span class="vault-icon">📁</span>
      <span id="folderPath">No vault selected</span>
    </div>

    <button id="selectFolderButton">
      <span>Select Vault Folder</span>
    </button>

    <!-- Vault Features section: shown only after vault selection -->
    <!-- Contains checkbox list for directory management -->
    <div id="directoriesSection" class="directories-section">
      <p class="section-label">Vault Features</p>
      <p style="font-size: 0.9rem; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">Select which directories to create in your vault. Directories marked as "default" will be auto-created when you first select your vault.</p>
      <!-- Directory checkboxes will be rendered here by JavaScript -->
      <div id="directoryList" class="directory-list"></div>
    </div>
  </div>

  <!-- Main webview script with nonce for security -->
  <script nonce="${nonce}">
    // Get VS Code API for postMessage communication
    const vscode = acquireVsCodeApi();
    let currentVaultPath = null;

    // LISTENER: Select Folder button click
    document.getElementById('selectFolderButton').addEventListener('click', () => {
      // Send message to extension asking for folder picker
      vscode.postMessage({ command: 'selectFolder' });
    });

    // LISTENER: Messages from extension (vault updates, directory status changes)
    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'updatePath') {
        // Vault path was selected: update UI with vault path and directory status
        currentVaultPath = message.path;
        const el = document.getElementById('folderPath');
        el.textContent = message.path;
        el.classList.add('has-path');

        // Render directory checkboxes if directory status was included
        if (message.dirs) {
          renderDirectories(message.dirs);
        }

        // Show the vault features section
        document.getElementById('directoriesSection').classList.add('active');
      }
      else if (message.command === 'updateDirs') {
        // Directory was created/deleted: refresh checkbox states
        if (message.dirs) {
          renderDirectories(message.dirs);
        }
      }
    });

    /**
     * Renders the directory checkbox list based on vault directory status.
     *
     * Creates a checkbox for each directory from VAULT_DIRS, setting checked state
     * based on whether the directory exists on disk. Includes labels showing
     * directory name and whether it's auto-created or optional.
     *
     * @param {Array} dirs - Array of directory status objects from detectVaultDirs()
     */
    function renderDirectories(dirs) {
      const directoryList = document.getElementById('directoryList');
      directoryList.innerHTML = ''; // Clear existing items

      // Create checkbox item for each vault directory
      dirs.forEach(dir => {
        // Label wraps the entire checkbox item for better UX
        const item = document.createElement('label');
        item.className = 'directory-item';

        // Checkbox: checked if directory exists
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = dir.exists;
        checkbox.setAttribute('data-dir-name', dir.dir);

        // Checkbox change handler: send dirToggle message to extension
        checkbox.addEventListener('change', (e) => {
          vscode.postMessage({
            command: 'dirToggle',
            vaultPath: currentVaultPath,
            dirName: dir.dir,
            isChecked: e.target.checked
          });
        });

        // Label text and hint container
        const labelDiv = document.createElement('div');
        labelDiv.className = 'directory-label';

        // Directory name
        const labelText = document.createElement('span');
        labelText.className = 'directory-label-text';
        labelText.textContent = dir.name;

        // Hint showing if auto-created (default) or optional
        const hint = document.createElement('span');
        hint.className = 'directory-hint';
        hint.textContent = dir.default ? '(automatically created)' : '(optional)';

        labelDiv.appendChild(labelText);
        labelDiv.appendChild(hint);

        item.appendChild(checkbox);
        item.appendChild(labelDiv);

        directoryList.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
}
