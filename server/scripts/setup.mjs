#!/usr/bin/env node
import { run } from "./setup/run.mjs";

process.exitCode = await run(process.argv.slice(2));
