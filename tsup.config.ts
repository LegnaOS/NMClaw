import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    clean: true,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/server.ts'],
    format: ['esm'],
    target: 'node20',
    splitting: false,
  },
])
