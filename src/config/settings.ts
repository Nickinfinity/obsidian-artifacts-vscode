import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from '../utils/helpers.js';
import { validateObsidianVault, detectVaultDirs, createVaultDirectory, deleteVaultDirectory, isDirectoryEmpty } from '../services/vault.service.js';
import { refreshVaultContext } from '../services/context.service.js';

/**
 * Opens the configuration panel webview where users can:
 * 1. Select their Obsidian vault root directory
 * 2. Choose which vault feature directories to create/maintain
 *
 * Vault path and feature flags are persisted via the VS Code Settings API
 * (`obsidianArtifacts.*`) so they sync across devices via Settings Sync.
 *
 * @param {vscode.ExtensionContext} context - Extension context providing the extension URI
 *                                            for loading webview assets
 *
 * @example
 * openSettingsPanel(context);
 */
export function openSettingsPanel(context: vscode.ExtensionContext) {
	const panel = vscode.window.createWebviewPanel(
		'settings',
		'Obsidian Artifacts: AI Snippets & Tools - Settings',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			// Preserve the webview's JS and DOM when the user switches to another tab.
			// Without this, VS Code destroys the webview context on hide and the HTML
			// reloads from scratch on return — the postMessage with saved config is never
			// re-sent, so the UI appears empty even though settings are intact.
			retainContextWhenHidden: true,
		}
	);

	panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

	// ── Restore saved config ──────────────────────────────────────────────────
	// Reads the current vault path from VS Code settings and sends it to the
	// webview. Called on initial open AND every time the panel becomes visible
	// again so any external setting changes (e.g. Settings Sync) are reflected.
	function postCurrentConfig(): void {
		const savedPath = vscode.workspace
			.getConfiguration('obsidianArtifacts')
			.get<string>('vaultPath', '')
			.trim();

		if (savedPath) {
			const detectedDirs = detectVaultDirs(savedPath);
			panel.webview.postMessage({ command: 'updatePath', path: savedPath, dirs: detectedDirs });
		}
	}

	// Re-hydrate the webview whenever it becomes visible (tab switch or initial focus)
	panel.onDidChangeViewState(({ webviewPanel }) => {
		if (webviewPanel.visible) {
			postCurrentConfig();
		}
	});

	// Listen for messages from the webview (user interactions)
	panel.webview.onDidReceiveMessage(async (message) => {
		// HANDLER: User clicked "Select Vault Folder" button
		if (message.command === 'selectFolder') {
			// Show native file picker dialog — users can only select folders, not files
			const folderUri = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Select Vault'
			});

			if (folderUri && folderUri[0]) {
				const selectedFolderPath = folderUri[0].fsPath;

				// Validate the selected path is a valid Obsidian vault (contains .obsidian/)
				if (!validateObsidianVault(selectedFolderPath)) {
					return;
				}

				// Persist vault path to VS Code settings (global scope = synced across devices)
				await vscode.workspace
					.getConfiguration('obsidianArtifacts')
					.update('vaultPath', selectedFolderPath, vscode.ConfigurationTarget.Global);

				vscode.window.showInformationMessage(`Obsidian vault path saved: ${selectedFolderPath}`);

				// Refresh context keys so editor/terminal/explorer menus reflect the new vault state
				refreshVaultContext();

				// Send vault path and directory status to webview to update UI
				const detectedDirs = detectVaultDirs(selectedFolderPath);
				panel.webview.postMessage({ command: 'updatePath', path: selectedFolderPath, dirs: detectedDirs });
			} else {
				vscode.window.showWarningMessage('No folder selected.');
			}
		}
		// HANDLER: User toggled a vault directory checkbox
		else if (message.command === 'dirToggle') {
			const vaultPath = message.vaultPath as string;
			const dirName  = message.dirName  as string;
			const isChecked = message.isChecked as boolean;

			// Safety check: ensure a vault has been selected before allowing directory operations
			if (!vaultPath) {
				vscode.window.showWarningMessage('Please select a vault first.');
				return;
			}

			if (isChecked) {
				// User enabled the feature: CREATE the directory on disk
				createVaultDirectory(vaultPath, dirName);
			} else {
				// User disabled the feature: DELETE the directory only if empty (safety guard)
				if (!isDirectoryEmpty(path.join(vaultPath, dirName))) {
					vscode.window.showWarningMessage(`Cannot disable "${dirName}" — directory is not empty.`);
					return;
				}
				deleteVaultDirectory(vaultPath, dirName);
			}

			// Persist the feature flag to VS Code settings so it syncs across devices
			await vscode.workspace
				.getConfiguration('obsidianArtifacts')
				.update(
					`features.${dirName.toLowerCase()}`,
					isChecked,
					vscode.ConfigurationTarget.Global
				);

			// Refresh context keys and send updated directory status back to the webview
			refreshVaultContext();
			const updatedDirs = detectVaultDirs(vaultPath);
			panel.webview.postMessage({ command: 'updateDirs', dirs: updatedDirs });
		}
	});

	// Send the initial saved config once the panel is open
	postCurrentConfig();
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
  <title>Obsidian Artifacts: AI Snippets & Tools - CONFIG</title>
</head>
<body>
  <div id="webviewContent">
    <!-- Header: extension logo and title -->
    <div class="logo-row">
      <span class="logo-icon">🔮</span>
      <h1>Obsidian Artifacts: AI Snippets &amp; Tools</h1>
    </div>
    <p class="tagline">Bring your Obsidian vault into VS Code</p>

    <hr>

    <!-- Introduction section explaining what the extension does -->
    <div class="intro">
      <p>This extension connects VS Code to your <strong>Obsidian vault</strong>, letting you browse notes, insert snippets, and create new entries without leaving the editor.</p>
      <p>To get started, point the extension to your vault's root folder — the directory that contains your <code>.obsidian/</code> folder. Your selection is saved locally and persists across sessions.</p>
    </div>

    <!-- Vault Features section: shown only after vault selection -->
    <!-- Contains checkbox list for directory management -->
    <div id="directoriesSection" class="directories-section">
      <p class="section-label">Vault Features</p>
      <p style="font-size: 0.9rem; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">Select which directories to create in your vault. Directories marked as "default" will be auto-created when you first select your vault.</p>
      <!-- Directory checkboxes will be rendered here by JavaScript -->
      <div id="directoryList" class="directory-list"></div>
    </div>

    <!-- Vault Location section: shows selected path and folder picker button -->
    <div class="vault-dir-section">
      <p class="section-label">Vault Location</p>

      <div class="vault-card">
        <span class="vault-icon">📁</span>
        <span id="folderPath">No vault selected</span>
      </div>

      <button id="selectFolderButton">
        <span>Select Vault Folder</span>
      </button>
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
     * Creates a checkbox for each directory from ARTIFACTS, setting checked state
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
