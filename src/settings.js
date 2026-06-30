import { readFileSync, writeFileSync, existsSync } from 'fs';

const SETTINGS_FILE = './settings.json';

let settings = load();

function load() {
  if (existsSync(SETTINGS_FILE)) {
    try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')); } catch {}
  }
  return {};
}

function save() {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function getSetting(key, envKey, defaultVal) {
  return settings[key] ?? process.env[envKey] ?? defaultVal;
}

export function setSetting(key, value) {
  settings[key] = value;
  save();
}
