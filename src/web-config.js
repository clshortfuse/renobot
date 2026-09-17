/**
 * @typedef {Readonly<{
 *   clientId: string,
 *   clientSecret: string,
 *   host: string,
 *   ownerUserId: string,
 *   port: number,
 *   publicBaseUrl: URL,
 *   sessionSecret: string,
 * }>} WebConfig
 */

/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {WebConfig | undefined}
 */
export function readWebConfig(environment = process.env) {
  const names = [
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'DISCORD_OWNER_USER_ID',
    'PUBLIC_BASE_URL',
    'SESSION_SECRET',
  ];
  const dashboardNames = ['DISCORD_CLIENT_SECRET', 'PUBLIC_BASE_URL', 'SESSION_SECRET'];
  if (!dashboardNames.some((name) => environment[name]?.trim())) return undefined;
  const configured = names.filter((name) => environment[name]?.trim());
  if (configured.length !== names.length) {
    throw new Error(`Dashboard configuration requires ${names.join(', ')}.`);
  }

  const clientId = requireConfiguredValue(environment, 'DISCORD_CLIENT_ID');
  const clientSecret = requireConfiguredValue(environment, 'DISCORD_CLIENT_SECRET');
  const ownerUserId = requireConfiguredValue(environment, 'DISCORD_OWNER_USER_ID');
  const publicBaseUrl = new URL(requireConfiguredValue(environment, 'PUBLIC_BASE_URL'));
  if (publicBaseUrl.protocol !== 'https:' || publicBaseUrl.username
    || publicBaseUrl.password || publicBaseUrl.search || publicBaseUrl.hash
    || publicBaseUrl.pathname !== '/') {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  const sessionSecret = requireConfiguredValue(environment, 'SESSION_SECRET');
  if (new TextEncoder().encode(sessionSecret).length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes.');
  }
  const port = Number(environment.HTTP_PORT?.trim() || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HTTP_PORT must be an integer from 1 through 65535.');
  }

  return Object.freeze({
    clientId,
    clientSecret,
    host: environment.HTTP_HOST?.trim() || '127.0.0.1',
    ownerUserId,
    port,
    publicBaseUrl,
    sessionSecret,
  });
}

/** @param {NodeJS.ProcessEnv} environment @param {string} name */
function requireConfiguredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}