/**
 * Must be the FIRST import in main.ts.
 *
 * A packaged .app is read-only (its code lives inside app.asar), so the data
 * directory, config.json and .env cannot sit next to the source. This module
 * redirects them into Electron's userData directory before any other module
 * reads a path, and seeds config.json from the bundled default on first run.
 *
 * In development nothing is overridden: everything stays in the project folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

if (app.isPackaged) {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const configFile = path.join(userData, 'config.json');
  const envFile = path.join(userData, '.env');

  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(configFile)) {
    const bundled = path.join(process.resourcesPath, 'config.json');
    try {
      if (fs.existsSync(bundled)) fs.copyFileSync(bundled, configFile);
    } catch {
      // A missing default is not fatal: the Zod schema fills every field.
    }
  }

  process.env.BLS_DATA_DIR = dataDir;
  process.env.BLS_CONFIG_PATH = configFile;
  process.env.BLS_ENV_PATH = envFile;
}

/** Where a packaged build keeps its editable files, for the UI to report. */
export const USER_DATA_DIR = app.isPackaged ? app.getPath('userData') : null;
