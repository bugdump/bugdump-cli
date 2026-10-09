import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CliError } from './cli-error';

const JS_FILE = /\.(?:m|c)?js$/;
const SOURCE_MAPPING_URL = /\/\/[#@][ \t]*sourceMappingURL=[ \t]*(\S+)[ \t]*$/gm;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function isJsFile(path: string): boolean {
  return JS_FILE.test(path);
}

export function isSourceMapFile(path: string): boolean {
  return path.endsWith('.map');
}

export async function assertDirectory(dir: string): Promise<void> {
  const stats = await stat(dir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new CliError(`${dir} is not a directory`);
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export function toDisplayPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

export async function findSourceMap(jsPath: string, code: string): Promise<string | null> {
  const url = lastSourceMappingUrl(code);
  const fromComment = url === null ? null : resolveMapUrl(jsPath, url);
  if (fromComment !== null && (await isFile(fromComment))) {
    return fromComment;
  }
  const sibling = `${jsPath}.map`;
  return (await isFile(sibling)) ? sibling : null;
}

function lastSourceMappingUrl(code: string): string | null {
  let url: string | null = null;
  for (const match of code.matchAll(SOURCE_MAPPING_URL)) {
    url = match[1] ?? null;
  }
  return url;
}

function resolveMapUrl(jsPath: string, url: string): string | null {
  if (URL_SCHEME.test(url) || url.startsWith('/')) {
    return null;
  }
  try {
    return resolve(dirname(jsPath), decodeURIComponent(url.replace(/[?#].*$/, '')));
  } catch {
    return null;
  }
}

async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isFile() ?? false;
}
