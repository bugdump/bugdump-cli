import { readFile, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { CliError, describeError } from './cli-error';
import { DEBUG_ID_PATTERN } from './debug-id';
import { assertDirectory, findSourceMap, isJsFile, isSourceMapFile, listFiles, toDisplayPath } from './files';
import { isRecord } from './json';

const UPLOADS_PATH = '/api/sourcemaps/v1/uploads';
const COMPLETE_PATH = '/api/sourcemaps/v1/uploads/complete';
const PRESIGN_BATCH_SIZE = 100;
const UPLOAD_CONCURRENCY = 4;
const MAX_PATH_LENGTH = 1024;
// The API's SOURCE_MAP_MAX_FILE_SIZE: a larger map is refused, so it is not presigned at all.
const MAX_MAP_SIZE = 20 * 1024 * 1024;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const RETRY_AFTER_MAX_SECONDS = 60;

export type UploadOptions = {
  dir: string;
  token: string;
  endpoint: string;
  release?: string;
  deleteAfter: boolean;
};

type MapEntry = { debugId: string; path: string; size: number; mapPath: string };
type PresignedPost = { url: string; fields: Record<string, string> };
type PresignedUpload = { id: string; debugId: string; post: PresignedPost };
type PendingUpload = { upload: PresignedUpload; entry: MapEntry; sent: boolean };
type BatchResult = { stored: string[]; uploaded: number; skipped: number; failed: number };

export async function uploadSourceMaps(options: UploadOptions): Promise<number> {
  const root = resolve(options.dir);
  await assertDirectory(root);
  const files = await listFiles(root);
  const entries = await readMapEntries(root, files, await pairMapsToJs(files));
  if (entries.length === 0) {
    throw new CliError(
      `no source map in ${options.dir} has a debug ID. Run "bugdump sourcemaps inject ${options.dir}" first`,
    );
  }

  const tooLarge = entries.filter((entry) => entry.size > MAX_MAP_SIZE);
  for (const entry of tooLarge) {
    console.warn(
      `warning: ${toDisplayPath(root, entry.mapPath)} is ${(entry.size / 1024 / 1024).toFixed(1)} MB, over the 20 MB limit, and was skipped.`,
    );
  }

  const unique = uniqueByDebugId(entries.filter((entry) => entry.size <= MAX_MAP_SIZE));
  const stored = new Set<string>();
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (let start = 0; start < unique.length; start += PRESIGN_BATCH_SIZE) {
    const result = await uploadBatch(options, unique.slice(start, start + PRESIGN_BATCH_SIZE));
    result.stored.forEach((debugId) => stored.add(debugId));
    uploaded += result.uploaded;
    skipped += result.skipped;
    failed += result.failed;
  }

  const release = options.release === undefined ? '' : ` for release ${options.release}`;
  console.log(`Uploaded ${uploaded} source ${uploaded === 1 ? 'map' : 'maps'}${release}, ${skipped} already uploaded.`);
  if (tooLarge.length > 0) {
    console.error(
      `error: ${tooLarge.length} source ${tooLarge.length === 1 ? 'map was' : 'maps were'} over the 20 MB limit`,
    );
  }
  if (failed > 0) {
    console.error(`error: ${failed} source ${failed === 1 ? 'map was' : 'maps were'} not uploaded`);
  }
  if (tooLarge.length > 0 || failed > 0) {
    return 1;
  }

  if (options.deleteAfter) {
    const toDelete = entries.filter((entry) => stored.has(entry.debugId));
    for (const entry of toDelete) {
      await rm(entry.mapPath);
    }
    console.log(`Deleted ${toDelete.length} source ${toDelete.length === 1 ? 'map' : 'maps'}.`);
  }
  return 0;
}

async function pairMapsToJs(files: string[]): Promise<Map<string, string>> {
  const jsByMap = new Map<string, string>();
  for (const jsPath of files.filter(isJsFile)) {
    const mapPath = await findSourceMap(jsPath, await readFile(jsPath, 'utf8'));
    if (mapPath !== null && !jsByMap.has(mapPath)) {
      jsByMap.set(mapPath, jsPath);
    }
  }
  return jsByMap;
}

async function readMapEntries(root: string, files: string[], jsByMap: Map<string, string>): Promise<MapEntry[]> {
  const entries: MapEntry[] = [];
  for (const mapPath of files.filter(isSourceMapFile)) {
    const bytes = await readFile(mapPath);
    const debugId = readMapDebugId(bytes);
    if (debugId === null) {
      console.warn(
        `warning: ${toDisplayPath(root, mapPath)} has no debug ID and was skipped. Run "bugdump sourcemaps inject" before uploading.`,
      );
      continue;
    }
    const jsPath = jsByMap.get(mapPath) ?? mapPath.slice(0, -'.map'.length);
    entries.push({
      debugId,
      path: toDisplayPath(root, jsPath).slice(0, MAX_PATH_LENGTH),
      size: bytes.length,
      mapPath,
    });
  }
  return entries;
}

function readMapDebugId(bytes: Buffer): string | null {
  try {
    const map: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(map) && typeof map.debugId === 'string' && DEBUG_ID_PATTERN.test(map.debugId)
      ? map.debugId.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function uniqueByDebugId(entries: MapEntry[]): MapEntry[] {
  const seen = new Set<string>();
  const unique: MapEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.debugId)) {
      seen.add(entry.debugId);
      unique.push(entry);
    }
  }
  return unique;
}

