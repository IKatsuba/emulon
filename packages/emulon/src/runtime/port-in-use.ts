/** The requested port is held by another socket; never retried elsewhere. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use.`);

    this.name = 'PortInUseError';
  }
}
