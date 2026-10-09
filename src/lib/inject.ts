import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, describeError } from './cli-error';
import { computeDebugId } from './debug-id';
import { assertDirectory, findSourceMap, isJsFile, listFiles, toDisplayPath } from './files';
import { isRecord } from './json';

const DEBUG_ID_COMMENT = /(?:^|\n)\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
const STRICT_PROLOGUE = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'])use strict\1(?=[ \t]*(?:[;\r\n]|$))/;

export type InjectSummary = { injected: number; alreadyInjected: number; skipped: number };

type InjectOutcome = keyof InjectSummary;

export function buildSnippet(debugId: string): string {
  return `;!function(){try{var g=typeof globalThis<"u"?globalThis:typeof self<"u"?self:{},s=new g.Error().stack;s&&((g._bugdumpDebugIds=g._bugdumpDebugIds||{})[s]="${debugId}")}catch(e){}}();`;
}

export function readInjectedDebugId(code: string): string | null {
  return DEBUG_ID_COMMENT.exec(code)?.[1] ?? null;
}

export function injectCode(code: string, debugId: string): { code: string; hasShebang: boolean } {
  const [shebang, body] = splitShebang(code);
  const quote = STRICT_PROLOGUE.exec(body)?.[1];
  const directive = quote ? `${quote}use strict${quote};` : '';
  const injected = `${shebang}${directive}${buildSnippet(debugId)}\n${body}`;
  const separator = injected.endsWith('\n') ? '' : '\n';
  return { code: `${injected}${separator}//# debugId=${debugId}\n`, hasShebang: shebang !== '' };
}

export function shiftSourceMap(map: Record<string, unknown>, hasShebang: boolean): boolean {
  if (Array.isArray(map.sections)) {
    return map.sections.every((section: unknown) => shiftSection(section, hasShebang));
  }
  if (typeof map.mappings !== 'string') {
    return false;
  }
  map.mappings = hasShebang ? insertLineAfterFirst(map.mappings) : `;${map.mappings}`;
  return true;
}

export async function injectDirectory(dir: string): Promise<InjectSummary> {
  const root = resolve(dir);
  await assertDirectory(root);
  const summary: InjectSummary = { injected: 0, alreadyInjected: 0, skipped: 0 };
  for (const file of await listFiles(root)) {
    if (isJsFile(file)) {
      summary[await injectFile(root, file)] += 1;
    }
  }
  return summary;
}

export async function injectCommand(dir: string): Promise<void> {
  const { injected, alreadyInjected, skipped } = await injectDirectory(dir);
  console.log(
    `Injected ${injected} ${injected === 1 ? 'file' : 'files'}, ${alreadyInjected} already injected, ${skipped} skipped (no source map).`,
  );
}

async function injectFile(root: string, jsPath: string): Promise<InjectOutcome> {
  const bytes = await readFile(jsPath);
  const code = bytes.toString('utf8');
  const mapPath = await findSourceMap(jsPath, code);
  if (mapPath === null) {
    return 'skipped';
  }
  const map = await readSourceMap(root, mapPath);
  const existingId = readInjectedDebugId(code);
  if (existingId !== null) {
    if (typeof map.debugId !== 'string') {
      map.debugId = existingId;
      await writeFile(mapPath, JSON.stringify(map));
    }
    return 'alreadyInjected';
  }
  const debugId = computeDebugId(bytes);
  const result = injectCode(code, debugId);
  // A map that already carries this ID was shifted by a run that stopped before it wrote the JS file.
  if (map.debugId !== debugId) {
    if (!shiftSourceMap(map, result.hasShebang)) {
      throw new CliError(`${toDisplayPath(root, mapPath)} is not a valid source map`);
    }
    map.debugId = debugId;
    await writeFile(mapPath, JSON.stringify(map));
  }
  await writeFile(jsPath, result.code);
  return 'injected';
}

async function readSourceMap(root: string, mapPath: string): Promise<Record<string, unknown>> {
  let map: unknown;
  try {
    map = JSON.parse(await readFile(mapPath, 'utf8'));
  } catch (error) {
    throw new CliError(`${toDisplayPath(root, mapPath)} is not valid JSON: ${describeError(error)}`);
  }
  if (!isRecord(map)) {
    throw new CliError(`${toDisplayPath(root, mapPath)} is not a valid source map`);
  }
  return map;
}

function splitShebang(code: string): [string, string] {
  if (!code.startsWith('#!')) {
    return ['', code];
  }
  const newline = code.indexOf('\n');
  return newline === -1 ? [`${code}\n`, ''] : [code.slice(0, newline + 1), code.slice(newline + 1)];
}

function insertLineAfterFirst(mappings: string): string {
  const firstLineEnd = mappings.indexOf(';');
  return firstLineEnd === -1
    ? `${mappings};`
    : `${mappings.slice(0, firstLineEnd + 1)};${mappings.slice(firstLineEnd + 1)}`;
}

function shiftSection(section: unknown, hasShebang: boolean): boolean {
  if (!isRecord(section) || !isRecord(section.offset) || typeof section.offset.line !== 'number') {
    return false;
  }
  if (hasShebang && section.offset.line === 0) {
    return isRecord(section.map) && shiftSourceMap(section.map, true);
  }
  section.offset.line += 1;
  return true;
}
