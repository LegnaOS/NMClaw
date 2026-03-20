import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true, cwd: root, ...opts })
  p.on('error', (e) => console.error(e.message))
  return p
}

// 1. Build server (tsup watch)
const tsup = run('npx', ['tsup', '--watch', '--silent'])

// 2. Build web (vite dev)
const vite = run('npx', ['vite', 'dev', '--port', '5173'], { cwd: resolve(root, 'web') })

// 3. Start API server after first build, auto-restart on rebuild
let server = null
const startServer = () => {
  if (server) server.kill()
  server = run('node', ['dist/server.js'])
}

// Wait for first build then start server
setTimeout(startServer, 2000)

// Watch for tsup rebuilds
import { watch } from 'node:fs'
watch(resolve(root, 'dist'), { recursive: false }, (event, filename) => {
  if (filename === 'server.js') {
    console.log('\n[dev] server rebuilt, restarting...')
    startServer()
  }
})

// Cleanup
const cleanup = () => {
  tsup.kill()
  vite.kill()
  if (server) server.kill()
  process.exit()
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
