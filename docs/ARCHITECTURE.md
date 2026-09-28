# Architecture

## System Overview

The Construct3 MCP Server is a TypeScript application implementing the Model Context Protocol (MCP) to provide safe, structured access to Construct 3 game engine projects — including reading, analysis, and validated modifications.

```
                        MCP Protocol (stdio)
                              |
+-----------------------------v----------------------------------+
|  Construct3 MCP Server (1.9.1, fork)                           |
|                                                                |
|  +----------------------------------------------------------+  |
|  |  MCP Protocol Layer                                      |  |
|  |  Resources (9) - Tools (190, 23 files) - Prompts (7)     |  |
|  |  Every tool runs through the session's gate              |  |
|  +----------+-----------------------------------------------+  |
|             |                                                  |
|  +----------v-----------------------------------------------+  |
|  |  Business Logic Layer                                    |  |
|  |  ProjectSession - ProjectReader - ProjectWriter          |  |
|  |  IdGenerator - Templates - References - Analyzers (15)   |  |
|  |  ACE catalogue - Addon definitions - Expression checker  |  |
|  |  Change journal - Project shape - Load-time rules        |  |
|  +----------+-----------------------------------------------+  |
|             |                                                  |
|  +----------v-----------------------------------------------+  |
|  |  File System Layer                                       |  |
|  |  Stamp check - Backup - Validate - Atomic write - Verify |  |
|  |  Text style (line endings, BOM) - .c3p write-back        |  |
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

The server registers 190 tools, 9 resources and 7 prompts. The per-layer counts in [MCP Layers](#9-mcp-layers) follow the module that registers each tool, so read-only tools such as `list_addons`, `list_timelines`, `get_timeline_details`, `list_effects` and `list_flowcharts` count as mutation tools: they live in the modules of their area.

## Core Components

### 1. Entry Point (`src/index.ts`)

Resolves the project path (first CLI argument, then `C3_PROJECT_PATH`, then the working directory; a directory is searched for a `.c3proj` file), loads the project, creates all core instances, and registers handlers:

```
session  = ProjectSession.start(path)   folder, .c3proj or .c3p (unpacked to a working folder)
session.install(server)                 every tool handler runs through the session's gate
reader   → registerProjectResources, registerQueryTools, registerWorkflowPrompts,
           registerAnalysisTools, registerUsageTools
(none)   → registerDocsResources (docs index, manual topics, pitfalls)
writer   → registerMutationTools (object, event, layout, project, animation, timeline,
           file, effect, flowchart, container, rename, template, tilemap, structure,
           replace tools; also needs reader + idGen)
session  → registerSessionTools (get_open_project, open_project, reload_project,
           list_changes, revert_last_change)
runtime  → registerRuntimeTools (bridge, preview server, CDP connections; needs reader + writer)
```

### 2. Project Reader (`src/construct3/project-reader.ts`)

Read-only access to all project data with lazy-loading and caching.

```typescript
class Construct3ProjectReader {
  // Core loading
  loadProject(): Promise<Construct3Project>
  reloadProject(): Promise<void>
  static isValidProject(projectPath: string): Promise<boolean>
  static findProjectFile(directory: string): Promise<string | null>

  // Read entities
  readObjectType(name: string): Promise<ObjectType>
  readEventSheet(name: string): Promise<EventSheet>
  readLayout(name: string): Promise<Layout>
  readFamily(name: string): Promise<Record<string, unknown>>
  readScriptFile(relativePath: string): Promise<string>
  readAllObjectTypes(): Promise<Map<string, ObjectType>>
  readAllEventSheets(): Promise<Map<string, EventSheet>>
  readAllLayouts(): Promise<Map<string, Layout>>
  readAllFamilies(): Promise<Map<string, Record<string, unknown>>>

  // Query
  listObjectTypes(): Promise<string[]>
  listEventSheets(): Promise<string[]>
  listLayouts(): Promise<string[]>
  listFamilies(): Promise<string[]>
  searchObjects(pattern: string): string[]
  findNearestName(name: string, category: 'objects' | 'eventsheets' | 'layouts'): string[]

  // Metadata
  getProject(): Construct3Project
  getMetadata(): { name, version, author, description, runtime,
                   viewportWidth, viewportHeight, firstLayout }
  getUsedAddons(): Addon[]
  getProjectDir(): string
  getProjectPath(): string

