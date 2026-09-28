/**
 * What a classic AOSService VM already says about itself.
 *
 * The AOS reads its own database and address from AosService\WebRoot\web.config,
 * next to PackagesLocalDirectory. The setup wizard used to ask for the same
 * values by hand — the SQL server, the AxDB name and the environment URL that
 * UI verification and the post-build AOS restart both use — where a typo only
 * surfaced later, as a failed query or a restart that matched no IIS binding.
 * Offering what the AOS itself uses removes the typing; the user still confirms.
 *
 * UDE machines have no local AOS and so no web.config: callers get null.
 */
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readAppSetting } from '../utils/appSettings.js';

export interface AosWebConfig {
  /** Environment root, e.g. https://usnconeboxax1aos.cloud.onebox.dynamics.com/ */
  hostUrl?: string;
  /** DataAccess.DbServer — often "." or the machine name. */
  dbServer?: string;
  /** DataAccess.Database — AxDB on a standard VM. */
  database?: string;
}

/** Environment root of an HTTP(S) URL, or undefined when it is not one. */
function environmentRoot(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}

/** Parse the values out of a web.config document. */
export function parseAosWebConfig(xml: string): AosWebConfig {
  const get = (key: string) => readAppSetting(xml, key)?.trim() || undefined;
  return {
    hostUrl: environmentRoot(get('Infrastructure.HostUrl')),
    dbServer: get('DataAccess.DbServer'),
    database: get('DataAccess.Database'),
  };
}

/** web.config of the AOS that serves `packagesRoot`, or null when there is none to read. */
export function readAosWebConfig(packagesRoot: string | undefined): AosWebConfig | null {
  if (!packagesRoot) return null;
  try {
    return parseAosWebConfig(fs.readFileSync(join(packagesRoot, '..', 'WebRoot', 'web.config'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Whether a SQL server name points at this machine.
 *
 * A developer VM's SQL Server almost always presents a self-signed certificate,
 * so an encrypted connection to it fails validation unless the certificate is
 * trusted; the wizard defaults that answer to yes for a local server only.
 */
export function isLocalSqlServer(server: string, machine: string = hostname()): boolean {
  const host = server.trim().replace(/^(tcp|np|lpc):/i, '').split(/[\\,]/)[0].trim().toLowerCase();
  return ['.', '(local)', 'localhost', '127.0.0.1', '::1', machine.toLowerCase()].includes(host)
    || host.startsWith('(localdb)');
}
