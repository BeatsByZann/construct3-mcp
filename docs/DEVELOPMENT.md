# Development Guide

Guide for contributing to and developing the Construct3 MCP Server.

## Prerequisites

- **Node.js** >= 18.0.0 to run the server; the test suite (Vitest 4) needs Node.js 20.19+ (20.x), 22.12+ (22.x) or 24+
- **npm** >= 9.0.0
- **TypeScript** 5.7+
- A Construct 3 project in **folder format** (.c3proj), or a single-file .c3p, for testing

## Setup

```bash
git clone https://github.com/liauw-media/construct3-mcp.git
cd construct3-mcp
npm install
npm run build
```

## Development Commands

```bash
# Build (compile TypeScript to dist/)
npm run build

# Watch mode (auto-rebuild on file changes)
npm run dev

# Run the test suite once (vitest run)
npm test

# Re-run tests on file changes
npm run test:watch

# Test coverage report (src/, without the entry point)
npm run test:coverage

# Start the server with a test project
node dist/index.js /path/to/your/project.c3proj

# Or a single-file project
node dist/index.js /path/to/your/game.c3p

# Or set the environment variable
C3_PROJECT_PATH=/path/to/project npm start
```

## Project Structure

```
construct3-mcp/
├── src/
│   ├── index.ts                    # Entry point: project path (a folder, a .c3proj or a .c3p), server setup, registration, shutdown
│   ├── construct3/                 # Core project logic
│   │   ├── project-reader.ts       # Project file reads, caches, checks for changes on disk
│   │   ├── project-writer.ts       # Safe writes (backup/validate/write/verify), project.c3proj updates, undo of a tool call's writes
│   │   ├── id-generator.ts         # SID/UID/imageSpriteId generation with collision avoidance
│   │   ├── disk-state.ts           # File states on disk, tool call scope, stale-write error
│   │   ├── templates.ts            # Entity templates and known addon maps
│   │   ├── custom-actions.ts       # Custom action definitions and the definition a call runs
│   │   ├── event-shapes.ts         # The event shapes the editor writes (else, OR, calls, scripts)
│   │   ├── instance-behaviors.ts   # Behavior entries on layout instances
│   │   ├── instance-variables.ts   # Instance variable values and effect entries on layout instances
│   │   ├── object-name-references.ts # Where an object type or a family is named (rename_object_type, rename_family)
│   │   ├── entity-copies.ts        # Fresh SIDs, UIDs and image IDs for a copied entity, the checks that refuse an unfaithful copy, an object type's image copies (duplicate tools)
│   │   ├── hierarchy.ts            # Hierarchy (scene graph) links between layout instances
│   │   ├── containers.ts           # Containers in project.c3proj: members, a deleted object type taken out, a container under two members removed
│   │   ├── layer-references.ts     # Event sheet strings that name a layer (update_layer rename)
│   │   ├── event-strings.ts        # Strings of an event sheet that can name something (events, parameters, script lines)
│   │   ├── object-images.ts        # An object type's image files in images/ (kept as .bak on delete)
│   │   ├── animation-rename.ts     # Frame image files and layout instances a rename_animation changes, frame image moves on frame insert, delete, reorder and duplicate
│   │   ├── file-size-limit.ts      # The size limit: C3MCP_MAX_FILE_MB, 10MB by default, whole megabytes up to 128
│   │   ├── json-format.ts          # On-disk text style (line endings, trailing newline, BOM)
│   │   ├── entity-name-references.ts # Where an event sheet or a layout is named (rename_event_sheet, rename_layout)
│   │   ├── layers.ts               # Layer trees: every layer and sub-layer, their instances, layer names
│   │   ├── atomic-write.ts         # Temp-file-and-rename writes that keep file names on disk
│   │   ├── names.ts                # Case-insensitive name and folder comparison
│   │   ├── flowchart-model.ts      # Flowchart file shape and the in-memory changes of the flowchart tools
│   │   ├── flowchart-files.ts      # Reading, writing, creating and deleting flowchart files and their project.c3proj entry
│   │   ├── event-variable-names.ts # Editor name rules for event variables, function parameters and function names
│   │   ├── fs-errors.ts            # fs errors in messages: the code and the path in the project
│   │   ├── path-utils.ts           # Path resolution inside the project folder
│   │   ├── png-generator.ts        # Zero-dep placeholder PNGs and image file names
│   │   ├── c3p-archive.ts          # A .c3p project's working folder: unpack, refresh, write back, conflict
│   │   ├── project-source.ts       # The project path: a folder, a .c3proj or a .c3p
│   │   ├── raw-text-search.ts      # Streamed whole-word text search and UID/SID scan in files the reader skips
│   │   ├── script-files.ts         # The script files a project registers, walked once for the index, the runtime-trap check and the usage queries
│   │   ├── ace-types.ts            # Types of the ACE catalogue, addon definitions and the project data the checks read
│   │   ├── ace-catalog-source.ts   # Builds an ACE catalogue from the editor's files; its cache file, fetch and build script entry
│   │   ├── ace-catalog-provider.ts # Hands out the catalogue of a release: local copy, cache or fetch, with the fallback release
│   │   ├── ace-catalog.ts          # Checks a condition or action against a catalogue (validate_project, event tool warnings)
│   │   ├── addon-definitions.ts    # Third-party addon definitions (addon.json, aces.json) read from folders and .c3addon archives
│   │   ├── expression-check.ts     # Parses the expressions in ACE parameters and resolves their names
│   │   ├── event-change-check.ts   # Warnings an event tool adds for the conditions and actions it wrote
│   │   ├── timeline-folders.ts     # The editor's Transitions folder in the timelines container
│   │   ├── timeline-model.ts       # Track kinds, track folders and custom eases inside timeline files
│   │   ├── timeline-properties.ts  # What a property track stores for each kind of property
│   │   ├── timeline-result-modes.ts # Which result mode is in force for a keyframe, and how stored values follow a change
│   │   ├── ease-params.ts          # Custom eases inside event sheet ease parameters
│   │   ├── registered-file-entries.ts # Scripts, sounds and music files the project registers
│   │   ├── tilemap-data.ts         # Codec for a Tilemap instance's tile data string
│   │   ├── project-tree.ts         # Project Bar trees: finding, creating and registering folders and items, folder path checks (move and duplicate tools)
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/              # Analysis modules
│   │       ├── index-builder.ts    # Cross-reference index (cached per reader)
│   │       ├── event-flow.ts       # Event sheet include hierarchy and layout bindings, function map
│   │       ├── object-deps.ts      # Object dependencies, orphaned and unanalysed objects
│   │       ├── asset-usage.ts      # Asset usage tracking
│   │       ├── animations.ts       # Sprite animation trees (items + subfolders)
│   │       ├── event-outline.ts    # Editor event numbers, event sheet outline
│   │       ├── performance.ts      # Performance heuristics
│   │       ├── integrity.ts        # Project integrity checks (validate_project)
│   │       ├── load-rules.ts       # Editor load-time rules (validate_project, pre-write checks)
│   │       ├── legacy-behavior-keys.ts # Legacy "behavior-type" key scan and repair
│   │       ├── legacy-event-shapes.ts # Legacy isElse/isOr/function call/script shape scan and repair
│   │       ├── delete-references.ts # Function and variable names an event or sheet delete would leave dangling
│   │       ├── variable-renames.ts # The uses of an event variable a rename updates, and those it lists
│   │       ├── unscanned-uses.ts   # Possible uses in registered files the bulk reads skipped
│   │       ├── behavior-refs.ts    # Behavior name checks against objects and families
│   │       ├── effect-uses.ts      # Conditions and actions that name an effect of their object (family effect checks)
│   │       ├── group-settings.ts   # Event group settings (get_group_settings)
│   │       ├── runtime-traps.ts    # Signal pairing and order, script/parameter traps
│   │       └── script-scan.ts      # Lightweight JS/TS scanner for script actions
│   ├── resources/                  # MCP resource handlers
│   │   ├── project.ts              # Project data resources (6)
│   │   ├── docs.ts                 # Documentation resources (3)
│   │   └── pitfalls.ts             # Curated pitfalls text (construct3://docs/pitfalls)
│   ├── runtime/                    # Runtime bridge, CDP client, preview server
│   │   ├── bridge.ts               # Injectable runtime bridge script generator
│   │   ├── cdp-client.ts           # CDP client: game connections, bridge calls, input, screenshots
│   │   ├── preview-server.ts       # Loopback server for exported games, browser launch
│   │   ├── project-files.ts        # The files of a folder project (pack_project, .c3p write-back)
│   │   ├── zip-reader.ts           # Zero-dep ZIP reader for .c3p archives (ZIP64, DEFLATE, backslash paths)
│   │   └── zip-writer.ts           # Zero-dep ZIP writer for .c3p archives (pack_project, .c3p write-back)
│   ├── tools/                      # MCP tool handlers
│   │   ├── query.ts                # Query tools (9)
│   │   ├── analysis.ts             # Analysis tools (11)
│   │   ├── usage-tools.ts          # Usage queries (6)
│   │   ├── mutations.ts            # Registers the domain tool modules below
│   │   ├── object-rename.ts        # Object type and family renames with their references (2)
│   │   ├── replace-tools.ts        # Replace object and find-and-replace tools (2)
│   │   ├── structure-tools.ts      # Project Bar move tool (1)
│   │   ├── duplicate-tools.ts      # Duplicate tools (5)
│   │   ├── shared.ts               # Validation, result/error helpers, editor reload note
│   │   ├── call-rollback.ts        # Rollback of a tool call whose write failed
│   │   ├── rename-files.ts         # Rename side writes (timelines, images, view state), file creation for a call (createFileForCall), their rollback, script file search
│   │   ├── side-files.ts           # Rollback of a Project Bar move or copy: created files are removed only once project.c3proj is back
│   │   ├── project-sync.ts         # withProjectSync: each handler in a tool call scope, after a check of project.c3proj on disk
│   │   ├── archive-sync.ts         # withArchiveSync: a .c3p refreshed before the calls, written back after
│   │   ├── object-tools.ts         # Object and family tools (8)
│   │   ├── instance-sync.ts        # Sync of layout instances with their object types and families
│   │   ├── event-tools.ts          # Event sheet tools (19)
│   │   ├── event-helpers.ts        # Event Zod schemas, builders, validators, load-time gate
│   │   ├── layout-tools.ts         # Layout, layer and instance tools (9)
│   │   ├── layer-rename.ts         # rename_layer: a layer renamed in several layouts in one call (1)
│   │   ├── effect-tools.ts         # Effect tools (5)
│   │   ├── animation-tools.ts      # Sprite animation and frame tools (8)
│   │   ├── container-tools.ts      # Container tools (4)
│   │   ├── timeline-tools.ts       # Timeline tools (5)
│   │   ├── layer-order.ts          # Layer and instance order tools (4)
│   │   ├── entity-rename.ts        # Event sheet and layout renames with their references (2)
│   │   ├── bulk-instance-tools.ts  # Bulk instance tools (3)
│   │   ├── timeline-instance-tools.ts  # Instance track and keyframe tools (7)
│   │   ├── timeline-track-tools.ts  # Value and audio track and track folder tools (7)
│   │   ├── timeline-ease-tools.ts  # Custom ease tools (4)
│   │   ├── timeline-kit.ts         # Types the timeline tool modules share
│   │   ├── timeline-writes.ts      # Refusals, relative paths and rollback for the timeline tools
│   │   ├── tilemap-data-tools.ts   # Tilemap tile data tools (3)
│   │   ├── tilemap-brush-tools.ts  # Tilemap brush tools (4)
│   │   ├── tilemap-support.ts      # Refusals, name checks and path-free messages the tilemap tools share
│   │   ├── project-tools.ts        # Project metadata and addon tools (4)
│   │   ├── hierarchy-tools.ts      # Hierarchy link tools (2)
│   │   ├── flowchart-tools.ts      # Flowchart tools (13)
│   │   ├── template-tools.ts       # Instance template tools (3)
│   │   └── runtime-tools.ts        # Runtime control tools (19)
│   └── prompts/                    # MCP prompt handlers
│       └── workflows.ts            # Workflow prompts (7)
├── test/                           # Vitest suites
│   ├── construct3/                 # Reader, writer, templates and analyzer tests
│   ├── tools/                      # Tool handler tests (through the mock server)
│   ├── resources/                  # Resource and prompt tests
│   ├── runtime/                    # Runtime bridge, CDP client and preview server tests (live-browser.test.ts needs Chrome or Edge)
│   ├── helpers/                    # Fake Construct export and WebSocket server for the runtime tests, file-system case check
│   ├── acceptance/                 # End-to-end round trip through the tool handlers
│   ├── mocks/                      # Mock MCP server, reader, writer, ID generator
│   └── fixtures/                   # Small Construct 3 projects used by the tests
├── scripts/
│   ├── build-ace-catalog.mjs       # Developer script: builds one release's ACE catalogue cache file (see ACE Catalogue)
│   └── derive-minimal-fixture.ts   # Maintainer script: derives the loadable minimal fixture
├── docs/                           # Documentation
├── dist/                           # Compiled output (gitignored)
├── package.json
├── tsconfig.json                   # Build config (src/ → dist/)
├── tsconfig.test.json              # Type-check config that includes test/
├── vitest.config.ts
├── CHANGELOG.md
└── README.md
```

