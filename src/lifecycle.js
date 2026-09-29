/**
 * @typedef {Readonly<{
 *   client: Pick<import('discord.js').Client, 'destroy'>,
 *   logger: import('pino').Logger,
 *   webServer?: import('node:http').Server,
 *   database?: import('./database.js').PortalDatabase,
 *   setExitCode?: (exitCode: number) => void,
 * }>} ShutdownOptions
 */

/**
 * @param {ShutdownOptions} options
 * @returns {(reason: string, exitCode?: number) => Promise<void>}
 */
export function createShutdown(options) {
  const setExitCode = options.setExitCode ?? ((exitCode) => {
    process.exitCode = exitCode;
  });
  /** @type {Promise<void> | undefined} */
  let shutdownPromise;

  return (reason, exitCode = 0) => {
    shutdownPromise ??= (async () => {
      setExitCode(exitCode);
      options.logger.info({ reason }, 'Shutting down Renobot');

      try {
        if (options.webServer?.listening) {
          options.webServer.closeIdleConnections();
          await new Promise((resolve, reject) => options.webServer?.close((error) => {
            if (error) reject(error); else resolve(undefined);
          }));
        }
        await options.client.destroy();
        options.logger.info({ reason }, 'Renobot stopped');
      } catch (error) {
        setExitCode(1);
        options.logger.error({ err: error, reason }, 'Renobot shutdown failed');
      } finally {
        try {
          await options.database?.disconnect();
        } catch (error) {
          setExitCode(1);
          options.logger.error({ err: error, reason }, 'Renobot database shutdown failed');
        }
      }
    })();

    return shutdownPromise;
  };
}

/**
 * @param {Readonly<{
 *   logger: import('pino').Logger,
 *   shutDown: (reason: string, exitCode?: number) => Promise<void>,
 * }>} options
 */
export function installProcessHandlers(options) {
  process.once('SIGINT', () => void options.shutDown('SIGINT'));
  process.once('SIGTERM', () => void options.shutDown('SIGTERM'));
  process.once('uncaughtException', (error) => {
    options.logger.fatal({ err: error }, 'Uncaught exception');
    void options.shutDown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (error) => {
    options.logger.fatal({ err: error }, 'Unhandled promise rejection');
    void options.shutDown('unhandledRejection', 1);
  });
}