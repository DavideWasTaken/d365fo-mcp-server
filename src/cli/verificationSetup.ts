/**
 * The fork's optional verification targets: the environment URL for UI
 * verification (also the default AOS for the post-build restart) and AxDB SQL.
 *
 * Asked after the environment type, because both depend on it. A classic
 * AOSService VM names its own URL and database in WebRoot\web.config, so those
 * are offered as answers. A UDE machine has no local AOS: nothing to offer, and
 * no local AxDB reachable with Windows authentication, so SQL is not asked.
 */
import { settingByPath } from '../config/settings.js';
import { readAosWebConfig } from './aosWebConfig.js';
import { cliCommand } from './context.js';
import { askSetting } from './settingsPrompt.js';
import type { SettingsStore } from './settingsStore.js';
import { configureSql } from './sqlSetup.js';
import { p } from './ui.js';

export async function configureVerification(
  store: SettingsStore,
  envType: string,
  packagesRoot?: string,
): Promise<void> {
  const aos = envType === 'ude' ? null : readAosWebConfig(packagesRoot);
  p.log.step('UI verification — optional');
  if (aos?.hostUrl) p.log.info(`The local AOS answers at ${aos.hostUrl} (from its web.config).`);
  await askSetting(store, settingByPath('environment.uiTestUrl')!, { initial: aos?.hostUrl });
  if (envType === 'ude') {
    p.log.info(
      'AxDB SQL skipped — it needs a local AxDB reached with Windows authentication, which a UDE machine does not have.\n' +
      `   If you do have one: ${cliCommand('config sql')}`,
    );
    return;
  }
  await configureSql(store, aos);
}
