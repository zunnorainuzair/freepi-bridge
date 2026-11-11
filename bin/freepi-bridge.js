#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  // BridgeError messages are already user-facing and multi-line.
  console.error(err?.name === 'BridgeError' ? err.message : err?.stack || String(err));
  process.exit(1);
});