## Key Patterns

### Adding a New Query Tool

1. Open `src/tools/query.ts`
2. Add a `server.tool()` call inside `registerQueryTools()`:

```typescript
server.tool(
  'my_tool_name',
  'Description of what the tool does',
  {
    param: z.string().max(200).describe('Parameter description'),
  },
  async (args) => {
    try {
      const result = await reader.someMethod(args.param);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
```

### Adding a New Analysis Tool

1. Create an analyzer in `src/construct3/analyzers/my-analyzer.ts`
2. Export an async function that takes `reader` and options
3. Register the tool in `src/tools/analysis.ts`, returning `toolResult()` / `toolError()` from `shared.ts`
4. The analyzer can use `getProjectIndex(reader)` for cross-reference data

### Adding a New Mutation Tool

1. Add the tool to the domain module it belongs to (`object-tools.ts`, `event-tools.ts`, `layout-tools.ts`, `bulk-instance-tools.ts`, `animation-tools.ts`, `timeline-tools.ts`, `flowchart-tools.ts`, `tilemap-data-tools.ts`, `tilemap-brush-tools.ts` or `project-tools.ts`), inside its `register*Tools(deps)` function. A new domain gets its own module, registered in `src/tools/mutations.ts`.
2. Follow the safety pattern:
   - Validate inputs (use `validateName()`, `validateSubfolder()`)
   - For new object type or family names, check `findObjectClassNameClash()` (names clash ignoring case)
   - Check addon registration with `writer.ensureAddonRegistered()`
   - Generate IDs with `idGen.generateSid()` / `idGen.generateUid()`
   - Build data from templates in `templates.ts`
   - For event sheet changes, call `checkLoadRulesBeforeWrite()` and refuse the write when it reports errors
   - Write with `writer.writeEntityFile()` (handles backup/validate/verify)
   - Update c3proj with `writer.addToProject()` if needed
   - Return a `WriteResult` through `toolResult()`, which adds the `editorNote` to completed writes
