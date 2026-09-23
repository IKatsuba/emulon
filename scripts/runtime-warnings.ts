/** Ignore only the notice for the verifier's explicit Node 22 TypeScript flag. */
export function withoutTypeStrippingNotice(stderr: string): string {
  return stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm,
    '',
  );
}
