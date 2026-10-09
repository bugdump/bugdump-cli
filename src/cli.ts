#!/usr/bin/env node
import { run } from './lib/run';

run(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