  // Cache management (called by writer after modifications)
  invalidateCaches(): void
}
```

**Design patterns:**
- **Lazy loading**: Entity files read on demand; the bulk `readAll*()` results are cached
- **Path mapping**: Built at load time from c3proj container structures (handles subfolders)
- **Fuzzy matching**: `findNearestName()` provides "Did you mean?" suggestions
- **Bounded reads**: Entity and script files over 10MB are refused; a leading BOM is stripped before parsing

### 3. Project Writer (`src/construct3/project-writer.ts`)

Safe write operations with the safety pipeline: **backup → validate → write → verify → invalidate**.

```typescript
class Construct3ProjectWriter {
  // Entity files (objectTypes, eventSheets, layouts, families)
  writeEntityFile(category, name, data, subfolder?, { createOnly? }): Promise<string>
  entityFileRefusal(category, name, subfolder?): Promise<string | undefined>  // file already on disk, ignoring case
  deleteEntityFile(category, name, subfolder?): Promise<string>

  // c3proj container updates
  addToProject(category, name, subfolder?): Promise<void>
  removeFromProject(category, name): Promise<void>

  // Metadata (keys checked against an allowlist)
  updateProjectProperties(updates): Promise<string>

  // Addon management
  ensureAddonRegistered(type, id): Promise<string | undefined>

  // Placeholder images
  writeImageFile(objectName, animationName, frameIndex, pluginId?, width?, height?): Promise<string>
  writeImageFiles(files): Promise<string[]>

