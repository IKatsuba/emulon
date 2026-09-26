import { DomainError } from '../commands/domain-error.ts';
import { isRegistration, type Registration } from '../plugins/define.ts';
import { isRecord } from '../plugins/validation.ts';

/** Host-owned listener settings beside a plugin registration. */
export interface ServiceInstance<Service extends Registration = Registration> {
  readonly service: Service;
  /** Surface name to port; 0 or an omitted surface allocates dynamically. */
  readonly ports?: Readonly<Record<string, number>>;
}

export type ServiceEntry = Registration | ServiceInstance;

export interface Instance {
  readonly registration: Registration;
  readonly ports: ReadonlyMap<string, number>;
}

/**
 * A verdict the host itself wrote; it names only instance and surface keys
 * and ports. A DomainError thrown by project code, such as a getter, is not
 * one, so the loader keeps hiding its message.
 */
export class InstanceConfigError extends DomainError {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
  }
}

function invalid(message: string): never {
  throw new InstanceConfigError(message);
}

/** Unwraps one services value; the name only appears in safe verdicts. */
export function readInstance(name: string, value: unknown): Instance {
  if (isRegistration(value)) {
    return { registration: value, ports: new Map() };
  }

  if (!isRecord(value) || !('service' in value)) {
    throw new TypeError(
      'Each service must be created by a definePlugin factory.',
    );
  }

  if (!isRegistration(value.service)) {
    throw new TypeError(
      'Each service must be created by a definePlugin factory.',
    );
  }

  if (Object.keys(value).some((key) => key !== 'service' && key !== 'ports')) {
    invalid(
      `Service instance "${name}" accepts only the service and ports properties.`,
    );
  }

  if (value.ports === undefined) {
    return { registration: value.service, ports: new Map() };
  }

  if (!isRecord(value.ports)) {
    invalid(`Service instance "${name}" ports must be an object.`);
  }

  const ports = new Map<string, number>();

  for (const [surface, port] of Object.entries(value.ports)) {
    if (!surface) {
      invalid(`Service instance "${name}" has an empty surface name.`);
    }

    if (
      typeof port !== 'number' || !Number.isInteger(port) || port < 0 ||
      port > 65535
    ) {
      invalid(
        `Service instance "${name}" surface "${surface}" port must be an integer from 0 to 65535.`,
      );
    }

    ports.set(surface, port);
  }

  return { registration: value.service, ports };
}

/** Rejects one fixed port shared by two surfaces before anything starts. */
export function checkPortConflicts(
  instances: Iterable<readonly [string, Instance]>,
): void {
  const owners = new Map<number, string>();

  for (const [name, instance] of instances) {
    for (const [surface, port] of instance.ports) {
      if (port === 0) {
        continue;
      }

      const owner = `${name}.${surface}`;
      const previous = owners.get(port);

      if (previous) {
        invalid(
          `Port ${port} is configured for both "${previous}" and "${owner}".`,
        );
      }

      owners.set(port, owner);
    }
  }
}

export function readInstances(
  services: Record<string, unknown>,
): [string, Instance][] {
  const instances = Object.entries(services).map(([name, value]) =>
    [name, readInstance(name, value)] as [string, Instance]
  );

  checkPortConflicts(instances);

  return instances;
}

/** Configured surface names the plugin never listened to. */
export function unmatchedSurfaces(
  ports: ReadonlyMap<string, number>,
  listened: ReadonlySet<string>,
): string[] {
  return [...ports.keys()].filter((surface) => !listened.has(surface));
}
