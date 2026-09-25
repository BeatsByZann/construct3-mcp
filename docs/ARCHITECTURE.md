# Architecture

## System Overview

The Construct3 MCP Server is a TypeScript application implementing the Model Context Protocol (MCP) to provide safe, structured access to Construct 3 game engine projects — including reading, analysis, and validated modifications.

```
                        MCP Protocol (stdio)
                              |
+-----------------------------v----------------------------------+
|  Construct3 MCP Server (1.8.2, fork)                           |
|                                                                |
|  +----------------------------------------------------------+  |
|  |  MCP Protocol Layer                                      |  |
|  |  Resources (8) - Tools (185, 23 files) - Prompts (6)     |  |
|  |  Every tool runs through the session's gate              |  |
|  +----------+-----------------------------------------------+  |
|             |                                                  |
|  +----------v-----------------------------------------------+  |
|  |  Business Logic Layer                                    |  |
|  |  ProjectSession - ProjectReader - ProjectWriter          |  |
|  |  IdGenerator - Templates - References - Analyzers (7)    |  |
|  |  ACE catalogue - Addon definitions - Expression checker  |  |
|  |  Change journal - Project shape                          |  |
|  +----------+-----------------------------------------------+  |
|             |                                                  |
|  +----------v-----------------------------------------------+  |
|  |  File System Layer                                       |  |
|  |  Stamp check - Backup - Validate - Write - Verify        |  |
|  |  .c3p write-back (single-file projects)                  |  |
|  +----------+-----------------------------------------------+  |
|             |                                                  |
|  +----------v-----------------------------------------------+  |
|  |  Runtime Layer                                           |  |
|  |  Bridge script - CDP client - Preview server             |  |
|  +----------------------------------------------------------+  |
+-------------+--------------------------------------------------+
              |
+-------------v-----------------+     +---------------------------+
|  Construct 3 project files    |     |  Exported game in Chrome  |
|  project.c3proj, objectTypes/ |     |  or Edge, over loopback   |
|  eventSheets/, layouts/, ...  |     |  HTTP and CDP             |
|  or one .c3p archive          |     +---------------------------+
+-------------------------------+
```

## Core Components

### 1. Entry Point (`src/index.ts`)

Initializes the MCP server, creates all core instances, and registers handlers:

```
session  = ProjectSession.start(path)   folder, .c3proj or .c3p (unpacked to a working folder)
session.install(server)                 every tool handler runs through the session's gate
reader   → registerProjectResources, registerDocsResources, registerQueryTools,
           registerWorkflowPrompts, registerAnalysisTools, registerUsageTools
writer   → registerMutationTools (object, event, layout, project, animation, timeline,
           file, effect, flowchart, container, rename, template, tilemap, structure,
           replace tools; also needs reader + idGen)
session  → registerSessionTools (get_open_project, open_project, reload_project,
           list_changes, revert_last_change)
runtime  → registerRuntimeTools (bridge, preview server, CDP connections)
```

### 2. Project Reader (`src/construct3/project-reader.ts`)

Read-only access to all project data with lazy-loading and caching.

```typescript
class Construct3ProjectReader {
  // Core loading
  loadProject(): Promise<void>
  reloadProject(): Promise<void>

  // Read entities
  readObjectType(name: string): Promise<ObjectType>
  readEventSheet(name: string): Promise<EventSheet>
  readLayout(name: string): Promise<Layout>
  readAllObjectTypes(): Promise<Map<string, ObjectType>>
  readAllEventSheets(): Promise<Map<string, EventSheet>>
  readAllLayouts(): Promise<Map<string, Layout>>
  readAllFamilies(): Promise<Map<string, Family>>

  // Query
  listObjectTypes(): Promise<string[]>
  listEventSheets(): Promise<string[]>
  listLayouts(): Promise<string[]>
  listFamilies(): Promise<string[]>
  searchObjects(pattern: string): string[]
  findNearestName(name: string, category: string): string[]

  // Metadata
  getProject(): Construct3Project
  getMetadata(): ProjectMetadata
  getUsedAddons(): Addon[]
  getProjectDir(): string
  getProjectPath(): string

  // Cache management (called by writer after modifications)
  invalidateCaches(): void
}
```

**Design patterns:**
- **Lazy loading**: Entity files read on-demand and cached
- **Path mapping**: Built at load time from c3proj container structures (handles subfolders)
- **Fuzzy matching**: `findNearestName()` provides "Did you mean?" suggestions

### 3. Project Writer (`src/construct3/project-writer.ts`)

Safe write operations with the safety pipeline: **backup → validate → write → verify → invalidate**.

```typescript
class Construct3ProjectWriter {
  // Entity files
  writeEntityFile(category, name, data, subfolder?): Promise<string>
  deleteEntityFile(category, name, subfolder?): Promise<string>

  // c3proj container updates
  addToProject(category, name, subfolder?): Promise<void>
  removeFromProject(category, name): Promise<void>

  // Metadata
  updateProjectProperties(updates): Promise<string>

  // Addon management
  ensureAddonRegistered(type, id): Promise<string | undefined>

  // Helpers
  getSubfolderForEntity(category, name): string | undefined
}
```

