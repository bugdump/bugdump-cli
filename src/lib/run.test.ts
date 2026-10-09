import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDebugId } from './debug-id';
import { DEFAULT_ENDPOINT, run } from './run';

const TOKEN_ENV = { BUGDUMP_RELEASE_TOKEN: 'bdr_test' };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugdump-cli-run-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function stubFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/uploads')) {
      return new Response(JSON.stringify({ uploads: [], skipped: [computeDebugId(Buffer.from('a'))] }));
    }
    throw new Error(`unexpected request to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function writeInjectedMap(): Promise<void> {
  await writeFile(
    join(dir, 'a.js.map'),
    JSON.stringify({ version: 3, mappings: '', debugId: computeDebugId(Buffer.from('a')) }),
  );
}

describe('run', () => {
  it('prints the usage for --help and exits zero', async () => {
    expect(await run(['--help'], {})).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bugdump sourcemaps upload <dir>'));
  });

  it('prints the usage and exits non-zero without a command', async () => {
    expect(await run([], {})).toBe(1);
    expect(await run(['deploy'], {})).toBe(1);
    expect(await run(['sourcemaps', 'publish', dir], {})).toBe(1);
    expect(console.error).toHaveBeenCalledWith('error: unknown command "sourcemaps publish"');
  });

  it('runs inject on the one directory it is given', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    await writeFile(join(dir, 'a.js.map'), JSON.stringify({ version: 3, mappings: 'AAAA' }));

    expect(await run(['sourcemaps', 'inject', dir], {})).toBe(0);

    expect(console.log).toHaveBeenCalledWith('Injected 1 file, 0 already injected, 0 skipped (no source map).');
    expect(await run(['sourcemaps', 'inject', dir, dir], {})).toBe(1);
    expect(await run(['sourcemaps', 'inject', dir, '--release', 'x'], {})).toBe(1);
  });

  it('refuses to upload without BUGDUMP_RELEASE_TOKEN', async () => {
    await writeInjectedMap();
    const fetchMock = stubFetch();

    expect(await run(['sourcemaps', 'upload', dir], { BUGDUMP_RELEASE_TOKEN: ' ' })).toBe(1);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('BUGDUMP_RELEASE_TOKEN'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads to the default endpoint with the token from the environment', async () => {
    await writeInjectedMap();
    const fetchMock = stubFetch();

    expect(await run(['sourcemaps', 'upload', dir], TOKEN_ENV)).toBe(0);

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_ENDPOINT}/api/sourcemaps/v1/uploads`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer bdr_test' }) }),
    );
  });

  it('passes --release, --delete-after and --endpoint through', async () => {
    await writeInjectedMap();
    const fetchMock = stubFetch();

    const code = await run(
      ['sourcemaps', 'upload', dir, '--release', 'v1.2.3', '--delete-after', '--endpoint=http://localhost:3101/'],
      TOKEN_ENV,
    );

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3101/api/sourcemaps/v1/uploads');
    expect(JSON.parse(String(init.body))).toMatchObject({ release: 'v1.2.3' });
    expect(console.log).toHaveBeenCalledWith('Deleted 1 source map.');
  });

  it('exits non-zero on an unknown option, a missing value or a bad endpoint', async () => {
    stubFetch();

    expect(await run(['sourcemaps', 'upload', dir, '--force'], TOKEN_ENV)).toBe(1);
    expect(await run(['sourcemaps', 'upload', dir, '--release'], TOKEN_ENV)).toBe(1);
    expect(await run(['sourcemaps', 'upload', dir, '--endpoint', 'ftp://example.com'], TOKEN_ENV)).toBe(1);
    expect(console.error).toHaveBeenCalledWith('error: unknown option --force');
    expect(console.error).toHaveBeenCalledWith('error: --release needs a value');
  });

  it('exits non-zero when the directory has no map with a debug ID', async () => {
    const fetchMock = stubFetch();

    expect(await run(['sourcemaps', 'upload', dir], TOKEN_ENV)).toBe(1);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
