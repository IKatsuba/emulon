import { connect } from './connect.ts';
import { start } from './start.ts';
import { type Configuration, loadConfig, validateConfig } from './load.ts';

/** A configuration descriptor; loading never starts plugin instances. */
export class Emulon<Config extends Configuration> {
  static start = start;
  static connect = connect;

  readonly services: Config['services'];

  private constructor(config: Config) {
    this.services = config.services;
  }

  static load<const Config extends Configuration>(
    config: Config,
  ): Promise<Emulon<Config>>;
  static load(directory?: string): Promise<Emulon<Configuration>>;
  static async load(
    input?: Configuration | string,
  ): Promise<Emulon<Configuration>> {
    const config = typeof input === 'object' && input !== null
      ? validateConfig(input)
      : await loadConfig(input as string | undefined);

    return new Emulon(config);
  }
}
