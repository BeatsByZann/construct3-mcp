# Development Guide

Guide for contributing to and developing the Construct3 MCP Server.

## Prerequisites

- **Node.js** >= 18.0.0
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
│   ├── construct3/        # Project logic: reader, writer, ID generator, templates,
│   │                      # session and .c3p serving, change journal, project shape,
│   │                      # ACE catalogue, addon definitions, expression checker,
│   │                      # references, timelines, tilemaps
│   │   └── analyzers/     # Index, event flow, object dependencies, assets,
│   │                      # performance, group settings, integrity (validate_project)
│   ├── resources/         # MCP resources (8)
│   ├── runtime/           # Bridge script, CDP client, preview server, zip reader/writer
│   ├── tools/             # MCP tools (185 in 23 files; mutations.ts registers the
│   │                      # 18 mutation-tool files)
│   └── prompts/           # MCP prompts (6)
├── scripts/               # build-ace-catalog.mjs, editor-coverage.mjs and its mapping
├── test/                  # Vitest: unit tests by area, *.integration.test.ts against
│   │                      # copied fixtures, runtime tests against a vm harness
│   └── fixtures/          # Small projects; several saved by Construct r495.2
├── docs/                  # API, architecture, development, examples, troubleshooting
├── FORK.md                # How this fork differs from upstream
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
3. Register the tool in `src/tools/analysis.ts`
4. The analyzer can use `getProjectIndex(reader)` for cross-reference data

### Adding a New Mutation Tool

1. Add the tool to the area's `src/tools/<area>-tools.ts`; `src/tools/mutations.ts` registers every area file
2. Follow the safety pattern:
   - Validate inputs (use `validateName()`, `validateSubfolder()`)
   - Check addon registration with `writer.ensureAddonRegistered()`
   - Generate IDs with `idGen.generateSid()` / `idGen.generateUid()`
   - Build data from templates in `templates.ts`
   - Write with `writer.writeEntityFile()` (handles stamp check, backup, validate, verify and the change journal)
   - Change `project.c3proj` through `writer.addToProject()` or `writer.mutateProjectJson()`, which also apply the r495.2 save shape (`project-shape.ts`). A tool that writes `project.c3proj` itself must call `upgradeProjectShape()` first. Any tool that writes a project file itself backs it up with `backupOnce()` and records the write with `recordWrite()` or `recordDelete()` (all in `change-journal.ts`), as the timeline, flowchart and container tools do; an unrecorded write is missing from the call's changed-files line and is not undone by `revert_last_change`
   - Return a `WriteResult`
3. Add the tool to `docs/API.md`, the README tool tables, `FORK.md` and `CHANGELOG.md`, and map it in `scripts/editor-coverage.json` where it reproduces an editor checklist item (a test refuses an unregistered tool name there)

### Adding a New Template

1. Open `src/construct3/templates.ts`
2. Add a builder function that returns `Record<string, unknown>`
3. Validate all field names against a real C3 project file — C3 uses a mix of camelCase (`isGlobal`) and kebab-case (`plugin-id`)
4. Export and use in `mutations.ts`

## C3 File Format Notes

Key things to know when working with Construct 3 project files:

- **SIDs** are ~15-digit random integers, globally unique across ALL entities in the project
- **UIDs** are sequential integers, only on layout instances and singleglobal-inst objects
- **Cross-references are by NAME** — event sheets reference objects as `"objectClass": "Name"`, layouts as `"type": "Name"`
- **c3proj containers** use `{ items: string[], subfolders: Subfolder[] }` recursive structure
- **usedAddons** in c3proj must list every plugin, behavior, and effect used
- **Global plugins** (Audio, AJAX, Mouse, etc.) use `singleglobal-inst` instead of layout placement
- **JSON formatting**: C3 uses tab indentation (`\t`)
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

```bash
npm test               # Vitest, once
npm run test:watch     # Vitest in watch mode
npm run test:coverage  # With coverage
npx tsc --noEmit       # Type check without building
```

- Integration tests copy a fixture from `test/fixtures/` to a temporary folder and call the tools through `test/mocks/mock-server.ts`.
- A fix to a guard or a file shape needs a regression test that fails when the fix is reverted. The fork's changes were checked by reverting each guard in turn and confirming a test fails.
- A change to what the tools write should also be loaded in the Construct editor on a throwaway project, and where it matters saved again and compared with the tool's output.

To try the server by hand:

1. Build: `npm run build`
2. Start with a test project: `node dist/index.js /path/to/test-project`
3. Connect via Claude Code or Claude Desktop
4. Run through the checklist below

### Manual Test Checklist

**Query tools:**
- [ ] `list_objects` with and without filter
- [ ] `get_object_details` with valid and invalid names
- [ ] `get_project_summary`

**Analysis tools:**
- [ ] `get_eventsheet_flow` in mermaid and JSON format
- [ ] `find_orphaned_objects`
- [ ] `analyze_performance`

**Mutation tools:**
- [ ] `create_object` with Sprite, Text, and global plugin
- [ ] `update_object_properties` adding variables and behaviors
- [ ] `create_event_sheet` with includes
- [ ] `add_event_to_sheet` for each event type
- [ ] `create_layout` with custom layers
- [ ] `add_instance_to_layout`
- [ ] `delete_object` with and without force
- [ ] `delete_event_sheet` with and without force
- [ ] `delete_layout` on non-first layout
- [ ] `delete_layout` on first layout (must block)
- [ ] `update_layout` changing eventSheet, width, height
- [ ] `update_project_metadata`
- [ ] `add_event_block` with conditions, actions, and group path
- [ ] `add_animation_to_sprite` on an existing Sprite
- [ ] `update_animation_properties` (speed, looping, ping-pong)
- [ ] Verify `.bak` backup files are created
- [ ] Verify all read tools still work after writes

**Safety tests:**
- [ ] Path traversal: `create_object({ name: "../../evil" })` — must reject
- [ ] Reserved name: `create_object({ name: "System" })` — must reject
- [ ] Global on layout: `add_instance_to_layout` with Audio object — must reject
- [ ] Unknown plugin: `create_object({ pluginId: "NonExistent" })` — must reject
- [ ] Duplicate name: `create_object` with existing name — must reject

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and build: `npm run build`
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

---

**Last Updated**: 2026-09-24
