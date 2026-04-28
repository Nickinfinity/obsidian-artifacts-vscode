import * as vscode from 'vscode';
import { registerOpenConfigCommand } from './commands/openConfig.command.js';

export function activate(context: vscode.ExtensionContext) {
	registerOpenConfigCommand(context);
}

export function deactivate() {}