3. Add tests in `test/tools/` that call the handler through `test/mocks/mock-server.ts`

`server.tool()` takes a raw shape, which the MCP SDK wraps in an object schema that drops unknown arguments. A tool whose mistyped arguments would lose content (as `add_event_block`, `update_event_block` and `add_event_to_sheet`) is registered with `server.registerTool(name, { description, inputSchema: z.object({ ... }).strict() }, handler)` instead: the SDK parses the arguments with that schema as it is, so unknown ones are refused. The mock server handles both.

### Adding a New Template

1. Open `src/construct3/templates.ts`
2. Add a builder function that returns `Record<string, unknown>`
3. Validate all field names against a real C3 project file — C3 uses a mix of camelCase (`isGlobal`) and kebab-case (`plugin-id`)
4. Export and use it in the tool module that needs it

## C3 File Format Notes

Key things to know when working with Construct 3 project files:

- **SIDs** are ~15-digit random integers. The editor refuses to open a project in which two object types or families share a SID, and its loader also checks function parameter SIDs; duplicates among events, conditions, actions and layout instances are common in editor-saved projects and open fine (see `classifySidDuplicate()` in `load-rules.ts`). New SIDs from `IdGenerator` are still checked against every SID in the project; events moved by `move_events_between_sheets` keep theirs, copies get new ones. Look events up with `findEventsBySid` / `resolveEventBySid` in `src/tools/event-helpers.ts`, never with a first-match `find(e => e.sid === sid)`
- **UIDs** are sequential integers, only on layout instances and singleglobal-inst objects
- **Names**: the editor compares event sheet, layout, object type/family, layer, animation, event variable and project-bar folder names ignoring case (timeline names exactly; the flowchart tools take flowchart names only as registered, since the editor's comparison is not recorded); entity files are named after the entity, so names that differ only in case share one file on Windows and macOS. Compare with `findNameClash` / `findFolderPathClash` in `names.ts`
- **Cross-references are by NAME** — event sheets reference objects as `"objectClass": "Name"`, layouts as `"type": "Name"`
- **c3proj containers** use `{ items: string[], subfolders: Subfolder[] }` recursive structure
- **usedAddons** in c3proj must list every plugin, behavior, and effect used
- **Global plugins** (Audio, AJAX, Mouse, etc.) use `singleglobal-inst` instead of layout placement
- **Layout instances** carry a `behaviors` entry (`{ properties: {...} }`) for every behavior of their object type and of its families, family behaviors first (`instance-behaviors.ts`), a value in `instanceVariables` for every instance variable of the object and its families, family variables first, and an `effects` entry per effect (`instance-variables.ts`)
- **Hierarchies**: both sides of a link are stored in `sceneGraphData` (the child's `"parent-uid"`, the parent's `children` entry), by UID; a tool that removes instances removes the links to them (`hierarchy.ts`)
- **Image files** are named `images/<object>-<animation>-<frame, 3 digits>.png` (TiledBg: `images/<object>.png`), the whole name lowercased; `.jpg` for a JPEG frame. The number is the frame's index, so inserting or deleting a frame renames the image files of the frames after it (`planFrameImageShift` in `animation-rename.ts`)
- **Event shapes** follow editor-saved sheets (`event-shapes.ts`): Else is a System `else` condition at index 0 (conditions after it make an else-if), an OR block has `"isOrBlock": true` on the event, a function call is `{ callFunction, sid, parameters: [positional arguments] }` without `id`/`objectClass`, and a script action is `{ type: "script", language: "javascript", script: [lines] }`. Never write the block-level `isElse` or per-condition `isOr` keys older versions wrote
- **Behavior conditions/actions** name their behavior under `behaviorType`; a condition or action that names its behavior only under the legacy `behavior-type` key makes the editor refuse to open the project (a leftover `behavior-type` next to a valid `behaviorType` is ignored)
- **Timelines** are stored under `timelines/`, in folders that mirror their project-bar folders. The first nameless first-level subfolder of the container is the editor's Transitions folder: its items are transitions, stored in `timelines/transitions/` (`timeline-folders.ts`); a nameless folder anywhere else is malformed
- **Flowcharts** are stored under `flowcharts/`, in folders that mirror their project-bar folders, and registered in the `flowcharts` container of `project.c3proj`. They are not entity files of the writer: `flowchart-files.ts` reads them through the reader and writes them with `replaceFile` and the state they were read in, and registers them with `updateProject`. A folder without a name is not resolved.
- **JSON formatting**: C3 uses tab indentation (`\t`), LF line endings, no trailing newline and no BOM. Existing files keep whatever style they have on disk (e.g. CRLF from a git `core.autocrlf` checkout)
- **Field naming**: Mostly camelCase for object properties (`isGlobal`, `behaviorTypes`), kebab-case for some identifiers (`plugin-id`, `initially-visible`)

## Cache Invalidation

After any write operation the cached state must follow the new content:

1. **Reader caches** — `reader.invalidateCaches()` clears entity caches
2. **Project index** — `resetProjectIndex(reader)` clears the cross-reference index of that reader's project
3. **ID generator** — `idGen.noteWrittenText(text)` adds the IDs in the written file; the generator keeps its scan (`idGen.reset()` would force a full rescan)
4. **File state** — `reader.noteOwnWrite(path, state)` records the file's new state, so the next tool call does not take the write for a change made outside the server

The writer's `afterOwnWrite()` handles all four for its entity writes. The `addToProject()` and `removeFromProject()` methods also call `reader.reloadProject()` which re-reads the c3proj file and records its state. A tool that writes project files itself (the runtime bridge tools write `project.c3proj` and script files) calls `writer.afterDirectWrites(writes)` after its writes, which does the same for those files and loads `project.c3proj` again (as its own write only while the file holds the text written), and takes a new SID from `writer.generateSid()` before it reads `project.c3proj`: the first ID request after a change on disk scans the whole project, and a save of `project.c3proj` during that scan would be written over. `reader.loadProject()` alone is not enough: it records the file's new state, so no change on disk is found and the index and the ID generator keep what they built from the old file.

**Changes made outside the server (#51).** Register tools, resources and prompts through `withProjectSync(server, reader)` (`tools/project-sync.ts`; every `register*` function does): each handler then runs as a tool call scope and first checks `project.c3proj` on disk (`reader.checkProjectFile()`). The files the caches hold are checked the first time the call uses a bulk read, the index or the ID generator (`reader.ensureCachesFresh()`); a change drops the cached state and moves `reader.getDiskEpoch()`, on which the index and the ID generator rebuild. Inside the scope the writer backs each file up once per call and refuses (`StaleFileError`) to write a file whose state on disk differs from the state the call read it in. Outside a tool call scope (scripts, direct reader use) the caches are not checked by themselves: call `reader.syncWithDisk()` after changing files outside the reader. The writer's check still applies there, against the state the reader last read or wrote the file in. A tool that updates `project.c3proj` without the writer calls `writer.assertProjectFileCurrent()` before its first write (a file written before it would stay when it refuses), and again right before it writes `project.c3proj` when anything that takes time runs in between (the runtime bridge tools do, and undo their earlier writes on a refusal). The writer's own `project.c3proj` updates go through `updateProjectFile()`: they take a change made on disk in (`reader.checkProjectFile()`) and merge into it instead of refusing, because they run after the tool wrote other files. The scope also records each file the call changed through the writer; when a later write of the call is refused as stale, the writer puts those files back from their backups before it throws (`undoCallChanges`), so a refused call changes nothing. Files written through `replaceFile` or `deleteFile` keep a `.bak` but are not put back by `undoCallChanges` when a later write of the call is refused. A tool that writes a project file other than an entity file uses `writer.replaceFile()`, `writer.deleteFile()`, `writer.restoreForCall()` or `writer.updateProject()`, which take the file's one lock (the project lock for `project.c3proj`); `test/tools/direct-write-guard.test.ts` fails on a raw write under `src/tools/`.

`getProjectIndex(reader)` caches one index per reader, so a script, test or embedding can open several projects in one process: give each project its own reader, writer and `IdGenerator` (a generator scans the project of the reader it is first called with), and open each project with one reader only: a second reader on the same project sees the other's writes neither in its caches nor in its index. A write through the writer or the event tools resets only its own project's index; `resetProjectIndex()` without a reader resets every project's index, which tests use between cases. The MCP server opens one project per process.

## ACE Catalogue

`validate_project` and the event tools check conditions, actions and expressions against a catalogue of what Construct defines for one release. No catalogue is committed to this repository, and `.gitignore` keeps one out (`src/construct3/ace-catalog-data.ts`, `/ace-catalog/`): the server builds it on first use and caches it per user. The code is in `ace-catalog-source.ts` (build, fetch, cache), `ace-catalog-provider.ts` (which release, from where) and `ace-catalog.ts` (the checks); see Validation in [ARCHITECTURE.md](ARCHITECTURE.md).

### What the catalogue is (data, source, where it lives)

| Question | Answer |
|---|---|
| Content | Per plugin and behavior of one release: each condition and action id with, per parameter, the id, the type and (combo) the item ids; each expression's name, parameter types, a variadic flag and the return type; the common ACEs the editor adds to plugin objects. No display names, descriptions, help text, scripts or code |
| Source | Three files the server requests from `https://editor.construct.net/<release>/`: `plugins/allAces.json`, `.../behaviors/allAces.json` and `.../main.js` (the common ACEs, read out of object literals by `literalToJson`). Nothing derived from them is committed |
| When it is built | The first time in a server process that `validate_project` or an event tool's check needs the catalogue for a release, never at server start; one attempt per release per process, success or failure |
| Which release | The project's `savedWithRelease` (`Construct3Project.savedWithRelease: number`; `49502` is `r495-2`) when the three files can be fetched for it. When they cannot, or the project records none, the fallback `FALLBACK_RELEASE = 'r495-2'` (in `ace-catalog-source.ts`), with one info issue saying which release was used and why |
| Where it lives | One JSON file per release, `<cache>/<release>.json`, `<cache>` being `C3_ACE_CACHE_DIR` when set, else `%LOCALAPPDATA%\construct3-mcp\ace-catalog` (Windows), `~/Library/Caches/construct3-mcp/ace-catalog` (macOS), `$XDG_CACHE_HOME/construct3-mcp/ace-catalog` or `~/.cache/construct3-mcp/ace-catalog` (others): per user, outside every project and the repository |
| Offline use | `C3_ACE_SOURCE_DIR=<folder>` holding `<release>/plugins/allAces.json`, `<release>/behaviors/allAces.json`, `<release>/main.js` (the URL's own layout): the server then reads only that folder, never the network, and writes no cache. Without it and without network, the ACE and expression checks are skipped with one info issue |
| Developer tool | `node scripts/build-ace-catalog.mjs <release> [--from <folder>] [--out <file>]` (after `npm run build`) builds the same cache file with the server's own module and prints its counts; it can fill the cache before going offline |
| Trust | A catalogue is used only when every common-ACE registration the build recognised could be read, the result passes the shape check, and, read back from the cache, its stored digest matches. A redirect is followed only to the same file of the same release on the same host, so a catalogue labelled with a release holds that release's files. The digest detects a damaged or hand-edited cache file, not a deliberate edit by someone who also recomputes it (anyone who can write the cache folder can also run the server) |
| Currency | The catalogue is what the server fetched for that release at the time it was built; a valid cache file is reused for its release and never refreshed, and deleting it forces a rebuild (after the next server start, because each release is tried once per process). One live run of `scripts/build-ace-catalog.mjs` on 2026-11-04 for `r495-2` fetched all three files and built a catalogue of 72 plugins, 32 behaviors, 1,916 ACEs and 85 common ACEs in 621 ms; a release name that is not a release (`r999-9`) was refused as not served. That run says nothing about other releases |

### The cache file

`<cache>/<release>.json` holds `{ format, sourceRelease, digest, catalog }`: `format` is `CACHE_FORMAT` (in `ace-catalog-source.ts`), `sourceRelease` the release the files were fetched for, `digest` the SHA-256 (hex) of the catalogue's JSON, and `catalog` the catalogue. A file is used only when it is at most 16MB, parses, has the current `format`, has `sourceRelease` and `catalog.release` equal to the release asked for, passes the catalogue shape check, and its `digest` matches the catalogue. A file that fails a check is named on stderr, not used even in part, and replaced by the next successful build. A file is written through a temporary file in the same folder and a rename, so another process sees the old file or the new one. Raise `CACHE_FORMAT` whenever the transform's output changes (a field added, removed or read differently), so that files an older transform wrote are rebuilt instead of trusted.

### Building a cache file by hand

```bash
npm run build
node scripts/build-ace-catalog.mjs r495-2                      # fetch from editor.construct.net, write the default cache folder
node scripts/build-ace-catalog.mjs r495-2 --from ./editor-copy # read <folder>/r495-2/... instead; no network
node scripts/build-ace-catalog.mjs r495-2 --out ./tmp/r495-2.json
```

The script runs the server's own module (`dist/construct3/ace-catalog-source.js`), so run `npm run build` first. It needs the network unless `--from` is given, and writes only the cache file (`--out` must name a file called `<release>.json`). It prints a `Wrote <path>` line, the size of each source file, the counts of the catalogue and the time it took; it exits 1, without a `Wrote` line, when the sources were refused or the file could not be written, and 2 for a usage error.

### Tests and the catalogue

The tests run on a hand-written copy of the source files, `test/fixtures/ace-source/<release>/` (in the editor's layout), and on `TEST_CATALOG` (`test/fixtures/ace-catalog.ts`), use an injected fetch (`test/construct3/ace-fetch-stub.ts`) and never use the network: `guardNetwork()` makes `globalThis.fetch` throw in the test files that build a provider. `vitest.config.ts` sets `C3_ACE_SOURCE_DIR` to the fixture folder and `C3_ACE_CACHE_DIR` to a temporary folder, so a test that reaches the process's default provider reads the fixture and writes nothing into a user's cache. The fixtures hold only the ACEs, parameters and expressions the tests need; a new test fact is added to both the source fixture and `TEST_CATALOG` by hand.

## Testing

The Vitest suite (`test/**/*.test.ts`) runs without Construct 3 and without network access:

```bash
npm test                              # all suites
npx vitest run test/tools             # one folder
npx vitest run --maxWorkers=2         # fewer workers on low-memory machines
```

- Tool tests register the real handlers on the mock server in `test/mocks/mock-server.ts` and call them with `callTool()`.
- The runtime connection tests talk to fake CDP endpoints on 127.0.0.1 (`test/helpers/ws-server.ts` is a small WebSocket server for them); the generated bridge runs for real in `node:vm`. `test/runtime/live-browser.test.ts` runs the tools against a real headless Chrome or Edge (from `CHROME_PATH` or the usual install locations) and a fake Construct export (`test/helpers/fake-c3-export.ts`, page and worker variants); without a browser it is skipped with a note in the output. It uses port 9222 when free, to check that nothing contacts another program there. `preview-server-files.test.ts` and `launch-browser-errors.test.ts` mock `node:fs/promises` and `node:child_process` (`vi.mock`) to play what cannot be timed for real: a file that vanishes between the path check and the read, and a browser whose start fails only after `spawn()` returned. `launch-browser-close.test.ts` plays the browser process and the clock (fake timers) to check how closing a launched browser ends it: a browser that ends on the kill is waited for only until it has exited, and one that ignores it gets SIGKILL after 2 s. The live test bounds a real shutdown only loosely (6 s), because a loaded machine stretches the removal of the browser profile to seconds.
- Tests that write copy a fixture from `test/fixtures/` to a temporary folder first; the committed fixtures are never changed.
- Fixtures contain no proprietary content: `minimal-project` is hand-written, `c3-loadable-minimal` was derived with `scripts/derive-minimal-fixture.ts` and opened in the editor (its uniqueId, SIDs, version, layer names and a layer color were replaced with generated or default values afterwards, as the script now does; that version has not been reopened in the editor yet), and `runtime-traps-real` holds event sheets from public MIT-licensed projects (sources in its README).

Tests prove what the files look like, not that Construct 3 accepts them. Before a release, also run the server against a real C3 project:

1. Build: `npm run build`
2. Start with a test project: `node dist/index.js /path/to/test-project`
3. Connect via Claude Code or Claude Desktop
4. Run through the checklist below, then close and reopen the project in the Construct 3 editor and check that it opens

### Manual Test Checklist

**Query tools:**
- [ ] `list_objects` with and without filter
- [ ] `get_object_details` with valid and invalid names
- [ ] `get_project_summary`

**Analysis tools:**
- [ ] `get_eventsheet_flow` in mermaid and JSON format
- [ ] `find_orphaned_objects`
- [ ] `analyze_performance`
- [ ] `validate_project`
- [ ] `locate_event` and `get_eventsheet_outline` for a sheet open in the editor
- [ ] `find_runtime_traps`

**Mutation tools:**
- [ ] `create_object` with Sprite, Text, and global plugin
- [ ] `update_object_properties` adding variables and behaviors
- [ ] `update_object_properties` and `update_family` removing a variable, behavior or member that events use, with and without force
- [ ] `create_event_sheet` with includes
- [ ] `add_event_to_sheet` for each event type
- [ ] `create_layout` with custom layers
- [ ] `add_instance_to_layout`
- [ ] `delete_object` with and without force
- [ ] `delete_family` with and without force
- [ ] `delete_event_sheet` with and without force
- [ ] `delete_layout` on non-first layout
- [ ] `delete_layout` on first layout (must block)
- [ ] `update_layout` changing eventSheet, width, height
- [ ] `update_project_metadata`
- [ ] `add_event_block` with conditions, actions, and group path
- [ ] `add_animation_to_sprite` on an existing Sprite
- [ ] `update_animation_properties` (speed, looping, ping-pong)
- [ ] `create_timeline` in a subfolder, then `update_timeline` and `delete_timeline`
- [ ] `create_flowchart`, `add_flowchart_node`, `add_flowchart_output`, `connect_flowchart_nodes`, then `delete_flowchart`
- [ ] Verify `.bak` backup files are created
- [ ] Verify written files keep their line endings (no whole-file diffs in git)
- [ ] Verify all read tools still work after writes

**Safety tests:**
- [ ] Path traversal: `create_object({ name: "../../evil" })` — must reject
- [ ] Reserved name: `create_object({ name: "System" })` — must reject
- [ ] Global on layout: `add_instance_to_layout` with Audio object — must reject
- [ ] Unknown plugin: `create_object({ pluginId: "NonExistent" })` — must reject
- [ ] Duplicate name: `create_object` with existing name — must reject
- [ ] Case-only clash: `create_object` with an existing family's name in other case — must reject
- [ ] Load-time gate: `add_event_block` with an unterminated string in an expression — must reject
- [ ] Layout over the size limit (10MB by default): `add_instance_to_layout` on another layout allocates a UID above the big layout's, `validate_project` returns `complete: false` with the file in `unscannedFiles`

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes, build and test: `npm run build && npm test`
4. Test against a real C3 project
5. Commit with clear message
6. Push and open a Pull Request

### Code Style

- TypeScript strict mode
- No `any` types — use `unknown` with type guards
- All tool handlers must catch errors and return structured responses
- Mutation tools must follow the backup/validate/write/verify pattern
- Use existing helper functions (`validateName`, `toolResult`, `toolError`)
- Keep test data synthetic: no content from private projects in code, tests or fixtures

---

**Last Updated**: 2026-09-26
