import { isDomainError } from '../commands/domain-error.ts';
import type { Registration } from '../plugins/define.ts';
import { configExists, configURL } from '../runtime/project.ts';
import { defineConfig } from './config.ts';

export type Configuration = { services: Record<string, Registration> };

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);

    this.code = code;
    this.name = 'ConfigError';
  }
}

export function validateConfig(value: unknown): Configuration {
  try {
    return defineConfig(value as Configuration);
  } catch {
    // Project code and validation errors can contain credentials.
    throw new ConfigError('CONFIG_INVALID', 'Invalid Emulon configuration.');
  }
}

export async function loadConfig(directory?: string): Promise<Configuration> {
  const url = configURL(directory);

  try {
    if (!await configExists(url)) {
      throw new ConfigError(
        'CONFIG_NOT_FOUND',
        'emulon.config.ts was not found.',
      );
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError(
      'CONFIG_READ_FAILED',
      'Cannot access emulon.config.ts.',
    );
  }

  let value: unknown;

  try {
    value = (await import(url.href)).default;
  } catch (error) {
    // Only a plugin's own configuration verdict is safe to show; any other
    // exception from project code can carry credentials.
    if (isDomainError(error) && error.code === 'CONFIG_INVALID') {
      throw new ConfigError(error.code, error.message);
    }

    throw new ConfigError(
      'CONFIG_IMPORT_FAILED',
      'Cannot import emulon.config.ts.',
    );
  }

  return validateConfig(value);
}
