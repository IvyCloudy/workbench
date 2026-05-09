"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigPath = getConfigPath;
exports.readConfig = readConfig;
exports.writeConfig = writeConfig;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const CONFIG_FILE = 'app-config.json';
const defaultConfig = {
    apiUrl: 'http://localhost:8081',
    authToken: '',
    userId: '',
    userName: ''
};
function getConfigPath(context) {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}
function readConfig(context) {
    const filePath = getConfigPath(context);
    try {
        return { ...defaultConfig, ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
    }
    catch {
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
//# sourceMappingURL=config.js.map