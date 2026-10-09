import { CliError, describeError } from './cli-error';
import { injectCommand } from './inject';
import { uploadSourceMaps } from './upload';

export const DEFAULT_ENDPOINT = 'https://api.bugdump.com';

const USAGE = `Usage:
  bugdump sourcemaps inject <dir>
  bugdump sourcemaps upload <dir> [--release <name>] [--delete-after] [--endpoint <url>]

inject   Stamps a debug ID into every built JS file under <dir> that has a source map, and into its map.
upload   Uploads the source maps under <dir> to Bugdump. Reads the release token from BUGDUMP_RELEASE_TOKEN.

Options for upload:
  --release <name>   Tag the maps with a release, such as a git commit
  --delete-after     Delete the uploaded maps from <dir>, so they are never deployed
  --endpoint <url>   Bugdump API URL (default: ${DEFAULT_ENDPOINT})`;

class UsageError extends CliError {}

type ParsedArgs = { positionals: string[]; values: Map<string, string>; flags: Set<string> };

export async function run(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  try {
    return await dispatch(argv, env);
  } catch (error) {
    console.error(`error: ${describeError(error)}`);
    if (error instanceof UsageError) {
      console.error(`\n${USAGE}`);
    }
    return 1;
  }
}

async function dispatch(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group !== 'sourcemaps') {
    throw new UsageError(`unknown command "${group}"`);
  }
  switch (command) {
    case 'inject': {
      const args = parseArgs(rest, [], []);
      await injectCommand(singleDirectory(args));
      return 0;
    }
    case 'upload': {
      const args = parseArgs(rest, ['release', 'endpoint'], ['delete-after']);
      const token = env.BUGDUMP_RELEASE_TOKEN?.trim();
      if (!token) {
        throw new CliError('set BUGDUMP_RELEASE_TOKEN to a release token from the Source maps page of your project');
      }
      return uploadSourceMaps({
        dir: singleDirectory(args),
        token,
        endpoint: parseEndpoint(args.values.get('endpoint') ?? DEFAULT_ENDPOINT),
        release: args.values.get('release'),
        deleteAfter: args.flags.has('delete-after'),
      });
    }
    default:
      throw new UsageError(command === undefined ? 'missing command' : `unknown command "sourcemaps ${command}"`);
  }
}

function parseArgs(args: string[], valueOptions: string[], flagOptions: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), flags: new Set() };
  const queue = [...args];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg);
      continue;
    }
    const [name = '', inlineValue] = arg.slice(2).split(/=(.*)/s);
    if (flagOptions.includes(name) && inlineValue === undefined) {
      parsed.flags.add(name);
    } else if (valueOptions.includes(name)) {
      const value = inlineValue ?? queue.shift();
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      parsed.values.set(name, value);
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  return parsed;
}

function singleDirectory(args: ParsedArgs): string {
  const [dir, ...extra] = args.positionals;
  if (dir === undefined || extra.length > 0) {
    throw new UsageError('expected exactly one directory');
  }
  return dir;
}

function parseEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`--endpoint ${value} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError(`--endpoint ${value} must be an http or https URL`);
  }
  return value.replace(/\/+$/, '');
}