  // Helpers
  getSubfolderForEntity(category, name): string | undefined
}
```

**Safety guarantees:**
- **Path traversal protection**: All paths resolved through `resolveProjectPath()` (`path-utils.ts`) and checked against the project directory
- **Pre-write validation**: JSON round-trip test, null/type checks, 5MB size limit
- **Stamp check**: for writes through the project writer and the rename tools, the file must still have the size and modification time the server last saw, or the write is refused (`ExternalChangeError`) until `reload_project`
- **Journal record**: every write, create, delete and move is recorded for the call's changed-files line and `revert_last_change`, with one backup per file per call; at the end of the call the content hash of each changed file and backup is kept, and a revert refuses when any of them changed since
- **Backup**: `.bak` file created before every overwrite or delete, under the file's name on disk
- **Project shape**: `project.c3proj` is put in the shape Construct r495.2 saves before it is written (`project-shape.ts`)
- **Atomic write**: Content goes to a `.tmp` file that is then renamed into place; an existing file keeps its name on disk, including its case (`atomic-write.ts`)
- **No overwrite on create**: Create tools pass `createOnly`, so a new entity is never written over a file that already exists, also one whose name differs only in case
- **Post-write verification**: File read back, compared with the text that was written, and re-parsed; different content that still parses is reported as a concurrent write. A failure once the backup exists (while or after replacing the file) throws an `EntityWriteError` carrying the backup path, so a change that spans several files can restore this one too (`restoreEntityFile`, which records no extra journal change)
- **Project lock**: The writer's read-modify-writes of `project.c3proj` (`addToProject`, `removeFromProject`, `updateProjectProperties`, file registration, addon auto-registration) share one lock, so parallel writer calls cannot lose each other's updates
- **Text style**: An existing file keeps its line endings, trailing whitespace and BOM; a new file follows `project.c3proj` (`json-format.ts`)
- **Cache invalidation**: Reader caches, project index, and ID generator all reset
- **Image rollback**: `writeImageFiles()` deletes the images it already wrote when a later one fails

The timeline and ease tools, `register_addon` / `unregister_addon`, the flowchart, container, tilemap brush, rename and duplicate tools and the runtime tools' bridge script write outside the writer, with fewer of these steps: they back up and journal each file, but do not read it back; the README's Safety Model lists the differences. All of them except the runtime tools' bridge script (a script, not JSON) keep an overwritten file's text style through `json-format.ts` and `atomic-write.ts`, like the writer. A tilemap brush file is one line of compact JSON as Construct 3 writes it, so the brush tools keep an existing file's layout (compact, or its indent string), line endings, trailing whitespace and BOM, and write a new file compact. None of them takes the project lock, and several use the same `project.c3proj.tmp` file as the writer, so running them in parallel with other writes can lose or fail a `project.c3proj` update. Run them one at a time.

### 4. ID Generator (`src/construct3/id-generator.ts`)

Collision-free SID, UID and imageSpriteId generation.

```typescript
class IdGenerator {
  initialize(reader): Promise<void>             // Scan all existing IDs (lazy, once)
  generateSid(reader): Promise<number>           // 15-digit random, collision-checked
  generateUid(reader): Promise<number>           // Sequential (highest + 1)
  generateImageSpriteId(reader): Promise<number> // 7-digit random, collision-checked
  addSid(sid): void                              // Register newly created SID
  addUid(uid): void                              // Register newly created UID
  reset(): void                                  // Force re-scan on next use
}
```

**SID strategy**: Random 15-digit integer (100,000,000,000,000 – 999,999,999,999,999), checked against a set of all existing SIDs scanned from the entire project. Retry up to 100 times on collision.

**UID strategy**: Find highest existing UID across all layout instances and singleglobal-inst entries, then increment.

**imageSpriteId strategy**: Random 7-digit integer, checked against the IDs of all existing animation frames. Links an animation frame to its image file.

**Scan sources**: c3proj file items, all object/eventsheet/layout/family JSON files — including SIDs on objects, events, actions, conditions, layers, instances, behaviors, variables, animations, frames, and function parameters.

### 5. Templates (`src/construct3/templates.ts`)

Builders for valid C3 JSON structures. All field names and defaults validated against real C3 project files.

- **Object templates**: Sprite (with animations), Text, TiledBg, global plugins, generic (any other plugin)
- **Event templates**: empty sheet, variable, group, function (with params), include, comment, block
- **Animation templates**: animation, animation frame
- **Layout templates**: layout (with layers), layer, instance
- **Instance variable & behavior templates**
- **Lookup tables**: `GLOBAL_PLUGINS`, `NONWORLD_GLOBAL_PLUGINS`, `RESERVED_NAMES`, `DEFAULT_INSTANCE_PROPERTIES`, `KNOWN_SCIRRA_PLUGINS`, `KNOWN_SCIRRA_BEHAVIORS`, `BEHAVIOR_INSTANCE_DEFAULTS`

Supporting modules next to the templates:

| Module | Purpose |
|--------|---------|
| `construct3/event-shapes.ts` | The event shapes the editor saves: System else condition, OR blocks, positional function calls, script lines |
| `construct3/atomic-write.ts` | Temp-file-and-rename writes that keep an existing file's name on disk; case-insensitive file lookup |
| `construct3/names.ts` | Name comparison the way the editor does it (ignoring case) for names and project-bar folders |
| `construct3/event-variable-names.ts` | The editor's rules for event variable and function parameter names: scope, System expression names, characters it refuses |
| `construct3/instance-behaviors.ts` | The behavior entries every layout instance carries (object and family behaviors, with default property values) |
| `construct3/animation-rename.ts` | Sprite animations in animation folders, and what renaming one changes: frame image file names, `initial-animation` of layout instances, event sheet strings naming it (counted for a warning) |
| `construct3/json-format.ts` | On-disk text style: detects and reapplies line endings, trailing newline and BOM |
| `construct3/layers.ts` | The layer tree of a layout: walks every layer and nested sub-layer and their instances (non-world instances included), finds layers and instances, compares layer names ignoring case; the analyzers and most layout tools walk layers through it (see `layout-walk.ts`) |
| `construct3/path-utils.ts` | `resolveProjectPath()`: joins path segments and rejects paths that leave the project folder |
| `construct3/png-generator.ts` | Zero-dependency placeholder PNGs and C3 image file names (all lowercase) |
| `construct3/timeline-folders.ts` | The editor's Transitions folder in the timelines container (first nameless first-level folder, files in `timelines/transitions/`), shared by the timeline tools and `validate_project` |
| `construct3/layout-walk.ts` | The older layer and instance walk still used by `reorder_layers`, `move_layer`, `move_instance` and the hierarchy tools; `layers.ts` is used everywhere else |
| `construct3/ease-params.ts` | Custom eases embedded in event parameters, as Construct r495.2 saves them |
| `construct3/tilemap-data.ts` | Codec for a Tilemap instance's tile data |
| `construct3/timeline-model.ts` | Track kinds, track and property-track folders, and custom eases in timeline files |
| `construct3/timeline-properties.ts` | What a property track stores for each kind of property |
| `construct3/file-registration.ts` | Script and project file registration helpers |
| `construct3/types.ts` | TypeScript types for project files and analysis results |
| `runtime/bridge.ts` | Generates the injectable runtime bridge script (`globalThis.__c3bridge`) |
| `runtime/zip-writer.ts` | Zero-dependency ZIP writer used to pack `.c3p` files |
| `runtime/cdp-client.ts` | Persistent Chrome DevTools Protocol connections, bridge calls, input and screenshots |
| `runtime/preview-server.ts` | Serves an exported game over loopback HTTP and launches Chrome or Edge on it |
| `runtime/project-files.ts` | The files a folder project packs into a `.c3p` and writes back to one |
| `runtime/zip-reader.ts` | Dependency-free `.c3p` reader (ZIP64, backslash paths, DEFLATE) |

### 6. Analyzers (`src/construct3/analyzers/`)

A shared cross-reference index and fifteen analysis modules, several of which build on the index:

| Module | Purpose |
|--------|---------|
| `index-builder.ts` | Builds and caches the project-wide cross-reference index |
| `event-flow.ts` | Include hierarchy and layout bindings (Mermaid output); function definitions and call sites |
| `object-deps.ts` | Object usage across event sheets, layouts, families; objects not referenced anywhere |
| `asset-usage.ts` | Sound, music, image, font, video, icon and project file usage (used, unused or not analysed); images follow the index's object usage |
| `animations.ts` | Sprite animation trees as the editor saves them (items and animation subfolders); frame counts for the asset and performance analyses |
| `performance.ts` | Heuristic performance audit (info/warning/critical) |
| `integrity.ts` | `validate_project`: 30 checks, the upstream integrity and load-time checks plus the object image, legacy event key, ACE definition, expression and addon definition checks |
| `load-rules.ts` | Rules the Construct 3 editor enforces when it opens a project (expression syntax, empty parameters, trigger and else placement, name and SID clashes, family plugins); used by `validate_project` and the pre-write checks |
| `legacy-behavior-keys.ts` | Scan and repair of the legacy `"behavior-type"` key |
| `legacy-event-shapes.ts` | Scan and repair of event shapes older versions wrote (block `isElse`, condition `isOr`, old function calls, one-string scripts) |
| `delete-references.ts` | Calls, function map registrations and variable uses that deleting an event would leave pointing at nothing (`delete_event_from_sheet`) |
| `behavior-refs.ts` | Behavior name checks against objects and families |
| `group-settings.ts` | Event group settings (`get_group_settings`) |
| `event-outline.ts` | Editor event numbers, `locate_event` and the paged `get_eventsheet_outline` |
| `runtime-traps.ts` | Signal pairing and order, script/function-parameter traps (`find_runtime_traps`) |
| `script-scan.ts` | Lightweight JS/TS scanner for script actions, used by the runtime trap checks |

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
| Resources | `resources/project.ts` (6), `resources/docs.ts` (3; the pitfalls text lives in `resources/pitfalls.ts`) | 9 | Read-only data access, Construct 3 docs, curated pitfalls |
| Query tools | `tools/query.ts`, `tools/usage-tools.ts` | 15 | List, search, get details, usage queries |
| Analysis tools | `tools/analysis.ts` | 11 | Flow, functions, dependencies, orphans, assets, performance, validation, addon definitions, group settings, event locating, runtime traps |
| Session tools | `tools/session-tools.ts` | 5 | Which project is served, reload, change journal and revert |
| Mutation tools | `tools/*-tools.ts` (18 files, registered by `tools/mutations.ts`) | 140 | Safe create, update, delete, rename, move and replace |
| Runtime tools | `tools/runtime-tools.ts`, `runtime/cdp-client.ts`, `runtime/preview-server.ts`, `runtime/bridge.ts` | 19 | Bridge injection, preview checks, clone and `.c3p` packing, serving an export and launching Chrome on it, persistent CDP connections, live game calls, condition waits, event subscriptions, input dispatch (viewport, canvas or layout coordinates) and screenshots |
| Prompts | `prompts/workflows.ts` | 7 | Workflow templates |

`tools/mutations.ts` only calls the domain modules' `register*Tools()` functions. Shared tool code lives in `tools/shared.ts` (name and subfolder validation, `toolResult` / `toolError`, not-found suggestions, the editor reload note) and `tools/event-helpers.ts` (event Zod schemas, builders, validators and the load-time pre-write check).

## Data Flow

### Read Flow

```
Claude → list_objects({ filter: "btn" })
  → Zod schema validation
  → reader.searchObjects("btn")
  → in-memory filter on the object names mapped at load time
  → JSON response to Claude
```

### Write Flow

```
Claude → create_object({ name: "Enemy", pluginId: "Sprite" })
  → validateName("Enemy")
  → check uniqueness against reader.listObjectTypes()
  → findObjectClassNameClash()      ← same name as an object or family, ignoring case
  → writer.entityFileRefusal(...)   ← no file for the name on disk yet, ignoring case
  → writer.ensureAddonRegistered("plugin", "Sprite")
  → idGen.generateSid() / generateImageSpriteId() (scan all IDs if first use)
  → writer.writeImageFiles(...)     ← placeholder PNG for the first frame
  → build template: createSpriteObject("Enemy", sid, animSid, imageSpriteId)
  → writer.writeEntityFile("objectTypes", "Enemy", data, undefined, { createOnly: true })
      → validateJsonData(data)      ← pre-write check
      → resolveJsonTextStyle(...)   ← keep the file's line endings and BOM
      → createBackup(filePath)      ← refuse if changed on disk since last seen, then .bak copy
      → atomicWrite(filePath, text) ← temp file, then rename
      → verifyWrittenFile(filePath) ← post-write read-back
      → invalidateAll()             ← clear all caches
  → writer.addToProject("objectTypes", "Enemy")
      → take the project lock
      → createBackup(c3proj)
      → add "Enemy" to objectTypes.items
      → upgradeProjectShape(project) ← r495.2 save shape
      → validate + atomic write (text style kept) + verify, then reader.reloadProject() + invalidateAll()
  → toolResult(WriteResult)         ← adds the editorNote
  → the gate appends "Changed N file(s): ..." from the journal entry
    and, for a .c3p, writes the archive back
```

Event sheet writes (`add_event_block`, `update_event_block`, `add_event_to_sheet`, `update_event_block_action`, `move_event_block`, `move_event_block_items`, `move_events_between_sheets`) run one more step before `writeEntityFile`: `checkLoadRulesBeforeWrite()` (for `move_events_between_sheets`, `checkLoadRulesBeforeSheetPairWrite()`) compares the sheet's editor load-time issues before and after the change. A new error refuses the write; new warnings are returned with the result.

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

The mutation tools provide extra context:
- Fuzzy name suggestions ("Did you mean: Player?")
- Reference lists when deletion is blocked
- Warnings for auto-registered addons, unknown plugin properties or new load-time warnings
- An `editorNote` on every response that reports a completed write: close and reopen the project in Construct 3 before saving there

## Security

- **Path traversal protection**: `resolveProjectPath()` rejects any path escaping the project directory
- **Reserved name blocking**: "System" and other C3 reserved names cannot be used
- **Name clash checks**: Names the editor compares ignoring case (event sheets, layouts, object types and families in one name space, layers, animations, event variables, project-bar folders) are refused when they differ from an existing one only in case (`names.ts`)
- **Input validation**: Zod schemas on all tool parameters with length limits
- **Addon gating**: Unknown third-party plugins/behaviors blocked from auto-registration
- **Load-time gate**: The event-editing tools listed under Write Flow reject writes that add an error the editor would refuse at load
- **Size limits**: 5MB maximum for any generated JSON file, 10MB for entity and script files read
- **Loopback by default**: `connect_to_game` accepts only this machine unless `allowRemoteHost` is set, and `serve_preview` binds to loopback, because the bridge runs script in the page it reaches
- **Path redaction**: absolute filesystem paths are removed from error text returned to the client

---

**Last Updated**: 2026-09-28
