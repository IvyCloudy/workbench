"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.locale = locale;
exports.t = t;
exports.tf = tf;
/* global window */
const en_1 = __importDefault(require("./en"));
// Defines the fallback language as English
let $languages = ['en'];
const $messages = {
    en: en_1.default,
};
function translate(key, messages) {
    if (messages) {
        // Return the translation from the first language in the languages array
        // that has a value for the provided key.
        for (const lang of $languages) {
            if (!messages[lang])
                break;
            let message = messages[lang];
            // Splits the key at '.' except where escaped as '\.'
            const keys = key.match(/(?:\\.|[^.])+/g);
            for (let i = 0; i < keys.length; i += 1) {
                const property = keys[i];
                const value = message[property];
                // If value doesn't exist, try next language
                if (!value)
                    break;
                if (i === keys.length - 1)
                    return value;
                // Move down to the next level of the messages object
                message = value;
            }
        }
    }
    return undefined;
}
function t(key) {
    let v = translate(key, $messages);
    if (!v && window && window.x_spreadsheet && window.x_spreadsheet.$messages) {
        v = translate(key, window.x_spreadsheet.$messages);
    }
    return v || '';
}
function tf(key) {
    return () => t(key);
}
// If clearLangList is set to false, lang will be added to the front of the
// languages array. The languages in the language array are searched in order
// to find a translation. This allows the use of other languages as a fallback
// if lang is missing some keys. The language array is preloaded with English.
// To set the languages array to only include lang, set clearLangList to true.
function locale(lang, message, clearLangList = false) {
    if (clearLangList) {
        $languages = [lang];
    }
    else {
        // Append to front of array.
        // Translation method will use the first language in the list that has a
        // matching key.
        $languages.unshift(lang);
    }
    if (message) {
        $messages[lang] = message;
    }
}
exports.default = {
    t,
};
//# sourceMappingURL=locale.js.map