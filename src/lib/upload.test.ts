import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDebugId } from './debug-id';
import { uploadSourceMaps, type UploadOptions } from './upload';

const ENDPOINT = 'https://api.test';
const STORAGE_URL = 'https://storage.test/bucket';

type FakeApiOptions = {
  skipped?: string[];
  missing?: string[];
  failedStorage?: string[];
  onComplete?: () => void;
};

type StoredForm = { keys: string[]; debugId: string; file: string };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugdump-cli-upload-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function debugIdFor(name: string): string {
  return computeDebugId(Buffer.from(name));
}

async function write(relativePath: string, content: string): Promise<void> {
  const path = join(dir, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeMap(relativePath: string, debugId?: string): Promise<string> {
  const content = JSON.stringify({ version: 3, sources: ['src/app.ts'], names: [], mappings: ';AAAA', debugId });
  await write(relativePath, content);
  return content;
}

function options(overrides: Partial<UploadOptions> = {}): UploadOptions {
  return { dir, token: 'bdr_test', endpoint: ENDPOINT, deleteAfter: false, ...overrides };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeApi(fake: FakeApiOptions = {}) {
  const log: string[] = [];
  const presignBodies: Array<{ release?: string; files: Array<{ debugId: string; path: string; size: number }> }> = [];
  const completeBodies: Array<{ ids: string[] }> = [];
  const storedForms: StoredForm[] = [];
  const headers: Array<Record<string, string>> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${ENDPOINT}/api/sourcemaps/v1/uploads`) {
      const body = JSON.parse(String(init?.body)) as (typeof presignBodies)[number];
      presignBodies.push(body);
      headers.push(init?.headers as Record<string, string>);
      log.push(`presign:${body.files.length}`);
      const skipped = body.files.filter((file) => fake.skipped?.includes(file.debugId)).map((file) => file.debugId);
      return json(200, {
        uploads: body.files
          .filter((file) => !skipped.includes(file.debugId))
          .map((file) => ({
            id: `upload-${file.debugId}`,
            debugId: file.debugId,
            post: { url: STORAGE_URL, fields: { key: `sourcemaps/project/${file.debugId}.map`, policy: 'p' } },
          })),
        skipped,
      });
    }
    if (url === `${ENDPOINT}/api/sourcemaps/v1/uploads/complete`) {
      const body = JSON.parse(String(init?.body)) as { ids: string[] };
      completeBodies.push(body);
      headers.push(init?.headers as Record<string, string>);
      log.push(`complete:${body.ids.length}`);
      fake.onComplete?.();
      const missing = body.ids.filter((id) => fake.missing?.includes(id.replace('upload-', '')));
      return json(200, { completed: body.ids.filter((id) => !missing.includes(id)), missing });
    }
    if (url === STORAGE_URL) {
      const form = init?.body as FormData;
      const key = String(form.get('key'));
      const debugId = key.replace('sourcemaps/project/', '').replace('.map', '');
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      log.push(`upload:${debugId}`);
      if (fake.failedStorage?.includes(debugId)) {
        return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
      }
      const file = form.get('file') as Blob;
      storedForms.push({ keys: [...form.keys()], debugId, file: await file.text() });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    log,
    presignBodies,
    completeBodies,
    storedForms,
    headers,
    maxInFlight: () => maxInFlight,
  };
}

describe('uploadSourceMaps', () => {
  it('presigns each map with its debug ID, paired JS path and size, uploads it and completes the batch', async () => {
    const appId = debugIdFor('app');
    const vendorId = debugIdFor('vendor');
    await write('assets/app.js', 'a();\n');
    const appMap = await writeMap('assets/app.js.map', appId);
    await write('assets/vendor.js', 'v();\n//# sourceMappingURL=../maps/vendor.js.map\n');
    const vendorMap = await writeMap('maps/vendor.js.map', vendorId);
    const api = fakeApi();

    expect(await uploadSourceMaps(options({ release: 'abc123' }))).toBe(0);

    expect(api.presignBodies).toEqual([
      {
        release: 'abc123',
        files: [
          { debugId: appId, path: 'assets/app.js', size: Buffer.byteLength(appMap) },
          { debugId: vendorId, path: 'assets/vendor.js', size: Buffer.byteLength(vendorMap) },
        ],
      },
    ]);
    expect(api.headers.every((header) => header.Authorization === 'Bearer bdr_test')).toBe(true);
    expect(api.storedForms).toEqual(
      expect.arrayContaining([
        { keys: ['key', 'policy', 'file'], debugId: appId, file: appMap },
        { keys: ['key', 'policy', 'file'], debugId: vendorId, file: vendorMap },
      ]),
    );
    expect(api.completeBodies).toEqual([{ ids: [`upload-${appId}`, `upload-${vendorId}`] }]);
    expect(api.log.at(-1)).toBe('complete:2');
    expect(console.log).toHaveBeenCalledWith('Uploaded 2 source maps for release abc123, 0 already uploaded.');
  });

  it('sends no release when none is given', async () => {
    await writeMap('app.js.map', debugIdFor('app'));
    const api = fakeApi();

    await uploadSourceMaps(options());

    expect(api.presignBodies[0]).not.toHaveProperty('release');
    expect(api.presignBodies[0]?.files[0]?.path).toBe('app.js');
  });

  it('skips a map without a debug ID with a warning to run inject first', async () => {
    await writeMap('app.js.map', debugIdFor('app'));
    await writeMap('old.js.map');
    const api = fakeApi();

    expect(await uploadSourceMaps(options())).toBe(0);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('old.js.map has no debug ID'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('bugdump sourcemaps inject'));
    expect(api.presignBodies[0]?.files.map((file) => file.path)).toEqual(['app.js']);
  });

  it('fails without a request when no map has a debug ID', async () => {
    await writeMap('app.js.map');
    await write('broken.js.map', '{ not json');
    const api = fakeApi();

    await expect(uploadSourceMaps(options())).rejects.toThrow('Run "bugdump sourcemaps inject');

    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it('requests presigns in batches of 100, one batch at a time, and uploads 4 files at a time', async () => {
    for (let index = 0; index < 150; index++) {
      await writeMap(`maps/chunk-${String(index).padStart(3, '0')}.js.map`, debugIdFor(`chunk-${index}`));
    }
    const api = fakeApi();

    expect(await uploadSourceMaps(options())).toBe(0);

    const batchLog = api.log.filter((entry) => !entry.startsWith('upload:'));
    expect(batchLog).toEqual(['presign:100', 'complete:100', 'presign:50', 'complete:50']);
    const secondPresign = api.log.indexOf('presign:50');
    expect(api.log.slice(0, secondPresign).filter((entry) => entry.startsWith('upload:'))).toHaveLength(100);
    expect(api.log.indexOf('complete:100')).toBe(secondPresign - 1);
    expect(api.maxInFlight()).toBe(4);
    expect(api.storedForms).toHaveLength(150);
  });

  it('does not upload the debug IDs the server returns as skipped', async () => {
    const [first, second, third] = ['a', 'b', 'c'].map(debugIdFor);
    await writeMap('a.js.map', first);
    await writeMap('b.js.map', second);
    await writeMap('c.js.map', third);
    const api = fakeApi({ skipped: [second ?? ''] });

    expect(await uploadSourceMaps(options())).toBe(0);

    expect(api.storedForms.map((form) => form.debugId).sort()).toEqual([first, third].sort());
    expect(api.completeBodies).toEqual([{ ids: [`upload-${first}`, `upload-${third}`] }]);
    expect(console.log).toHaveBeenCalledWith('Uploaded 2 source maps, 1 already uploaded.');
  });

  it('sends a debug ID shared by two maps once', async () => {
    const id = debugIdFor('same');
    await writeMap('a/app.js.map', id);
    await writeMap('b/app.js.map', id);
    const api = fakeApi();

    expect(await uploadSourceMaps(options({ deleteAfter: true }))).toBe(0);

    expect(api.presignBodies[0]?.files).toHaveLength(1);
    expect(existsSync(join(dir, 'a/app.js.map'))).toBe(false);
    expect(existsSync(join(dir, 'b/app.js.map'))).toBe(false);
  });

  it('deletes the maps, skipped ones included, only after complete succeeds', async () => {
    const [first, second] = ['a', 'b'].map(debugIdFor);
    await write('a.js', 'a();\n');
    await writeMap('a.js.map', first);
    await writeMap('b.js.map', second);
    await writeMap('no-id.js.map');
    const presentAtComplete: boolean[] = [];
    fakeApi({
      skipped: [second ?? ''],
      onComplete: () => presentAtComplete.push(existsSync(join(dir, 'a.js.map')), existsSync(join(dir, 'b.js.map'))),
    });

    expect(await uploadSourceMaps(options({ deleteAfter: true }))).toBe(0);

    expect(presentAtComplete).toEqual([true, true]);
    expect(existsSync(join(dir, 'a.js.map'))).toBe(false);
    expect(existsSync(join(dir, 'b.js.map'))).toBe(false);
    expect(existsSync(join(dir, 'a.js'))).toBe(true);
    expect(existsSync(join(dir, 'no-id.js.map'))).toBe(true);
    expect(console.log).toHaveBeenCalledWith('Deleted 2 source maps.');
  });

  it('keeps the maps without --delete-after', async () => {
    await writeMap('a.js.map', debugIdFor('a'));
    fakeApi();

    expect(await uploadSourceMaps(options())).toBe(0);

    expect(existsSync(join(dir, 'a.js.map'))).toBe(true);
  });

  it('reports an ID returned as missing, exits non-zero and deletes nothing', async () => {
    const [first, second] = ['a', 'b'].map(debugIdFor);
    await write('assets/a.js', 'a();\n');
    await writeMap('assets/a.js.map', first);
    await writeMap('assets/b.js.map', second);
    fakeApi({ missing: [first ?? ''] });

    expect(await uploadSourceMaps(options({ deleteAfter: true }))).toBe(1);

    expect(console.error).toHaveBeenCalledWith('error: assets/a.js: the upload did not reach storage');
    expect(existsSync(join(dir, 'assets/a.js.map'))).toBe(true);
    expect(existsSync(join(dir, 'assets/b.js.map'))).toBe(true);
  });

  it('reports a failed storage upload, completes the others and exits non-zero', async () => {
    const [first, second] = ['a', 'b'].map(debugIdFor);
    await writeMap('a.js.map', first);
    await writeMap('b.js.map', second);
    const api = fakeApi({ failedStorage: [first ?? ''] });

    expect(await uploadSourceMaps(options({ deleteAfter: true }))).toBe(1);

    expect(console.error).toHaveBeenCalledWith('error: a.js: upload failed (403 AccessDenied)');
    expect(api.completeBodies).toEqual([{ ids: [`upload-${second}`] }]);
    expect(existsSync(join(dir, 'b.js.map'))).toBe(true);
  });

  it('fails with the error code the API answers with', async () => {
    await writeMap('a.js.map', debugIdFor('a'));
    const fetchMock = vi.fn(async () => json(401, { error: 'RELEASE_TOKEN_INVALID' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadSourceMaps(options())).rejects.toThrow(
      `${ENDPOINT}/api/sourcemaps/v1/uploads answered 401 RELEASE_TOKEN_INVALID`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips a map over 20 MB before presigning it, uploads the rest and exits non-zero', async () => {
    const bigId = debugIdFor('big');
    await writeMap('app.js.map', debugIdFor('app'));
    const big = JSON.stringify({ version: 3, sources: [], names: [], mappings: '', debugId: bigId, x: '' });
    await write('assets/big.js.map', big.replace('"x":""', `"x":"${'x'.repeat(20 * 1024 * 1024)}"`));
    const api = fakeApi();

    expect(await uploadSourceMaps(options({ deleteAfter: true }))).toBe(1);

    expect(api.presignBodies[0]?.files.map((file) => file.path)).toEqual(['app.js']);
    expect(api.storedForms).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      'warning: assets/big.js.map is 20.0 MB, over the 20 MB limit, and was skipped.',
    );
    expect(console.error).toHaveBeenCalledWith('error: 1 source map was over the 20 MB limit');
    expect(existsSync(join(dir, 'app.js.map'))).toBe(true);
  });

  describe('when the API answers 429 or 5xx', () => {
    let delays: number[];

    beforeEach(() => {
      delays = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        queueMicrotask(callback);
        return 0;
      }) as unknown as typeof setTimeout);
    });

    // Then a presign that finds the map already uploaded.
    function presignAnswers(...answers: Response[]) {
      const presign = vi.fn(async () => answers.shift() ?? json(200, { uploads: [], skipped: [debugIdFor('a')] }));
      vi.stubGlobal('fetch', presign);
      return presign;
    }

    it('retries after 1 and 2 seconds and goes on once it succeeds', async () => {
      await writeMap('a.js.map', debugIdFor('a'));
      const presign = presignAnswers(json(503, { error: 'UNAVAILABLE' }), json(429, { error: 'RATE_LIMITED' }));

      expect(await uploadSourceMaps(options())).toBe(0);

      expect(presign).toHaveBeenCalledTimes(3);
      expect(delays).toEqual([1_000, 2_000]);
    });

    it('gives up after three retries with the last answer', async () => {
      await writeMap('a.js.map', debugIdFor('a'));
      const presign = vi.fn(async () => json(502, { error: 'BAD_GATEWAY' }));
      vi.stubGlobal('fetch', presign);

      await expect(uploadSourceMaps(options())).rejects.toThrow(
        `${ENDPOINT}/api/sourcemaps/v1/uploads answered 502 BAD_GATEWAY`,
      );
      expect(presign).toHaveBeenCalledTimes(4);
      expect(delays).toEqual([1_000, 2_000, 4_000]);
    });

    it('waits as long as a numeric Retry-After says, up to a minute', async () => {
      await writeMap('a.js.map', debugIdFor('a'));
      const rateLimited = (retryAfter: string) =>
        new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } });
      presignAnswers(rateLimited('7'), rateLimited('600'), rateLimited('Wed, 21 Oct 2026 07:28:00 GMT'));

      expect(await uploadSourceMaps(options())).toBe(0);

      expect(delays).toEqual([7_000, 60_000, 4_000]);
    });
  });

  it('fails when the API cannot be reached', async () => {
    await writeMap('a.js.map', debugIdFor('a'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    await expect(uploadSourceMaps(options())).rejects.toThrow(`could not reach ${ENDPOINT}`);
  });
});
