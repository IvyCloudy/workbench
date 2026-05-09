import * as vscode from 'vscode';

export function getCurrentFolderName(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].name;
    }
    return '';
}
