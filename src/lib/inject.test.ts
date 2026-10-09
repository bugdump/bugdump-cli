import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDebugId } from './debug-id';
import { buildSnippet, injectCommand, injectDirectory } from './inject';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugdump-cli-inject-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<void> {
  const path = join(dir, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function read(relativePath: string): Promise<string> {
  return readFile(join(dir, relativePath), 'utf8');
}

async function readMap(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(relativePath)) as Record<string, unknown>;
}

function sourceMap(mappings: string): string {
  return JSON.stringify({ version: 3, sources: ['src/app.ts'], names: [], mappings });
}

function idOf(code: string): string {
  return computeDebugId(Buffer.from(code));
}

async function readTree(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => read(path)));
}

function runInVm(code: string, filename: string): vm.Context {
  const context = vm.createContext({});
  vm.runInContext(code, context, { filename });
  return context;
}

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

function originalPosition(map: Record<string, unknown>, line: number, column: number) {
  const state = [0, 0, 0, 0, 0];
  const lines = String(map.mappings)
    .split(';')
    .map((group) => {
      state[0] = 0;
      return group
        .split(',')
        .filter(Boolean)
        .map((segment) => decodeVlq(segment).map((delta, index) => (state[index] = (state[index] ?? 0) + delta)));
    });
  const segment = (lines[line - 1] ?? []).filter(([generatedColumn = 0]) => generatedColumn <= column - 1).pop();
  if (segment === undefined || segment.length < 4) {
    return null;
  }
  const [, sourceIndex = 0, originalLine = 0, , nameIndex] = segment;
  const sources = map.sources as string[];
  const names = map.names as string[];
  return {
    source: sources[sourceIndex],
    line: originalLine + 1,
    name: nameIndex === undefined ? null : names[nameIndex],
  };
}

describe('buildSnippet', () => {
  it('is the runtime snippet that registers the ID under the stack captured in the file', () => {
    expect(buildSnippet('ID')).toBe(
      ';!function(){try{var g=typeof globalThis<"u"?globalThis:typeof self<"u"?self:{},s=new g.Error().stack;s&&((g._bugdumpDebugIds=g._bugdumpDebugIds||{})[s]="ID")}catch(e){}}();',
    );
  });
});

