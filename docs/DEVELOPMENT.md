# Development Guide

Guide for contributing to and developing the Construct3 MCP Server.

## Prerequisites

- **Node.js** >= 18.0.0 to run the server; the test suite (Vitest 4) needs Node.js 20.19+ (20.x), 22.12+ (22.x) or 24+
- **npm** >= 9.0.0
- **TypeScript** 5.7+
- A Construct 3 project in **folder format** (.c3proj) for testing

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

# Or set the environment variable
C3_PROJECT_PATH=/path/to/project npm start
```

## Project Structure

```
construct3-mcp/
├── src/
│   ├── index.ts           # Entry point: session start, gate, registration
│   ├── error-messages.ts  # Path redaction for client-visible errors
│   ├── construct3/        # Project logic: reader, writer, ID generator, templates,
│   │                      # session and .c3p serving, change journal, project shape,
│   │                      # atomic writes and text style, event shapes, names, layers,
│   │                      # instance behavior entries, animation renames,
│   │                      # ACE catalogue, addon definitions, expression checker,
│   │                      # references, timelines, tilemaps
│   │   └── analyzers/     # Index, event flow, object dependencies, assets, animations,
│   │                      # performance, integrity (validate_project), load-time rules,
│   │                      # legacy key and shape repair, delete references, behavior
│   │                      # references, group settings, event outline, runtime traps
│   ├── resources/         # MCP resources (9), including the curated pitfalls doc
│   ├── runtime/           # Bridge script, CDP client, preview server, zip reader/writer
│   ├── tools/             # MCP tools (190 in 23 files; mutations.ts registers the
│   │                      # 18 mutation-tool files)
│   └── prompts/           # MCP prompts (7)
├── scripts/               # build-ace-catalog.mjs, editor-coverage.mjs and its mapping,
│                          # derive-minimal-fixture.ts
├── test/                  # Vitest: unit tests by area, *.integration.test.ts against
│   │                      # copied fixtures, runtime tests against a vm harness
│   ├── mocks/             # Mock MCP server, reader, writer, ID generator
│   └── fixtures/          # Small projects; several saved by Construct r495.2
├── docs/                  # API, architecture, development, examples, troubleshooting
├── FORK.md                # How this fork differs from upstream
├── tsconfig.json          # Build config (src/ → dist/)
├── tsconfig.test.json     # Type-check config that includes test/
├── vitest.config.ts
├── CHANGELOG.md
└── README.md              # Includes the per-file source listing
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

1. Add the tool to the area's `src/tools/<area>-tools.ts`, inside its `register*Tools(deps)` function; `src/tools/mutations.ts` registers every area file, and a new area gets its own module registered there
2. Follow the safety pattern:
   - Validate inputs (use `validateName()`, `validateSubfolder()`)
   - For new object type or family names, check `findObjectClassNameClash()` (names clash ignoring case)
   - Check addon registration with `writer.ensureAddonRegistered()`
   - Generate IDs with `idGen.generateSid()` / `idGen.generateUid()`
   - Build data from templates in `templates.ts`
   - For event sheet changes, call `checkLoadRulesBeforeWrite()` and refuse the write when it reports errors
   - Look events up by SID with `resolveEventBySid()` (with an `eventPath` argument) and place them with `resolveContainer()`, which refuse a SID several events share
   - Write with `writer.writeEntityFile()` (handles stamp check, backup, validate, atomic write, text style, verify and the change journal)
   - Change `project.c3proj` through `writer.addToProject()` or `writer.mutateProjectJson()`, which also apply the r495.2 save shape (`project-shape.ts`) and keep the file's text style. A tool that writes `project.c3proj` itself must call `upgradeProjectShape()` first. Any tool that writes a project file itself backs it up with `backupOnce()` and records the write with `recordWrite()` or `recordDelete()` (all in `change-journal.ts`), as the timeline, flowchart and container tools do; an unrecorded write is missing from the call's changed-files line and is not undone by `revert_last_change`
   - Return a `WriteResult` through `toolResult()`, which adds the `editorNote` to completed writes; pass `{ projectWritten: false }` when a successful result wrote nothing
