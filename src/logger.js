import pino from 'pino';

export const logger = pino({
  name: 'renobot',
  level: process.env.LOG_LEVEL?.trim() || 'info',
  redact: {
    paths: [
      'apiKey',
      '*.apiKey',
      'authorization',
      '*.authorization',
      'clientSecret',
      '*.clientSecret',
      'client_secret',
      '*.client_secret',
      'sessionSecret',
      '*.sessionSecret',
      'token',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});