**Safety guarantees:**
- **Path traversal protection**: All paths resolved and checked against project directory
- **Pre-write validation**: JSON round-trip test, null/type checks, 5MB size limit
- **Stamp check**: for writes through the project writer and the rename tools, the file must still have the size and modification time the server last saw, or the write is refused (`ExternalChangeError`) until `reload_project`
- **Journal record**: every write, create, delete and move is recorded for the call's changed-files line and `revert_last_change`, with one backup per file per call; at the end of the call the content hash of each changed file and backup is kept, and a revert refuses when any of them changed since
- **Backup**: `.bak` file created before every overwrite
- **Project shape**: `project.c3proj` is put in the shape Construct r495.2 saves before it is written (`project-shape.ts`)
- **Post-write verification**: File read back and re-parsed after writing
- **Cache invalidation**: Reader caches, project index, and ID generator all reset

### 4. ID Generator (`src/construct3/id-generator.ts`)

Collision-free SID and UID generation.

```typescript
class IdGenerator {
  initialize(reader): Promise<void>   // Scan all existing IDs (lazy, once)
  generateSid(reader): Promise<number> // 15-digit random, collision-checked
  generateUid(reader): Promise<number> // Sequential (highest + 1)
  addSid(sid): void                    // Register newly created SID
  addUid(uid): void                    // Register newly created UID
  reset(): void                        // Force re-scan on next use
}
```

**SID strategy**: Random 15-digit integer (100,000,000,000,000 – 999,999,999,999,999), checked against a set of all existing SIDs scanned from the entire project. Retry up to 100 times on collision.

**UID strategy**: Find highest existing UID across all layout instances and singleglobal-inst entries, then increment.

**Scan sources**: c3proj file items, all object/eventsheet/layout/family JSON files — including SIDs on objects, events, actions, conditions, layers, instances, behaviors, variables, animations, frames, and function parameters.

### 5. Templates (`src/construct3/templates.ts`)

Builders for valid C3 JSON structures. All field names and defaults validated against real C3 project files.

- **Object templates**: Sprite (with animations), Text, TiledBg, NinePatch, global plugins, generic
- **Event templates**: empty sheet, variable, group, function (with params), include, comment
- **Layout templates**: layout (with layers), layer, instance
- **Instance variable & behavior templates**
- **Lookup tables**: `GLOBAL_PLUGINS`, `RESERVED_NAMES`, `DEFAULT_INSTANCE_PROPERTIES`, `KNOWN_SCIRRA_PLUGINS`, `KNOWN_SCIRRA_BEHAVIORS`

### 6. Analyzers (`src/construct3/analyzers/`)

Seven analysis modules, most powered by a shared cross-reference index:

| Module | Purpose |
|--------|---------|
| `index-builder.ts` | Builds and caches project-wide cross-reference index |
| `event-flow.ts` | Include hierarchy, layout bindings (Mermaid output), function definitions and call sites |
| `object-deps.ts` | Object usage across event sheets, layouts, families; orphaned objects |
| `asset-usage.ts` | Sound, image, font, video asset tracking |
| `performance.ts` | Heuristic performance audit (info/warning/critical) |
| `group-settings.ts` | Event group activation settings |
| `integrity.ts` | `validate_project`: 18 checks, including ACE, expression and legacy-key checks |

The cross-reference index (`ProjectIndex`) is cached and reset when writes occur via `resetProjectIndex()`.

### 7. Validation (`ace-catalog.ts`, `addon-definitions.ts`, `expression-check.ts`)

| Module | Purpose |
|--------|---------|
| `ace-catalog.ts`, `ace-catalog-data.ts` | Conditions, actions and expressions of built-in plugins and behaviors, generated from Construct r495.2's own definitions by `scripts/build-ace-catalog.mjs` |
| `addon-definitions.ts` | Registry of third-party addon definitions read from `addon.json` and `aces.json` (a folder or a `.c3addon`), loaded by `load_addon_definitions` or `C3_ADDON_DEFINITIONS` |
| `expression-check.ts` | Tokenizer and parser for Construct expressions; resolves object, family, member, function and variable names against the project and the catalogue |

### 8. Session, change journal and project shape

| Module | Purpose |
|--------|---------|
| `project-session.ts` | The project served: a folder, or a `.c3p` unpacked to a working folder; `open_project` switches it |
| `c3p-project.ts` | The tool gate: runs each call inside a journal entry, appends the changed-files line, and writes a `.c3p` back after a call that changed files |
| `change-journal.ts` | Per-file size and modification stamps, the record of what each call wrote, created, deleted or moved, the helpers tools use to back up and record their own writes, and `revert_last_change` with its end-of-call content hashes |
| `project-shape.ts` | Brings `project.c3proj` to the shape Construct r495.2 saves (script metadata key, `models3d`, and for older releases property order and `zAxisScale`), never pruning `usedAddons` |
| `references.ts` | Reference scanning and rewriting for the rename tools |

