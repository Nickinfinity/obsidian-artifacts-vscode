import * as vscode from 'vscode';
import { openSettingsPanel } from '../config/settings.js';

export function registerOpenConfigCommand(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('obsidian-notes-and-snippets.config', () => {
		openSettingsPanel(context);
	});
	context.subscriptions.push(disposable);
}
