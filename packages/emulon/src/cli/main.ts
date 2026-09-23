import { cliArguments, finishCLI } from '../runtime/project.ts';
import { runProjectCLI } from './project.ts';

const result = await runProjectCLI(cliArguments());

if (result.stdout) {
  console.log(result.stdout);
}

if (result.stderr) {
  console.error(result.stderr);
}

finishCLI(result.code);