describe('injectDirectory', () => {
  it('writes the snippet as a new first line, the debug ID comment last and the ID into the map', async () => {
    const code = 'console.log(1);\nconsole.log(2);\n';
    await write('app.js', code);
    await write('app.js.map', sourceMap('AAAA;AACA'));

    expect(await injectDirectory(dir)).toEqual({ injected: 1, alreadyInjected: 0, skipped: 0 });

    const id = idOf(code);
    expect(await read('app.js')).toBe(`${buildSnippet(id)}\n${code}//# debugId=${id}\n`);
    expect((await readMap('app.js.map')).debugId).toBe(id);
  });

  it('puts the debug ID comment on its own line when the file does not end with a newline', async () => {
    await write('app.js', 'run()');
    await write('app.js.map', sourceMap('AAAA'));

    await injectDirectory(dir);

    const id = idOf('run()');
    expect(await read('app.js')).toBe(`${buildSnippet(id)}\nrun()\n//# debugId=${id}\n`);
  });

  it('moves every original line down by one with a leading ; in mappings', async () => {
    await write('app.js', 'a();\nb();\n');
    await write('app.js.map', sourceMap('AAAA;AACA'));

    await injectDirectory(dir);

    expect((await readMap('app.js.map')).mappings).toBe(';AAAA;AACA');
  });

  it('adds 1 to the offset of every section of an indexed map and leaves the section maps alone', async () => {
    const section = (line: number) => ({
      offset: { line, column: 0 },
      map: { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA;AACA' },
    });
    await write('app.js', 'a();\nb();\n');
    await write('app.js.map', JSON.stringify({ version: 3, sections: [section(0), section(5)] }));

    await injectDirectory(dir);

    expect((await readMap('app.js.map')).sections).toEqual([
      { ...section(0), offset: { line: 1, column: 0 } },
      { ...section(5), offset: { line: 6, column: 0 } },
    ]);
  });

  it('keeps a #! line first and inserts the empty line after the first line of mappings', async () => {
    const code = '#!/usr/bin/env node\nmain();\n';
    await write('cli.mjs', code);
    await write('cli.mjs.map', sourceMap(';AAAA;AACA'));

    await injectDirectory(dir);

    const id = idOf(code);
    expect(await read('cli.mjs')).toBe(`#!/usr/bin/env node\n${buildSnippet(id)}\nmain();\n//# debugId=${id}\n`);
    expect((await readMap('cli.mjs.map')).mappings).toBe(';;AAAA;AACA');
  });

  it('repeats a "use strict" directive on the snippet line so the script stays strict', async () => {
    const strictCode = '"use strict";\nvar strict = (function () { return this === undefined; })();\n';
    await write('strict.js', strictCode);
    await write('strict.js.map', sourceMap('AAAA;AACA'));
    const commentedCode = "/*! license */\n'use strict';run()\n";
    await write('commented.cjs', commentedCode);
    await write('commented.cjs.map', sourceMap('AAAA;AACA'));

    await injectDirectory(dir);

    const strictInjected = await read('strict.js');
    expect(strictInjected.split('\n').slice(0, 2)).toEqual([
      `"use strict";${buildSnippet(idOf(strictCode))}`,
      '"use strict";',
    ]);
    expect(runInVm(strictInjected, 'https://cdn.example.com/strict.js').strict).toBe(true);
    expect((await read('commented.cjs')).split('\n')[0]).toBe(`'use strict';${buildSnippet(idOf(commentedCode))}`);
    expect((await readMap('strict.js.map')).mappings).toBe(';AAAA;AACA');
  });

  it('pairs a file with the map its sourceMappingURL names, ahead of a .map sibling', async () => {
    const code = 'a();\n//# sourceMappingURL=../maps/app.js.map\n';
    await write('assets/app.js', code);
    await write('maps/app.js.map', sourceMap('AAAA'));
    await write('assets/app.js.map', sourceMap('AAAA'));

    await injectDirectory(dir);

    expect((await readMap('maps/app.js.map')).debugId).toBe(idOf(code));
    expect(await read('assets/app.js.map')).toBe(sourceMap('AAAA'));
  });

  it('pairs a file with a hidden map through its .map sibling', async () => {
    await write('assets/index-BxT3kQ9a.js', 'a();\n');
    await write('assets/index-BxT3kQ9a.js.map', sourceMap('AAAA'));

    await injectDirectory(dir);

    expect((await readMap('assets/index-BxT3kQ9a.js.map')).debugId).toBe(idOf('a();\n'));
  });

  it('leaves a JS file without a map untouched, including one whose only map is a data: URL', async () => {
    const plain = 'plain();\n';
    const inline = 'inline();\n//# sourceMappingURL=data:application/json;base64,e30=\n';
    await write('plain.js', plain);
    await write('inline.js', inline);
    await write('styles.css.map', sourceMap('AAAA'));

    expect(await injectDirectory(dir)).toEqual({ injected: 0, alreadyInjected: 0, skipped: 2 });

    expect(await read('plain.js')).toBe(plain);
    expect(await read('inline.js')).toBe(inline);
    expect(await read('styles.css.map')).toBe(sourceMap('AAAA'));
  });

  it('gives byte-identical output on a second run', async () => {
    await write('app.js', 'a();\nb();\n');
    await write('app.js.map', sourceMap('AAAA;AACA'));
    await write('cli.mjs', '#!/usr/bin/env node\nmain();\n');
    await write('cli.mjs.map', sourceMap(';AAAA'));
    await write('nested/strict.cjs', '"use strict";run();\n');
    await write('nested/strict.cjs.map', sourceMap('AAAA'));
    await write('plain.js', 'plain();\n');
    const paths = ['app.js', 'app.js.map', 'cli.mjs', 'cli.mjs.map', 'nested/strict.cjs', 'nested/strict.cjs.map'];

    expect(await injectDirectory(dir)).toEqual({ injected: 3, alreadyInjected: 0, skipped: 1 });
    const first = await readTree(paths);
    expect(await injectDirectory(dir)).toEqual({ injected: 0, alreadyInjected: 3, skipped: 1 });

    expect(await readTree(paths)).toEqual(first);
  });

  it('only gives the map its debugId back when an injected file is run again', async () => {
    const code = 'a();\n';
    await write('app.js', code);
    await write('app.js.map', sourceMap('AAAA'));
    await injectDirectory(dir);
    const injected = await read('app.js');
    await write('app.js.map', sourceMap(';AAAA'));

    expect(await injectDirectory(dir)).toEqual({ injected: 0, alreadyInjected: 1, skipped: 0 });

    expect(await read('app.js')).toBe(injected);
    expect(await readMap('app.js.map')).toMatchObject({ mappings: ';AAAA', debugId: idOf(code) });
  });

  it('does not shift a map again when an earlier run wrote the map but not the JS file', async () => {
    const code = 'a();\n';
    await write('app.js', code);
    await write(
      'app.js.map',
      JSON.stringify({ version: 3, sources: [], names: [], mappings: ';AAAA', debugId: idOf(code) }),
    );

    await injectDirectory(dir);

    expect((await readMap('app.js.map')).mappings).toBe(';AAAA');
    expect(await read('app.js')).toBe(`${buildSnippet(idOf(code))}\n${code}//# debugId=${idOf(code)}\n`);
  });

  it('fails on a map that is not JSON', async () => {
    await write('app.js', 'a();\n');
    await write('app.js.map', '{ not json');

    await expect(injectDirectory(dir)).rejects.toThrow('app.js.map is not valid JSON');
  });

  it('fails when the directory does not exist', async () => {
    await expect(injectDirectory(join(dir, 'missing'))).rejects.toThrow('is not a directory');
  });

  it('registers the ID under a stack whose first frame is the file URL when the snippet runs', async () => {
    const code = 'var loaded = true;\n';
    await write('app.js', code);
    await write('app.js.map', sourceMap('AAAA'));
    await injectDirectory(dir);

    const context = runInVm(await read('app.js'), 'https://cdn.example.com/assets/app.js');

    const registry = Object.entries(context._bugdumpDebugIds as Record<string, string>);
    expect(registry).toHaveLength(1);
    const [stack, id] = registry[0] ?? [];
    expect(id).toBe(idOf(code));
    expect(stack?.split('\n')[1]).toMatch(/^\s+at https:\/\/cdn\.example\.com\/assets\/app\.js:1:\d+$/);
    expect(context.loaded).toBe(true);
  });
});

// __fixtures__/app.min.js and app.min.js.map were built from __fixtures__/app.js with esbuild 0.28.1
// (format 'iife', minify, sourcemap 'external', lineLimit 40, so the output spans four lines).
// __fixtures__/injected/ holds the same two files after injectDirectory; the first test below
// regenerates them and fails when they drift. The server's symbolication tests use the injected pair.
describe('fixture', () => {
  async function injectFixture(): Promise<void> {
    await copyFile(join(FIXTURES, 'app.min.js'), join(dir, 'app.min.js'));
    await copyFile(join(FIXTURES, 'app.min.js.map'), join(dir, 'app.min.js.map'));
    await injectDirectory(dir);
  }

  it('matches the checked-in injected fixture', async () => {
    await injectFixture();

    expect(await read('app.min.js')).toBe(await readFile(join(FIXTURES, 'injected/app.min.js'), 'utf8'));
    expect(await read('app.min.js.map')).toBe(await readFile(join(FIXTURES, 'injected/app.min.js.map'), 'utf8'));
  });

  it('resolves the line numbers a browser reports to the original lines', async () => {
    await injectFixture();
    const context = runInVm(await read('app.min.js'), 'https://shop.example/assets/app.min.js');

    const stack = String(vm.runInContext('try { renderCart(null) } catch (error) { error.stack }', context));

    const frames = [...stack.matchAll(/app\.min\.js:(\d+):(\d+)\)/g)].map(([, line, column]) => [
      Number(line),
      Number(column),
    ]);
    const map = await readMap('app.min.js.map');
    expect(frames.slice(0, 2)).toEqual([
      [3, 27],
      [4, 23],
    ]);
    expect(originalPosition(map, 3, 27)).toEqual({ source: 'app.js', line: 6, name: null });
    expect(originalPosition(map, 4, 23)).toEqual({ source: 'app.js', line: 10, name: 'readTotal' });
    expect(Object.values(context._bugdumpDebugIds as Record<string, string>)).toEqual([
      computeDebugId(await readFile(join(FIXTURES, 'app.min.js'))),
    ]);
  });
});

describe('injectCommand', () => {
  it('prints how many files were injected, already injected and skipped for having no map', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await write('a.js', 'a();\n');
    await write('a.js.map', sourceMap('AAAA'));
    await write('b.js', 'b();\n');
    await write('b.js.map', sourceMap('AAAA'));
    await injectDirectory(dir);
    await write('c.js', 'c();\n');
    await write('c.js.map', sourceMap('AAAA'));
    await write('d.js', 'd();\n');

    await injectCommand(dir);

    expect(log).toHaveBeenCalledWith('Injected 1 file, 2 already injected, 1 skipped (no source map).');
  });
});
