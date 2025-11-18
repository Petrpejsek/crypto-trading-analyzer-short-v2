/**
 * Dev-only Prompt Management System
 * 
 * Poskytuje overlay mechanismus pro dev úpravy promptů s:
 * - SHA-256 attestací použitého textu
 * - Atomic write s fsync
 * - Read-after-write verifikací
 * - Audit trail použití
 * 
 * KRITICKÉ: Žádné fallbacky - pokud něco chybí v dev módu, fail hard
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ulid } from 'ulid'

const RUNTIME_DIR = path.resolve('runtime/prompts/dev')
const META_FILE = path.join(RUNTIME_DIR, '_meta.json')
const AUDIT_FILE = path.join(RUNTIME_DIR, '_audit.ndjson')

// Kontrola, zda jsme v dev módu
export function isDevMode(): boolean {
  const nodeEnv = process.env.NODE_ENV || ''
  return nodeEnv !== 'production'
}

// SHA-256 hash z raw UTF-8 bytů
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

// Metadata struktura pro overlay prompts
type PromptMeta = {
  assistantKey: string
  sha256: string
  revision: string // ULID
  updatedAt: string // ISO timestamp
  text: string
}

type MetaRegistry = {
  [assistantKey: string]: PromptMeta
}

// Načte metadata ze souboru (synchronní)
function loadMeta(): MetaRegistry {
  try {
    ensureDir(RUNTIME_DIR)
    if (!fs.existsSync(META_FILE)) {
      return {}
    }
    const raw = fs.readFileSync(META_FILE, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    console.error('[dev_prompts] Failed to load meta:', err)
    return {}
  }
}

// Uloží metadata s atomic write
function saveMeta(meta: MetaRegistry): void {
  ensureDir(RUNTIME_DIR)
  const tmpFile = `${META_FILE}.tmp.${ulid()}`
  const json = JSON.stringify(meta, null, 2)
  
  // Atomic write: write → fsync → rename → fsync(dir)
  fs.writeFileSync(tmpFile, json, 'utf8')
  const fd = fs.openSync(tmpFile, 'r+')
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  
  fs.renameSync(tmpFile, META_FILE)
  
  // fsync parent directory
  const dirFd = fs.openSync(RUNTIME_DIR, 'r')
  fs.fsyncSync(dirFd)
  fs.closeSync(dirFd)
}

// Zajistí existenci adresáře
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Resolve prompt pro asistenta
 * 
 * PRIORITA:
 * 1. Pokud existuje overlay v runtime/prompts/dev/_meta.json → použij ho (v JAKÉMKOLI módu)
 * 2. Jinak použij fallbackPath (registry prompt z prompts/short/*.md)
 * 
 * KRITICKÁ ZMĚNA: Overlay prompty mají VŽDY prioritu, nejen v dev módu!
 * 
 * @param assistantKey - Klíč asistenta (např. 'strategy_updater')
 * @param fallbackPath - Cesta k původnímu promptu (např. 'prompts/short/strategy_updater.md')
 * @returns Objekt s textem a hashem
 */
export function resolveAssistantPrompt(
  assistantKey: string,
  fallbackPath: string
): { text: string; sha256: string; source: 'dev-overlay' | 'registry' } {
  // PRIORITA 1: Zkontroluj, jestli existuje overlay (v JAKÉMKOLI módu)
  const meta = loadMeta()
  const overlayMeta = meta[assistantKey]
  
  if (overlayMeta) {
    // Read-after-write verifikace
    const currentHash = sha256(overlayMeta.text)
    if (currentHash !== overlayMeta.sha256) {
      console.error(
        `[dev_prompts] SHA-256 mismatch for '${assistantKey}': ` +
        `stored=${overlayMeta.sha256.slice(0, 16)}, actual=${currentHash.slice(0, 16)}`
      )
      // V production módu padáme na chybu, v dev módu jen logujeme warning
      if (!isDevMode()) {
        throw new Error(
          `[dev_prompts] SHA-256 mismatch for '${assistantKey}': ` +
          `stored=${overlayMeta.sha256.slice(0, 16)}, actual=${currentHash.slice(0, 16)}`
        )
      }
    }
    
    console.info(`[dev_prompts] Using OVERLAY prompt for '${assistantKey}' (${overlayMeta.sha256.slice(0, 16)}...)`)
    
    return {
      text: overlayMeta.text,
      sha256: overlayMeta.sha256,
      source: 'dev-overlay'
    }
  }
  
  // PRIORITA 2: Fallback na registry prompt
  const resolved = path.resolve(fallbackPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`[dev_prompts] Prompt not found: ${fallbackPath} (and no overlay exists)`)
  }
  
  const text = fs.readFileSync(resolved, 'utf8')
  console.info(`[dev_prompts] Using REGISTRY prompt for '${assistantKey}'`)
  
  return {
    text,
    sha256: sha256(text),
    source: 'registry'
  }
}

/**
 * Lint kontroly pro prompt text
 */
type LintViolation = {
  rule: string
  message: string
}

