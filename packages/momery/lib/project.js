/**
 * Project identity: which project does a tool call belong to?
 *
 * The session's working directory is the anchor. The project root climbs to the
 * nearest marker (.git, package.json, pyproject.toml, Cargo.toml, go.mod, .hg), so a
 * nested folder still resolves to its repo, and the slug is a pure function of that
 * normalized absolute path.
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { projectSlug, slugify } from './note.js'
import { ensureProject, loadRegistry } from './store.js'

const ROOT_MARKERS = ['.git', 'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.hg', 'AGENTS.md', 'CLAUDE.md']

/** Nearest ancestor of `start` holding a project marker, else `start` itself. */
export function findProjectRoot(start) {
  let current = resolve(String(start ?? process.cwd()))
  const limit = 12
  for (let depth = 0; depth < limit; depth++) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(String(start ?? process.cwd()))
}

/** Identity of one working directory: `{ slug, name, rootPath }`. */
export function identify(cwd) {
  const rootPath = findProjectRoot(cwd)
  const name = basename(rootPath) || rootPath
  return { slug: projectSlug(rootPath), name, rootPath }
}

/**
 * Resolve and register the calling agent's project. Registers aliases so a note can be
 * addressed by folder name, slug, or explicit alias from any other project.
 */
export function projectForAgent(root, cwd) {
  const info = identify(cwd)
  const aliases = [info.name, slugify(basename(info.rootPath))]
  const record = ensureProject(root, { slug: info.slug, rootPath: info.rootPath, name: info.name, aliases })
  return { ...record, ...info, slug: info.slug }
}

/** Look up a project record without touching disk state, for read-only paths. */
export function peekProject(root, ref) {
  if (!ref) return null
  const registry = loadRegistry(root)
  const wanted = String(ref).toLowerCase()
  for (const record of Object.values(registry.records)) {
    if (record.slug.toLowerCase() === wanted) return record
    if (String(record.name ?? '').toLowerCase() === wanted) return record
    if ((record.aliases ?? []).some((alias) => String(alias).toLowerCase() === wanted)) return record
  }
  return null
}