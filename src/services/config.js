const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const CONFIG_FILE = 'app-config.json';

const defaultConfig = {
    apiUrl: 'http://127.0.0.1:8081',
    authToken: '',
    userId: '',
    userName: '',
    sm2PublicKey: ''
};

function getConfigPath(context) {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}

function readConfig(context) {
    const filePath = getConfigPath(context);
    try {
        return { ...defaultConfig, ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
    } catch {
        return { ...defaultConfig };
    }
}

function writeConfig(context, partial) {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const current = readConfig(context);
    const updated = { ...current, ...partial };
    fs.writeFileSync(getConfigPath(context), JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}

module.exports = { getConfigPath, readConfig, writeConfig };
