import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProfileSchema } from './contract.js';

export class MissingUiEnvironmentUrl extends Error {
  constructor() { super('UI test environment URL is required'); }
}

/** Explicit profiles replace setup configuration; never mix authentication across environments. */
export async function resolveUiProfile(profilePath?: string, environmentUrl?: string) {
  if (profilePath) {
    const profile = ProfileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
    return {
      ...profile,
      storageState: path.resolve(path.dirname(profilePath), profile.storageState),
      outputDir: path.resolve(path.dirname(profilePath), profile.outputDir),
    };
  }
  const baseUrl = process.env.D365FO_UI_TEST_URL?.trim() || environmentUrl;
  if (!baseUrl) throw new MissingUiEnvironmentUrl();
  // loadEnv anchors both path settings (including defaults) to the active installation/instance.
  const storageState = process.env.D365FO_UI_STORAGE_STATE;
  const outputDir = process.env.D365FO_UI_OUTPUT_DIR;
  if (!storageState || !outputDir || !path.isAbsolute(storageState) || !path.isAbsolute(outputDir))
    throw new Error('UI test paths are not initialized; restart the MCP after setup to load its configuration');
  return ProfileSchema.parse({ baseUrl, storageState, outputDir });
}