3. Add tests in `test/tools/` that call the handler through `test/mocks/mock-server.ts`
4. Add the tool to `docs/API.md`, the README tool tables and source tree counts, `FORK.md` and `CHANGELOG.md` (`test/docs/tool-docs.test.ts` checks the README and API.md against the registered tools), and map it in `scripts/editor-coverage.json` where it reproduces an editor checklist item (a test refuses an unregistered tool name there)

`server.tool()` takes a raw shape, which the MCP SDK wraps in an object schema that drops unknown arguments. A tool whose mistyped arguments would lose content (as `add_event_block` and `update_event_block`) is registered with `server.registerTool(name, { description, inputSchema: z.object({ ... }).strict() }, handler)` instead: the SDK parses the arguments with that schema as it is, so unknown ones are refused. The mock server handles both.

### Adding a New Template

1. Open `src/construct3/templates.ts`
2. Add a builder function that returns `Record<string, unknown>`
3. Validate all field names against a real C3 project file — C3 uses a mix of camelCase (`isGlobal`) and kebab-case (`plugin-id`)
4. Export and use it in the tool module that needs it

## C3 File Format Notes

Key things to know when working with Construct 3 project files:

- **SIDs** are ~15-digit random integers. The editor refuses to open a project in which two object types or families share a SID, and its loader also checks function parameter SIDs; duplicates among events, conditions, actions and layout instances are common in editor-saved projects and open fine (see `classifySidDuplicate()` in `load-rules.ts`). New SIDs from `IdGenerator` are checked against every SID in the project; events copied by `move_events_between_sheets` get fresh ones, while moved events keep theirs. Look events up with `findEventsBySid` / `resolveEventBySid` in `src/tools/event-helpers.ts`, never with a first-match `find(e => e.sid === sid)`
- **UIDs** are sequential integers, only on layout instances and singleglobal-inst objects
- **Names**: the editor compares event sheet, layout, object type/family, layer, animation, event variable and project-bar folder names ignoring case (timeline names exactly); entity files are named after the entity, so names that differ only in case share one file on Windows and macOS. Compare with `findNameClash` / `findFolderPathClash` in `names.ts`
- **Cross-references are by NAME** — event sheets reference objects as `"objectClass": "Name"`, layouts as `"type": "Name"`
- **c3proj containers** use `{ items: string[], subfolders: Subfolder[] }` recursive structure
- **usedAddons** in c3proj must list every plugin, behavior, and effect used
- **Global plugins** (Audio, AJAX, Mouse, etc.) use `singleglobal-inst` instead of layout placement
- **Layout instances** carry a `behaviors` entry (`{ properties: {...} }`) for every behavior of their object type and of its families, family behaviors first (`instance-behaviors.ts`)
- **Image files** are named `images/<object>-<animation>-<frame, 3 digits>.png` (TiledBg: `images/<object>.png`), the whole name lowercased
- **Event shapes** follow editor-saved sheets (`event-shapes.ts`): Else is a System `else` condition at index 0 (conditions after it make an else-if), an OR block has `"isOrBlock": true` on the event, a function call is `{ callFunction, sid, parameters: [positional arguments] }` without `id`/`objectClass`, and a script action is `{ type: "script", language: "javascript", script: [lines] }`. Never write the block-level `isElse` or per-condition `isOr` keys older versions wrote
- **Behavior conditions/actions** name their behavior under `behaviorType`; a condition or action that names its behavior only under the legacy `behavior-type` key makes the editor refuse to open the project (a leftover `behavior-type` next to a valid `behaviorType` is ignored)
- **Timelines** are stored under `timelines/`, in folders that mirror their project-bar folders. The first nameless first-level subfolder of the container is the editor's Transitions folder: its items are transitions, stored in `timelines/transitions/` (`timeline-folders.ts`); a nameless folder anywhere else is malformed
- **JSON formatting**: C3 uses tab indentation (`\t`), LF line endings, no trailing newline and no BOM. Existing files keep whatever style they have on disk (e.g. CRLF from a git `core.autocrlf` checkout)
- **Field naming**: Mostly camelCase for object properties (`isGlobal`, `behaviorTypes`), kebab-case for some identifiers (`plugin-id`, `initially-visible`)

## ACE Catalogue

`src/construct3/ace-catalog-data.ts` holds the condition and action definitions the ACE validation checks against. It is generated, never edited by hand:

