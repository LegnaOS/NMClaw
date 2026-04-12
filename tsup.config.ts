import { defineConfig } from 'tsup'

// 纯 ESM 包 + 大型依赖不打包，保持 external
const external = [
  'nanoid', 'chalk', 'ora', 'grammy', 'discord.js', '@slack/bolt',
  'playwright-core', 'xlsx', 'mammoth', 'pdf-parse', 'jszip', 'docx',
  '@larksuiteoapi/node-sdk', '@anthropic-ai/sdk', 'openai',
  'better-sqlite3', 'ws', 'hono', '@hono/node-server',
]

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    clean: true,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
    external,
  },
  {
    entry: ['src/server.ts'],
    format: ['esm'],
    target: 'node20',
    splitting: false,
    external,
  },
])