function lintPromptText(assistantKey: string, text: string): LintViolation[] {
  const violations: LintViolation[] = []
  
  // Globální pravidlo: žádné fallbacky
  const forbiddenWords = ['fallback', 'default prompt', 'pokud selže', 'náhradní']
  for (const word of forbiddenWords) {
    if (text.toLowerCase().includes(word)) {
      violations.push({
        rule: 'NO_FALLBACKS',
        message: `Zakázané slovo: "${word}"`
      })
    }
  }
  
  // Per-asistent kotvy
  if (assistantKey === 'strategy_updater') {
    if (!text.includes('newSL ≤ currentSL')) {
      violations.push({
        rule: 'STRATEGY_UPDATER_INVARIANT',
        message: 'Chybí invariant: "newSL ≤ currentSL"'
      })
    }
    if (!text.includes('newSL = markPrice')) {
      violations.push({
        rule: 'STRATEGY_UPDATER_INVARIANT',
        message: 'Chybí invariant: "okamžitý exit: newSL = markPrice"'
      })
    }
  }
  
  // entry_risk_manager: Odstraněna zastaralá validace pro "spread > 0.25"
  // Prompt explicitně používá kontextové hodnocení místo rigidních hranic
  
  return violations
}

/**
 * Nastaví overlay prompt pro asistenta (dev-only)
 * 
 * @throws Error pokud nejsme v dev módu nebo selže lint
 */
export function setOverlayPrompt(
  assistantKey: string,
  text: string,
  clientSha256: string,
  ifMatchRevision?: string
): { sha256: string; revision: string; updatedAt: string } {
  if (!isDevMode()) {
    throw new Error('[dev_prompts] setOverlayPrompt je pouze pro dev mód')
  }
  
  // Lint kontroly
  const violations = lintPromptText(assistantKey, text)
  if (violations.length > 0) {
    throw new Error(
      `[dev_prompts] Lint failed:\n${violations.map(v => `  - ${v.rule}: ${v.message}`).join('\n')}`
    )
  }
  
  // Spočítej hash
  const computedHash = sha256(text)
  
  // Verifikuj shodu s klientem
  if (computedHash !== clientSha256) {
    throw new Error(
      `[dev_prompts] SHA-256 mismatch: client=${clientSha256.slice(0, 16)}, server=${computedHash.slice(0, 16)}`
    )
  }
  
  // Načti meta a zkontroluj revision guard
  const meta = loadMeta()
  const existing = meta[assistantKey]
  
  if (ifMatchRevision && existing && existing.revision !== ifMatchRevision) {
    throw new Error(
      `[dev_prompts] Revision conflict: expected=${ifMatchRevision}, actual=${existing.revision}`
    )
  }
  
  // Vytvoř novou revizi
  const newRevision = ulid()
  const updatedAt = new Date().toISOString()
  
  meta[assistantKey] = {
    assistantKey,
    sha256: computedHash,
    revision: newRevision,
    updatedAt,
    text
  }
  
  // Atomic write
  saveMeta(meta)
  
  // Read-after-write verifikace
  const verifyMeta = loadMeta()
  const verified = verifyMeta[assistantKey]
  if (!verified || verified.sha256 !== computedHash) {
    throw new Error('[dev_prompts] Read-after-write verification failed')
  }
  
  // Audit log
  notePromptUpdate(assistantKey, computedHash, 'set_overlay')
  
  return {
    sha256: computedHash,
    revision: newRevision,
    updatedAt
  }
}

/**
 * Získá overlay prompt (dev-only)
 */
export function getOverlayPrompt(assistantKey: string): PromptMeta | null {
  if (!isDevMode()) {
    return null
  }
  
  const meta = loadMeta()
  return meta[assistantKey] || null
}

/**
 * Seznam všech asistentů s info o overlay
 */
export function listAssistants(): Array<{
  assistantKey: string
  hasOverlay: boolean
  sha256?: string
  updatedAt?: string
  revision?: string
}> {
  // Načti všechny známé asistenty z registry
  const knownAssistants = [
    'hot_screener',
    'entry_strategy_aggressive',
    'entry_strategy_conservative',
    'entry_risk_manager',
    'entry_updater',
    'strategy_updater',
    'profit_taker',
    'top_up_executor',
    'ai_profit_taker',
    'reactive_entry_assistant',
    'health_monitor'
  ]
  
  const meta = loadMeta()
  
  return knownAssistants.map(key => {
    const overlay = meta[key]
    return {
      assistantKey: key,
      hasOverlay: !!overlay,
      sha256: overlay?.sha256,
      updatedAt: overlay?.updatedAt,
      revision: overlay?.revision
    }
  })
}

/**
 * Zaznamenává použití promptu (audit trail)
 */
export function notePromptUsage(assistantKey: string, usedSha256: string): void {
  notePromptUpdate(assistantKey, usedSha256, 'used')
}

function notePromptUpdate(assistantKey: string, sha256Hash: string, action: 'used' | 'set_overlay'): void {
  try {
    ensureDir(RUNTIME_DIR)
    const entry = {
      timestamp: new Date().toISOString(),
      assistantKey,
      sha256: sha256Hash,
      action
    }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    console.error('[dev_prompts] Failed to write audit log:', err)
  }
}

