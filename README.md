# @bugdump/cli

Official CLI for [Bugdump](https://bugdump.com). Upload your build's source maps so the errors the Bugdump SDK captures show your original files, lines and function names instead of minified code. The maps are stored privately and never served to anyone.

Requires Node.js 18 or later. No runtime dependencies.

## Installation

```bash
npm install --save-dev @bugdump/cli
# or
pnpm add -D @bugdump/cli
```

Or run it without installing: `npx @bugdump/cli sourcemaps inject dist`.

## Usage

Build with hidden source maps, stamp a debug ID into the output, upload the maps, then deploy:

```bash
vite build --sourcemap hidden
bugdump sourcemaps inject dist
bugdump sourcemaps upload dist --release "$GIT_SHA" --delete-after
# then deploy dist
```

Deploy the injected files. A deploy of the output from before `inject` carries no debug IDs, and its errors stay minified.

Any bundler that writes `.map` files works, for example webpack with `devtool: 'hidden-source-map'`, Rollup with `output.sourcemap: 'hidden'` or esbuild with `--sourcemap=external`.

### `bugdump sourcemaps inject <dir>`

Needs no token and makes no request. For every `.js`, `.mjs` and `.cjs` file under `<dir>` that has a source map — the file its `//# sourceMappingURL=` comment names, or `<file>.map` next to it — it:

- computes a debug ID from the file's content, so the same build output always gets the same ID;
- adds a one-line snippet at the top of the file that registers the ID for the Bugdump SDK;
- appends a `//# debugId=<id>` comment, writes `"debugId"` into the map and shifts the map by the added line, so browser line numbers still resolve.

Files without a map are left alone. Running it again changes nothing. It prints how many files were injected, already injected, and skipped for having no map.

### `bugdump sourcemaps upload <dir>`

Uploads every `*.map` under `<dir>` that has a debug ID. A map without one is skipped with a warning; when no map has one, the command fails. A map over 20 MB is skipped with a warning too, since Bugdump does not take it. Maps the project already has are skipped.

- `--release <name>` tags the maps with a release, such as a git commit. It is optional: maps are found by debug ID, never by release. Bugdump uses the release to show where an error happened and to reopen a resolved task when its error comes back in a new release.
- `--delete-after` deletes the uploaded maps from `<dir>` once Bugdump has confirmed them, so they are never deployed.
- `--endpoint <url>` sets the Bugdump API URL. Defaults to `https://api.bugdump.com`.

The release token is read from `BUGDUMP_RELEASE_TOKEN`. Create one on your project's Source maps page in Bugdump; it can only upload source maps.

A request the API answers with 429 or a 5xx is retried three times. The command exits with a non-zero code when a request still fails, a map does not reach storage or a map was over 20 MB, and then deletes nothing, so it is safe to run again.

## License

MIT
