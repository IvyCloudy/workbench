import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const CONFIG_FILE = 'app-config.json';

export interface AppConfig {
    apiUrl: string;
    authToken: string;
    userId: string;
    userName: string;
}

const defaultConfig: AppConfig = {
    apiUrl: 'http://localhost:8081',
    authToken: '',
    userId: '',
    userName: ''
};

export function getConfigPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}

export function readConfig(context: vscode.ExtensionContext): AppConfig {
    const filePath = getConfigPath(context);
    try {
        return { ...defaultConfig, ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
    } catch {
        return { ...defaultConfig };
    }
}

export function writeConfig(context: vscode.ExtensionContext, partial: Partial<AppConfig>): AppConfig {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const current = readConfig(context);
    const updated = { ...current, ...partial };
    fs.writeFileSync(getConfigPath(context), JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}
