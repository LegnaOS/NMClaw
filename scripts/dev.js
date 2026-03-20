import { spawn, execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watch } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true, cwd: root, ...opts })
  p.on('error', (e) => console.error(e.message))
  return p
}

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim()
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(Number(pid), 'SIGKILL') } catch {}
      }
    }
  } catch {}
}

// 1. Build server (tsup watch)
const tsup = run('npx', ['tsup', '--watch', '--silent'])

// 2. Build web (vite dev)
const vite = run('npx', ['vite', 'dev', '--port', '5173'], { cwd: resolve(root, 'web') })

// 3. Start API server after first build, auto-restart on rebuild
let server = null
let restarting = false

const startServer = async () => {
  if (restarting) return
  restarting = true

  // Kill old server process
  if (server) {
    server.kill('SIGKILL')
    server = null
  }

  // Kill anything on port 3000
  killPort(3000)

  // Wait for port to be released
  await new Promise(r => setTimeout(r, 500))

  server = run('node', ['dist/server.js'])
  restarting = false
}

// Wait for first build then start server
setTimeout(startServer, 2000)

// Watch for tsup rebuilds (debounced)
let debounce = null
watch(resolve(root, 'dist'), { recursive: false }, (event, filename) => {
  if (filename === 'server.js') {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      console.log('\n[dev] server rebuilt, restarting...')
      startServer()
    }, 300)
  }
})

// Cleanup
const cleanup = () => {
  tsup.kill()
  vite.kill()
  if (server) server.kill()
  killPort(3000)
  process.exit()
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