async function uploadBatch(options: UploadOptions, batch: MapEntry[]): Promise<BatchResult> {
  const presign = await postJson(options, UPLOADS_PATH, {
    ...(options.release === undefined ? {} : { release: options.release }),
    files: batch.map(({ debugId, path, size }) => ({ debugId, path, size })),
  });
  if (!isRecord(presign) || !isPresignedUploadArray(presign.uploads) || !isStringArray(presign.skipped)) {
    throw new CliError(`unexpected response from ${UPLOADS_PATH}`);
  }
  const uploads = presign.uploads;

  const skippedIds = new Set(presign.skipped);
  const uploadByDebugId = new Map(uploads.map((upload) => [upload.debugId, upload]));
  const pending: PendingUpload[] = [];
  const stored: string[] = [];
  let failed = 0;
  for (const entry of batch) {
    const upload = uploadByDebugId.get(entry.debugId);
    if (skippedIds.has(entry.debugId)) {
      stored.push(entry.debugId);
    } else if (upload !== undefined) {
      pending.push({ upload, entry, sent: false });
    } else {
      console.error(`error: ${entry.path}: the server did not accept its source map`);
      failed += 1;
    }
  }
  const skipped = stored.length;

  await forEachConcurrently(pending, UPLOAD_CONCURRENCY, async (item) => {
    const error = await postToStorage(item.upload.post, item.entry.mapPath);
    if (error === null) {
      item.sent = true;
    } else {
      console.error(`error: ${item.entry.path}: upload failed (${error})`);
      failed += 1;
    }
  });

  const sent = pending.filter((item) => item.sent);
  if (sent.length > 0) {
    const complete = await postJson(options, COMPLETE_PATH, { ids: sent.map((item) => item.upload.id) });
    if (!isRecord(complete) || !isStringArray(complete.completed) || !isStringArray(complete.missing)) {
      throw new CliError(`unexpected response from ${COMPLETE_PATH}`);
    }
    const completed = new Set(complete.completed);
    for (const item of sent) {
      if (completed.has(item.upload.id)) {
        stored.push(item.entry.debugId);
      } else {
        console.error(`error: ${item.entry.path}: the upload did not reach storage`);
        failed += 1;
      }
    }
  }

  return { stored, uploaded: stored.length - skipped, skipped, failed };
}

/** Retries a 429 or a 5xx three times, after 1, 2 and 4 seconds or the numeric `Retry-After` up to a minute. */
async function postJson(options: UploadOptions, path: string, body: unknown): Promise<unknown> {
  const url = `${options.endpoint}${path}`;
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(`could not reach ${url}: ${describeError(error)}`);
    }
    const backoffMs = RETRY_DELAYS_MS[attempt];
    if ((response.status !== 429 && response.status < 500) || backoffMs === undefined) {
      break;
    }
    await response.body?.cancel();
    const delayMs = retryAfterMs(response) ?? backoffMs;
    console.warn(`warning: ${url} answered ${response.status}, retrying in ${delayMs / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === 'string' ? payload.error : response.statusText;
    throw new CliError(`${url} answered ${response.status} ${code}`);
  }
  return payload;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After')?.trim();
  return header !== undefined && /^\d+$/.test(header) ? Math.min(Number(header), RETRY_AFTER_MAX_SECONDS) * 1000 : null;
}

async function postToStorage(post: PresignedPost, mapPath: string): Promise<string | null> {
  try {
    const form = new FormData();
    for (const [name, value] of Object.entries(post.fields)) {
      form.append(name, value);
    }
    form.append('file', new Blob([await readFile(mapPath)], { type: 'application/json' }), basename(mapPath));
    const response = await fetch(post.url, { method: 'POST', body: form });
    if (response.ok) {
      return null;
    }
    const code = /<Code>([^<]+)<\/Code>/.exec(await response.text())?.[1];
    return `${response.status} ${code ?? response.statusText}`;
  } catch (error) {
    return describeError(error);
  }
}

async function forEachConcurrently<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = items.values();
  const worker = async () => {
    for (const item of queue) {
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPresignedUploadArray(value: unknown): value is PresignedUpload[] {
  return Array.isArray(value) && value.every(isPresignedUpload);
}

function isPresignedUpload(value: unknown): value is PresignedUpload {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.debugId === 'string' &&
    isRecord(value.post) &&
    typeof value.post.url === 'string' &&
    isRecord(value.post.fields) &&
    Object.values(value.post.fields).every((field) => typeof field === 'string')
  );
}