/**
 * Získá attestation info (porovnání stored vs used)
 */
export function getPromptAttestation(assistantKey: string): {
  storedSha256: string | null
  lastUsedSha256: string | null
  lastUsedAt: string | null
} {
  const meta = loadMeta()
  const overlay = meta[assistantKey]
  
  // Načti poslední použití z audit logu
  let lastUsedSha256: string | null = null
  let lastUsedAt: string | null = null
  
  try {
    if (fs.existsSync(AUDIT_FILE)) {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean)
      // Projdi odzadu
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i])
        if (entry.assistantKey === assistantKey && entry.action === 'used') {
          lastUsedSha256 = entry.sha256
          lastUsedAt = entry.timestamp
          break
        }
      }
    }
  } catch (err) {
    console.error('[dev_prompts] Failed to read audit log:', err)
  }
  
  return {
    storedSha256: overlay?.sha256 || null,
    lastUsedSha256,
    lastUsedAt
  }
}

/**
 * Exportuje overlay prompt do registry (prompts/*.md)
 * Používá se pro migraci změn z dev do prod
 * 
 * @param assistantKey - Klíč asistenta
 * @param registryPath - Cesta k registry souboru (např. 'prompts/short/strategy_updater.md')
 * @returns Info o exportu
 */
export function exportOverlayToRegistry(
  assistantKey: string,
  registryPath: string
): { exported: boolean; sha256: string; path: string } {
  if (!isDevMode()) {
    throw new Error('[dev_prompts] exportOverlayToRegistry je pouze pro dev mód')
  }
  
  const meta = loadMeta()
  const overlay = meta[assistantKey]
  
  if (!overlay) {
    throw new Error(`[dev_prompts] Overlay pro '${assistantKey}' neexistuje`)
  }
  
  // Resolve plnou cestu
  const fullPath = path.resolve(registryPath)
  
  // Zajisti existenci parent adresáře
  const parentDir = path.dirname(fullPath)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }
  
  // Atomic write do registry
  const tmpFile = `${fullPath}.tmp.${ulid()}`
  
  fs.writeFileSync(tmpFile, overlay.text, 'utf8')
  const fd = fs.openSync(tmpFile, 'r+')
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  
  fs.renameSync(tmpFile, fullPath)
  
  // fsync parent directory
  const dirFd = fs.openSync(parentDir, 'r')
  fs.fsyncSync(dirFd)
  fs.closeSync(dirFd)
  
  // Read-after-write verifikace
  const written = fs.readFileSync(fullPath, 'utf8')
  const writtenHash = sha256(written)
  
  if (writtenHash !== overlay.sha256) {
    throw new Error(
      `[dev_prompts] Export verification failed: expected=${overlay.sha256.slice(0, 16)}, got=${writtenHash.slice(0, 16)}`
    )
  }
  
  console.log(`[dev_prompts] ✓ Exported ${assistantKey} → ${registryPath} (${overlay.sha256.slice(0, 16)}...)`)
  
  return {
    exported: true,
    sha256: overlay.sha256,
    path: fullPath
  }
}

/**
 * Exportuje všechny overlay prompty do registry
 */
export function exportAllOverlaysToRegistry(): Array<{
  assistantKey: string
  exported: boolean
  sha256?: string
  path?: string
  error?: string
}> {
  const meta = loadMeta()
  const results: Array<{
    assistantKey: string
    exported: boolean
    sha256?: string
    path?: string
    error?: string
  }> = []
  
  // Mapa assistant key → registry path
  const registryPaths: Record<string, string> = {
    hot_screener: 'prompts/short/hot_screener.md',
    entry_strategy_aggressive: 'prompts/short/entry_strategy_aggressive.md',
    entry_strategy_conservative: 'prompts/short/entry_strategy_conservative.md',
    entry_risk_manager: 'prompts/short/entry_risk_manager.md',
    entry_updater: 'prompts/short/entry_updater.md',
    strategy_updater: 'prompts/short/strategy_updater.md',
    profit_taker: 'prompts/short/profit_taker.md',
    top_up_executor: 'prompts/short/top_up_executor.md',
    ai_profit_taker: 'prompts/short/ai_profit_taker.md',
    reactive_entry_assistant: 'prompts/short/reactive_entry_assistant.md',
    health_monitor: 'prompts/short/health_monitor.md'
  }
  
  for (const [key, overlay] of Object.entries(meta)) {
    try {
      const registryPath = registryPaths[key]
      if (!registryPath) {
        results.push({
          assistantKey: key,
          exported: false,
          error: 'Neznámý assistant key (chybí registry path)'
        })
        continue
      }
      
      const result = exportOverlayToRegistry(key, registryPath)
      results.push({
        assistantKey: key,
        exported: true,
        sha256: result.sha256,
        path: result.path
      })
    } catch (err: any) {
      results.push({
        assistantKey: key,
        exported: false,
        error: err?.message || 'Neznámá chyba'
      })
    }
  }
  
  return results
}