### 9. MCP Layers

| Layer | File(s) | Count | Purpose |
|-------|---------|-------|---------|
| Resources | `resources/project.ts`, `resources/docs.ts` | 8 | Read-only data access |
| Query tools | `tools/query.ts`, `tools/usage-tools.ts` | 15 | List, search, get details, usage queries |
| Analysis tools | `tools/analysis.ts` | 8 | Flow, functions, dependencies, orphans, assets, performance, validation, group settings |
| Session tools | `tools/session-tools.ts` | 5 | Which project is served, reload, change journal and revert |
| Mutation tools | `tools/*-tools.ts` (18 files, registered by `tools/mutations.ts`) | 138 | Safe create, update, delete, rename, move and replace |
| Runtime tools | `tools/runtime-tools.ts`, `runtime/cdp-client.ts`, `runtime/preview-server.ts`, `runtime/bridge.ts` | 19 | Bridge injection, serving an export and launching Chrome on it, persistent CDP connections, live game calls, condition waits, event subscriptions, input dispatch (viewport, canvas or layout coordinates) and screenshots |
| Prompts | `prompts/workflows.ts` | 6 | Workflow templates |

## Data Flow

### Read Flow

```
Claude → list_objects({ filter: "btn" })
  → Zod schema validation
  → reader.searchObjects("btn")
  → in-memory filter on cached object list
  → JSON response to Claude
```

### Write Flow

```
Claude → create_object({ name: "Enemy", pluginId: "Sprite" })
  → validateName("Enemy")
  → writer.ensureAddonRegistered("plugin", "Sprite")
  → check uniqueness against reader.listObjectTypes()
  → idGen.generateSid() (scan all IDs if first use)
  → build template: createSpriteObject("Enemy", sid, animSid)
  → writer.writeEntityFile("objectTypes", "Enemy", data)
      → validateJsonData(data)     ← pre-write check
      → assertUnchanged(filePath)   ← refuse if changed on disk since last seen
      → createBackup(filePath)      ← .bak copy
      → writeFile(filePath, json)   ← actual write
      → verifyWrittenFile(filePath) ← post-write read-back
      → invalidateAll()             ← clear all caches
  → writer.addToProject("objectTypes", "Enemy")
      → createBackup(c3proj)
      → add "Enemy" to objectTypes.items
      → upgradeProjectShape(project) ← r495.2 save shape
      → atomicWrite + verify + reader.reloadProject() + invalidateAll()
  → return WriteResult to Claude
  → the gate appends "Changed N file(s): ..." from the journal entry
    and, for a .c3p, writes the archive back
```

### Analysis Flow

```
Claude → get_object_dependencies({ object: "Player" })
  → getProjectIndex(reader) (builds or returns cached index)
      → reader.readAllEventSheets()
      → reader.readAllLayouts()
      → reader.readAllFamilies()
      → scan all events for objectClass references
      → scan all instances for type references
      → build maps: objectToEventSheets, objectToLayouts, objectToFamilies
  → look up "Player" in index
  → return dependency report
```

## Communication Protocol

Uses `StdioServerTransport` from MCP SDK:
- **Input**: JSON-RPC 2.0 messages on stdin
- **Output**: JSON-RPC 2.0 responses on stdout
- **Logging**: stderr for debug/error messages

Live runtime tools maintain separate outbound CDP WebSocket connections. The
server discovers page targets from `/json/list` or accepts a direct page
endpoint, evaluates only the bridge submit/get-result protocol, and terminates
all retained sockets when the MCP transport or process closes. Condition waits
reuse those connections, polling bridge values or an explicitly requested page
expression until a comparison succeeds or the bounded timeout returns the last
observed value. Input simulation uses the same retained page socket to send
CDP `Input` and touch-emulation commands without adding a browser-automation
dependency.

## Error Handling

All tool handlers catch errors and return structured responses:

```typescript
// Success
{ content: [{ type: 'text', text: JSON.stringify(result) }] }

// Error
{ content: [{ type: 'text', text: 'Error message' }], isError: true }
```

The mutation tools provide extra context on errors:
- Fuzzy name suggestions ("Did you mean: Player?")
- Reference lists when deletion is blocked
- Warnings for auto-registered addons or unknown plugin properties

## Security

- **Path traversal protection**: `resolveProjectPath()` rejects any path escaping the project directory
- **Reserved name blocking**: "System" and other C3 reserved names cannot be used
- **Input validation**: Zod schemas on all tool parameters with length limits
- **Addon gating**: Unknown third-party plugins/behaviors blocked from auto-registration
- **Size limits**: 5MB maximum for any generated JSON file
- **Loopback by default**: `connect_to_game` accepts only this machine unless `allowRemoteHost` is set, and `serve_preview` binds to loopback, because the bridge runs script in the page it reaches
- **Path redaction**: absolute filesystem paths are removed from error text returned to the client

---

**Last Updated**: 2026-09-24
