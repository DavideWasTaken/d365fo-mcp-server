import { settingByPath } from '../config/settings.js';
import { askSetting } from './settingsPrompt.js';
import { writeSetting, type SettingsStore } from './settingsStore.js';
import { p } from './ui.js';

/** A blank server intentionally skips the rest of this optional feature. */
export async function configureSql(store: SettingsStore): Promise<void> {
  const setting = (path: string) => settingByPath(`sql.${path}`)!;
  p.log.step('AxDB SQL — optional');
  const server = await askSetting(store, setting('server'));
  const enabled = typeof server === 'string' && !!server.trim();
  writeSetting(store, setting('enabled'), enabled);
  if (!enabled) {
    writeSetting(store, setting('allowWrites'), false);
    p.log.info('SQL is disabled. You can configure it later with d365fo-mcp config sql.');
    return;
  }
  p.log.info('Authentication uses the Windows account running MCP; no SQL password is needed.');
  await askSetting(store, setting('database'));
  await askSetting(store, setting('allowWrites'));
  await askSetting(store, setting('trustServerCertificate'));
}
