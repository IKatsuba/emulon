import github from '@emulon/github';
import resend from '@emulon/resend';
import { runProjectCLI } from '../../src/cli/project.ts';

const result = await runProjectCLI(['up', '--json'], {
  services: { github: github(), mail: resend() },
}, Deno.args[0]);

if (result.stderr) {
  console.error(result.stderr);
}

Deno.exitCode = result.code;
