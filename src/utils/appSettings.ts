/**
 * `<appSettings>` values out of a .NET .config document (web.config,
 * SysTestConsole.exe.config) — without an XML parser, because only flat
 * `<add key="…" value="…"/>` entries are ever read.
 */

/** One `<add key="…" value="…"/>` out of a .config document. */
export function readAppSetting(xml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<add\\s+key="${escaped}"\\s+value="([^"]*)"`, 'i').exec(xml)?.[1];
}