```bash
node scripts/build-ace-catalog.mjs r495-2
```

The script reads three public files the Construct editor loads for that release from `https://editor.construct.net/<release>/`: `plugins/allAces.json` and `behaviors/allAces.json` (each built-in addon's own ACEs) and `main.js` (the common ACEs the editor adds to plugins by capability, which the other two leave out). It keeps each ACE's ID and its parameters' IDs, types and combo choices. It stops with an error if it cannot read a common ACE definition or tell conditions from actions, which is the likely failure when a new release changes the editor's code.

After regenerating for a new release, run the tests, then check the catalogue against projects that release saved, as was done for r495.2: 8,191 built-in conditions and actions across C3-ACE and three reference packages, 0 problems. The catalogue also carries every expression (name, parameter types, variadic flag) for the expression checks in `src/construct3/expression-check.ts`; check those the same way (C3-ACE's 4,757 parameter values gave 0 problems).

## Editor Checklist Coverage

`scripts/editor-coverage.json` maps every item of the 425-item Construct editor acceptance
checklist to a status (`covered`, `partial`, `open`, `editor-only`) and the tools that produce
the same end state in project files. `node scripts/editor-coverage.mjs` prints the per-surface
table, `--write` rewrites the block in `FORK.md`, `--check` fails when that block is stale, and
`--list <status>` lists one status with notes. When a tool is added, renamed or extended, update
the mapping and run `--write`; `test/docs/editor-coverage.test.ts` fails on a stale table or an
unregistered tool name.

## Cache Invalidation

After any write operation, three caches must be cleared:

1. **Reader caches** — `reader.invalidateCaches()` clears entity caches
2. **Project index** — `resetProjectIndex()` clears the cross-reference index
3. **ID generator** — `idGen.reset()` forces re-scan of existing IDs

The `ProjectWriter.invalidateAll()` method handles all three. After writing and verifying project.c3proj, `addToProject()` and `removeFromProject()` call `reader.reloadProject()` and then `invalidateAll()`: registration changes invalidate the project index and ID generator as well as reader caches. A later file-deletion failure therefore cannot leave the removed entity in those caches. Capture its subfolder before deregistration, because reloading drops its path-map entry.

## Testing

The Vitest suite (`test/**/*.test.ts`) runs without Construct 3 and without network access:

```bash
npm test                              # all suites, once
npm run test:watch                    # watch mode
npm run test:coverage                 # with coverage
npx vitest run test/tools             # one folder
npx vitest run --maxWorkers=2         # fewer workers on low-memory machines
npx tsc --noEmit                      # type check without building
```

- Tool tests register the real handlers on the mock server in `test/mocks/mock-server.ts` and call them with `callTool()`.
- Tests that write copy a fixture from `test/fixtures/` to a temporary folder first; the committed fixtures are never changed.
- Fixtures contain no proprietary content: `minimal-project` is hand-written, `c3-loadable-minimal` was derived with `scripts/derive-minimal-fixture.ts` and opened in the editor (its uniqueId, SIDs, version, layer names and a layer color were replaced with generated or default values afterwards, as the script now does; that version has not been reopened in the editor yet), and `runtime-traps-real` holds event sheets from public MIT-licensed projects (sources in its README).
- A fix to a guard or a file shape needs a regression test that fails when the fix is reverted.
- A change to what the tools write should also be loaded in the Construct editor on a throwaway project, and where it matters saved again and compared with the tool's output.

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

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes, build and test: `npm run build && npm test`
4. Test against a real C3 project
5. Commit with clear message
6. Push and open a Pull Request

### Documentation

- A change to the tools updates the documentation in the same commit: the README tool tables and counts, `FORK.md`, `CHANGELOG.md`, and each `docs/` page the change affects.
- A push of this fork carries the matching README and `FORK.md` update in the same push, so what GitHub shows describes the pushed code, including `FORK.md`'s branch table and measures.

### Code Style

- TypeScript strict mode
- No `any` types — use `unknown` with type guards
- All tool handlers must catch errors and return structured responses
- Mutation tools must follow the backup/validate/write/verify pattern
- Use existing helper functions (`validateName`, `toolResult`, `toolError`)
- Keep test data synthetic: no content from private projects in code, tests or fixtures

---

**Last Updated**: 2026-09-28
