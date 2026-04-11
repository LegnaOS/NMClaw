/**
 * Temporal Entity-Relationship Knowledge Graph — SQLite per agent
 * Reuses the same DB path as memory.ts: ~/.nmclaw/memory/{agentId}.sqlite
 */
import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { getStoreDir } from './store.js'

// ─── Interfaces ───

export interface Entity {
  id: string
  name: string
  type: string
  properties: Record<string, unknown>
}

export interface Triple {
  id: string
  subject: string
  predicate: string
  object: string
  validFrom?: string
  validTo?: string
  confidence: number
  sourceCloset?: string
  sourceFile?: string
}

export interface KGStats {
  entities: number
  triples: number
  current: number
  expired: number
}

interface EntityRow {
  id: string; name: string; type: string; properties: string
}

interface TripleRow {
  id: string; subject: string; predicate: string; object: string
  valid_from: string | null; valid_to: string | null; confidence: number
  source_closet: string | null; source_file: string | null
}

// ─── DB Cache (same pattern as memory.ts) ───

const kgDbCache = new Map<string, Database.Database>()

function getKgDb(agentId: string): Database.Database {
  const cached = kgDbCache.get(agentId)
  if (cached) return cached
  const dir = join(getStoreDir(), 'memory')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${agentId}.sqlite`))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 3000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      properties TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS triples (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      confidence REAL DEFAULT 1.0,
      source_closet TEXT,
      source_file TEXT
    );
    CREATE TABLE IF NOT EXISTS attributes (
      entity_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      valid_from TEXT,
      valid_to TEXT,
      PRIMARY KEY (entity_id, key, valid_from)
    );
    CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
    CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
    CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
    CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
  `)
  kgDbCache.set(agentId, db)
  return db
}

// ─── Helper ───

function toEntityId(name: string): string {
  return name.toLowerCase().replace(/ /g, '_')
}

function rowToTriple(r: TripleRow): Triple {
  return {
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    validFrom: r.valid_from ?? undefined,
    validTo: r.valid_to ?? undefined,
    confidence: r.confidence,
    sourceCloset: r.source_closet ?? undefined,
    sourceFile: r.source_file ?? undefined,
  }
}

function rowToEntity(r: EntityRow): Entity {
  let props: Record<string, unknown> = {}
  try { props = JSON.parse(r.properties) } catch { /* */ }
  return { id: r.id, name: r.name, type: r.type, properties: props }
}

// ─── KnowledgeGraph Class ───

export class KnowledgeGraph {
  private db: Database.Database

  constructor(private agentId: string) {
    this.db = getKgDb(agentId)
  }

  addEntity(name: string, type = 'unknown', properties: Record<string, unknown> = {}): Entity {
    const id = toEntityId(name)
    this.db.prepare(
      'INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)',
    ).run(id, name, type, JSON.stringify(properties))
    return { id, name, type, properties }
  }

  addTriple(
    subject: string, predicate: string, object: string,
    validFrom?: string, validTo?: string, confidence = 1.0,
    sourceCloset?: string, sourceFile?: string,
  ): Triple {
    // Auto-create entities if missing
    const subId = toEntityId(subject)
    const objId = toEntityId(object)
    const existing = this.db.prepare('SELECT id FROM entities WHERE id = ?')
    if (!existing.get(subId)) this.addEntity(subject)
    if (!existing.get(objId)) this.addEntity(object)

    const id = nanoid(12)
    this.db.prepare(
      `INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, subId, predicate, objId, validFrom ?? null, validTo ?? null, confidence, sourceCloset ?? null, sourceFile ?? null)
    return { id, subject: subId, predicate, object: objId, validFrom, validTo, confidence, sourceCloset, sourceFile }
  }

  expireTriple(tripleId: string, validTo?: string): boolean {
    const ts = validTo ?? new Date().toISOString()
    return this.db.prepare('UPDATE triples SET valid_to = ? WHERE id = ?').run(ts, tripleId).changes > 0
  }

  queryEntity(name: string): { entity: Entity | null; triples: Triple[] } {
    const id = toEntityId(name)
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined
    if (!row) return { entity: null, triples: [] }
    const triples = this.db.prepare(
      'SELECT * FROM triples WHERE subject = ? OR object = ?',
    ).all(id, id) as TripleRow[]
    return { entity: rowToEntity(row), triples: triples.map(rowToTriple) }
  }

  queryRelationship(subject?: string, predicate?: string, object?: string): Triple[] {
    const clauses: string[] = []
    const params: string[] = []
    if (subject) { clauses.push('subject = ?'); params.push(toEntityId(subject)) }
    if (predicate) { clauses.push('predicate = ?'); params.push(predicate) }
    if (object) { clauses.push('object = ?'); params.push(toEntityId(object)) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM triples ${where}`).all(...params) as TripleRow[]
    return rows.map(rowToTriple)
  }

  getTimeline(entityName?: string): Triple[] {
    if (entityName) {
      const id = toEntityId(entityName)
      const rows = this.db.prepare(
        'SELECT * FROM triples WHERE (subject = ? OR object = ?) ORDER BY valid_from ASC',
      ).all(id, id) as TripleRow[]
      return rows.map(rowToTriple)
    }
    const rows = this.db.prepare('SELECT * FROM triples ORDER BY valid_from ASC').all() as TripleRow[]
    return rows.map(rowToTriple)
  }

  getStats(): KGStats {
    const { ec } = this.db.prepare('SELECT COUNT(*) as ec FROM entities').get() as { ec: number }
    const { tc } = this.db.prepare('SELECT COUNT(*) as tc FROM triples').get() as { tc: number }
    const { cc } = this.db.prepare('SELECT COUNT(*) as cc FROM triples WHERE valid_to IS NULL').get() as { cc: number }
    return { entities: ec, triples: tc, current: cc, expired: tc - cc }
  }

  close(): void {
    try { this.db.close() } catch { /* */ }
    kgDbCache.delete(this.agentId)
  }
}
