# Changelog

All notable changes to the Construct3 MCP Server are documented here.

## [Unreleased]

### Added

- `list_effects`, `add_effect`, `update_effect`, `remove_effect`, and
  `reorder_effects`: attach registered effect addons to object types,
  families, layers, and layouts, keeping per-instance state on every placed
  instance in sync.
- `update_instance` now merges plugin `properties`, per-instance `behaviors`
  settings, and per-instance `effects` state, finds instances in nested
  sub-layers, and warns instead of silently ignoring spatial values on
  non-world instances.
- Flowchart tools: `list_flowcharts`, `get_flowchart_details`,
  `create_flowchart` and `delete_flowchart` manage `flowcharts/<name>.json`
  files and their `project.c3proj` registration, including nested subfolders.
  Creation is refused unless the Flowchart plugin is already in `usedAddons`;
  the tools never register a plugin themselves.
- `add_flowchart_node`, `update_flowchart_node` and `delete_flowchart_node`:
  node editing with SIDs from the project-wide generator, the one-start-node
  invariant enforced on write, preservation of preset markers and unknown keys,
  and full reference cleanup on delete (other nodes' `nodeSIDs`, the parallel
  `pnSIDs`/`poSIDs` entries, and outputs whose `cnSID` pointed at the node).
- `add_flowchart_output`, `update_flowchart_output`, `delete_flowchart_output`
  and `reorder_flowchart_outputs`: output-pin editing, with deletion undoing any
  connection the pin held and reordering rejecting anything that is not a
  permutation of the node's current outputs.
- `connect_flowchart_nodes` and `disconnect_flowchart_nodes`: connection editing
  that keeps `cnSID`, `pnSIDs`, `poSIDs` and `nodeSIDs` consistent, refuses
  self-connections and already-connected outputs, and leaves a second connection
  between the same two nodes intact when one is removed.
- `Flowchart`, `FlowchartNode`, `FlowchartOutput` and `FlowchartsContainer`
  types, documenting the r495 field meanings (`t` is the node type, `c` is the
  caption and not a color; `pnSIDs`/`poSIDs` are parallel per-connection arrays).
- `connect_to_game` and `disconnect_from_game`: persistent Chrome DevTools
  Protocol connections, page-target discovery, bridge readiness checks,
  multiple retained connections, and server-shutdown cleanup.
- `call_bridge`: execute all 11 injected runtime bridge commands with bounded
  polling, explicit timeouts, structured bridge errors, and collision-safe
  concurrent CDP requests.
- `wait_for_condition`: bounded check-first polling for global variables,
  object properties, layouts, and caller-supplied page expressions, with seven
  comparison operators and non-error timeout results that retain the last
  observed value.
- `simulate_input`: delayed mouse clicks and movement, touch tap/long-press/
  swipe gestures, key combinations, and character-by-character text insertion
  through the retained connection's CDP Input domain, with an optional
  `canvas` coordinate space that offsets points by the canvas position and
  rejects points beyond the canvas.
- `get_canvas_size`: canvas CSS position and size, backing-store size, device
  pixel ratio, and viewport size for choosing input coordinates.
- Fake-CDP integration coverage for discovery, direct endpoints, readiness,
  persistence, all bridge commands, rapid calls, errors, timeouts, disconnect,
  missing targets, runtime condition waits, and exact input event sequences.
- `list_containers`, `create_container`, `update_container`, and
  `delete_container`: read and edit the `containers` array in
  `project.c3proj`, which groups object types so C3 creates, picks and
  destroys them together. A container is identified by any one of its
  members; membership is validated against the registered object types,
  families are rejected, an object type is held by at most one container,
  a one-member container warns, and removing the last member deletes the
  container.
- `update_instance_variable`: rename, retype, re-describe or hide an
  existing instance variable on an object type or family. A rename also
  renames the stored key on every placed instance (all layers, nested
  sub-layers and non-world instances, and every family member), and either
  rewrites event-sheet references (`instance-variable` ACE parameters and
  `<Object>.<variable>` expression text) or refuses the rename while
  references exist. A retype coerces stored values: to string via
  `String()`, to number via `Number()` falling back to 0, to boolean via
  truthiness.
- `update_object_properties.addVariables` and `update_family.addVariables`
  accept `description` (C3 `desc`) and `showInPropertiesBar` (C3 `show`).
  There is no `initialValue`: a C3 instance-variable definition carries no
  default-value field, so a starting value only exists per placed instance.
- `update_frame` now edits a frame's `tag`, its `imagePoints` (replace the
  whole list, or add and remove by name, validated as unique names with x/y
  normalized 0-1), its `collisionPoly` (a flat x,y list normalized 0-1, even
  length and at least three points, `[]` to clear), and `useCollisionPoly`.
- `reorder_frames` and `reverse_frames`: reorder a Sprite animation's frames
  and rename the frame image files under `images/` to match, because C3
  addresses a frame's image by the index in its file name. The order must be a
  full permutation, the files are parked under temporary names during the move,
  and every rename is rolled back if the JSON write fails.
- `duplicate_frame`: copy a frame's JSON with a freshly generated
  `imageSpriteId`, shift later frame image files up by one, and copy the source
  frame's image into the freed slot, rolling back on failure.
- `create_animation_folder` and `move_animation_to_folder`: build and populate
  the `animations.subfolders` tree on a Sprite, finding an animation wherever it
  currently sits.
- `create_data_file`: write an Array (`c2array`), Dictionary (`c2dictionary`),
  JSON, or text body under `files/` and register it as a general Project File,
  refusing to overwrite an existing file or registration.
- `set_main_script`: set `script-info.purpose` to `main` on one registered
  script and clear it from every other, keeping C3's single-main-script rule.
- `register_project_file` and `deregister_project_file` now use the directory
  each Project File family actually stores files in (`files/`, `sounds/`,
  `music/`, `videos/`, `fonts/`) instead of copying every family into `files/`,
  where C3 would not find them.
- `move_event_block`: move an existing event (block, group, variable,
  function-block, custom-ace-block) to another container in the same sheet by
  `groupPath`, `parentSid` or `siblingSid`, preserving its SID, its condition
  and action SIDs, and every descendant. Refuses a destination inside the
  moved event's own subtree and resolves the destination before detaching
  anything, so a rejected move leaves the file untouched.
- `update_event_group`: edit a group in place — `title`, `description`,
  `isActiveOnStart`, `disabled`, and the two color keys Construct serializes
  (`background-color`, `text-color`). A new title that collides with a sibling
  group is rejected so group paths stay unambiguous; a collision in another
  container is reported as a warning.
- `update_comment`: edit a comment's `text` and color keys. Comments carry no
  SID in Construct, so a comment is addressed by its 0-based `index` among its
  container's events (optionally with `groupPath` or `parentSid`); `sid` is
  accepted for the rare comment that has one.
- `update_function`: edit a function-block's name, description, category,
  return type, async and copy-picked flags, and its parameter list. Renaming
  rewrites every `callFunction` action across all sheets when
  `renameCallers=true` and is refused otherwise; `removeParameters` is refused
  while callers exist, because a `callFunction` action stores its arguments as
  a positional array. Expression references (`Functions.<name>` and bare
  parameter names) are counted and warned about rather than rewritten.
- `add_event_to_sheet` now accepts `groupPath` and `parentSid`, so a local
  variable, comment, group or function can be inserted inside a group or a
  block's `children` using the same locator rules as `add_event_block`.
  Callers that pass neither keep the original root-insertion behavior; a
  nested `include` is rejected because Construct only serializes includes at
  the sheet root.
- `add_custom_action`: add a custom action definition (`custom-ace-block`) for
  an object type or family, with description, category, return type, async and
  copy-picked flags, and parameters with fresh SIDs. The emitted key set and
  defaults follow a real project's definitions; every definition observed there
  uses `aceType: "action"`, so only that form is written and the condition and
  expression forms are not invented. `System` and duplicate object-class plus
  name pairs are rejected.

- `rename_object_type`, `rename_family`, `rename_layout`,
  `rename_event_sheet`, `rename_layer` and `rename_event_variable`: rename an
  entity and rewrite every reference through one shared scanner in
  `src/construct3/references.ts`, so the reference report and the rewrite
  cannot disagree. Covered: `objectClass` on conditions, actions and
  `custom-ace-block` owners; the bare-name parameter keys `object`,
  `object-to-create`, `parent`, `child` and `instance`; identifier tokens in
  every other string parameter, including the array-form arguments of a
  custom-action call; layout instance `type` in nested sub-layers and
  `nonworld-instances`; family `members`; `containers[].members`; the
  `project.c3proj` trees (renamed in place, keeping position and subfolder);
  `firstLayout`; each timeline's `startOnLayout`; `layout`- and `layer`-keyed
  parameters in both their bare and quoted forms; `layoutEventSheet` and
  `includeSheet`; the `variable` key; and the entity, image and tilemap-brush
  file names. Every tool takes `dryRun`.
- Expression rewriting is token-aware: only whole identifier runs match, a run
  after a `.` is treated as a member name, and string literals are never
  touched, so `"Player wins" & Player.X` rewrites one occurrence and
  `PlayerShip.X` none. Script bodies, comments and variable initial values are
  counted and warned about rather than rewritten.
- Renames write referencing files first and the entity last, so re-running an
  interrupted rename resumes it; each result lists `filesWritten` in order and
  a failure repeats that list. `rename_layer` skips the event-sheet pass, with
  a warning, when another layout has a layer of the same name, because a
  `layer` parameter is not layout-scoped.
- `list_templates`, `set_instance_template` and `set_default_template`: read
  and write a layout instance's `template` block, reproducing the r495 shape
  (`mode`, `templateName`, `sourceTemplateName`, the three hierarchy flags, the
  five `components` ids in order, `replicasUIDs: null`). Components are derived
  from the instance's own plugin properties (minus `live-preview`), instance
  variables, behaviors and effects (with the `<<effect-template-enable>>`
  marker), plus the fixed 24-key `world-instance` list whose `x` and `y` are
  `false`. `set_default_template` sets `editorNewInstanceIsReplica` and
  `editorNewInstanceTemplateName` on the object type.
- `list_tilemap_brushes`, `add_tilemap_brush`, `update_tilemap_brush` and
  `delete_tilemap_brush`: manage
  `tilemapBrushes/objectTypes/<subfolder>/<name>.brush.json`, whose path
  mirrors the object type's subfolder. Grid dimensions are validated per type
  (`auto16` 4x4, `auto47` 6x8, `patch` `width` by `height`), as is every cell
  (tile index, `null`, or weighted `{ index, probability }` alternatives).
  Tilemap tile data is deliberately not implemented: no sample of its
  serialization exists to work from.
- `rename_object_type` now rewrites `tracks[].objectType` in every timeline
  file. An instance track stores its object type by name, and Construct r495.2
  refuses to open a packed project whose track names a type that no longer
  exists. Timeline files are found by walking `timelines/` rather than the
  `project.c3proj` `timelines` tree, so a transition timeline in an unlisted
  subfolder is covered too, and the walk spans the whole document so a track
  nested in `tracksRoot` cannot be missed. `tracks[].worldInstance`, a
  property track's `source.uid` and `tracks[].project` are UID and id fields
  and stay as they are. `rename_layout` uses the same walk, so
  `startOnLayout` - the only layout-naming key in a timeline - is now found in
  subfolders as well.

## [1.8.2] - 2026-09-10

### Source-verified defects from a live-project mutation evaluation

Found by evaluating v1.8.1 against a real project whose four largest layouts (11-46MB) exceed the reader's 10MB cap, then hardened in upstream review.

#### Fixed

- **UID high-water blindness (CRITICAL)** — `IdGenerator` scanned UIDs only from layouts `readAllLayouts()` could parse; layouts over the 10MB read cap were silently skipped, so `generateUid()` could mint a UID already in use (observed live: computed max 30042 vs. true max 30046 — the next `add_instance_to_layout` would have collided). The reader now records typed per-entity bulk-read failures and exposes `scanEntityIdsRaw(category, name)`, a raw regex scan for `"uid"`/`"sid"` values that bypasses the size cap and JSON parsing. The generator recovers the high-water mark (and SIDs) from every unreadable layout and object type (`singleglobal-inst` UIDs). A registered file that does not exist on disk is skipped (it holds no IDs); if a file exists but even the raw scan fails, `generateUid()` hard-fails naming the `category/name` instead of risking a duplicate.
- **Script-action serialization (CRITICAL)** — script actions were emitted as `{ type: 'script', script: "<string>" }`, but C3 serializes them as `{ type, language: "javascript", script: [<lines>] }` (0-for-374 against a real project's script actions; the single-string form loads but the desktop editor does not render the block). `add_event_block` and `update_event_block` now emit the canonical shape; `script` input accepts a single string (split on newlines) or an array of lines. `ScriptAction` and `ScriptEvent` types updated to match.
- **`validate_project` silently skipped oversized files** — files over the read cap surfaced as false *"missing or contains invalid JSON"* errors. They are now reported as `unscanned-file` warnings ("UNSCANNED: File too large ... integrity checks did not cover this file"), listed in a new `unscannedFiles` array with a `summary.unscanned` count, and the result carries `complete: false`. Classification is by the failure's typed code, never by message text. A registered file that does not exist is reported as "no file exists at `<category>/[subfolder/]<name>.json`"; other read failures keep their real reason, minus the absolute project path Node appends to fs errors.
- **Delete tools left a dangling registration on partial failure** — `delete_layout`, `delete_object`, `delete_event_sheet` and `delete_family` deleted the file *then* deregistered it from c3proj; a failure between the two steps left a registered name with no file: a `validate_project` error for object types, event sheets and layouts, and for layouts a state that (before the fix above) blocked every `generateUid()`. They now deregister first, so the worst case is an orphaned file; if the file delete fails after deregistration, the tool error names the orphaned file. `addToProject`/`removeFromProject` invalidate the project index and ID generator themselves, so a failure after deregistration cannot leave either stale.

#### Added

- Typed read failures: `getReadFailures(category)` returns `{ code, message }` with `E_FILE_TOO_LARGE` / `E_FILE_NOT_FOUND` / `E_INVALID_JSON` / `E_READ_ERROR`; the per-entity readers throw `ProjectReadError` carrying the same code (message text unchanged; the original error is kept as `cause`). `getEntityRelativePath(category, name)` gives the project-relative path the reader resolves for an entity. The parsed readers and the raw scan resolve paths through one helper.
- `validate_project` result: `complete: boolean` — `false` when any registered object type, event sheet or layout was skipped as unscanned; `valid` is unchanged and only vouches for the files that were scanned.
- `add_event_to_sheet` function events: `functionReturnType` (`none`/`number`/`string`/`any`), `functionIsAsync`, `functionCopyPicked` parameters — previously hardcoded to `none`/`false`/`false` with no knob, forcing hand edits for any value-returning function.
- `docs/API.md`: `add_event_to_sheet` documents the three function parameters; new `validate_project` section; script-action shape corrected; the `delete_object`, `delete_event_sheet` and `delete_layout` sections describe the deregister-then-delete order. README lists `validate_project`.

#### Tests

- 468 passing (up from 418): id-generator recovery, hard-fail and missing-file handling on mocks and on real files (10MB cap bypass, subfolder resolution, ENOENT, EISDIR, invalid JSON, objectTypes); integrity classification by typed code, UNSCANNED reporting, `complete`, subfolder-aware missing-file messages and path stripping; delete ordering and the orphaned-file error path on mocks and on a real project copy; index invalidation on registration changes; canonical script-action shape on mocks and on disk; function-event options.

## [1.8.1] - 2026-04-16

### VAL-02 Remediation — Honest Acceptance Contract

Post-release: VAL-02's original "builds a minimal playable project" claim was structurally verified but never proven against the Construct 3 editor itself. When attempted, C3 rejected the output with "Failed to open project" — the hand-built fixture was never a valid C3 project. Fixed:

#### Added

- **`scripts/derive-minimal-fixture.ts`** — Reproducer that prunes a known-good C3 project into a minimal, shippable fixture. Two-stage prune (drop third-party addons → aggressive minimize to one empty layout + one empty event sheet). Iterated via live Construct 3 editor feedback.
- **`test/fixtures/c3-loadable-minimal/`** — 11 files, ~18 KB packed. IP-free. **Validated 2026-04-16** by loading into Construct 3 editor via EditorBridge automation — opens cleanly, no "Failed to open project" dialog.
- **Third VAL-02 test** — Packs the C3-loadable fixture and verifies structural invariants. Protects the committed fixture from drift.

#### Changed

- **`test/acceptance/m1-end-to-end.test.ts`** — Renamed suite + test to "M1 Structural Round-Trip Acceptance" / "builds a structurally consistent project." Docstring now explicitly warns against self-referential validation: reader/writer sharing blind spots can pass a structural test while the output is rejected by C3.

#### Learnings (preserved for future fixture work)

- C3 halts load on any reference from manifest to missing file (`rootFileFolders.general` entries pointing at deleted files surface as "missing file path 'X'").
- Event-sheet `objectClass` references to dropped object types halt load with "cannot find object 'X'". Empty-out `events[]` in every sheet clears this class of refs in one pass.
- Pruning subdirectories under `objectTypes/` must be recursive — top-level readdir misses grouped plugins (e.g. `objectTypes/Array/*.json`).

#### Tests

- 418 passing (up from 417), no skips

## [1.8.0] - 2026-04-16

### M1 Release — Community Governance & End-to-End Validation

Milestone 1 closure: full primitive surface, community-ready codebase, end-to-end acceptance test.

#### GOV-01 — Internal reference scrub

- Removed all EditorBridge, MyStudio, and RGS-specific references from `src/` and `test/`
- `src/runtime/bridge.ts` — doc comment rewritten to generic automation language (Playwright, curl, CDP)
- `src/tools/runtime-tools.ts` — all five EditorBridge references replaced with generic equivalents; `MyStudioPlatformConnect` example replaced with `MyPlugin`
- `src/index.ts` — Phase 4 comment updated to remove EditorBridge reference

#### GOV-02 — Public docs scrub

- `README.md` — removed MyStudio Construct MCP cross-link and slot machine reference; updated Authors section; reworded EditorBridge references to Playwright/CDP; updated roadmap and Known Limitations
- `docs/EXAMPLES.md` — replaced `MyStudio` author example with `My Studio`
- `package.json` — `author` field changed from `MyStudio` to `construct3-mcp contributors`

#### GOV-03 — Version bump

- `package.json` version: `1.6.0` → `1.8.0` (minor bump; new tools are additive, no breaking changes)
- `src/index.ts` MCP server version: `1.5.0` → `1.8.0`
- Version rationale: Phases 6–7 added runtime tools, pack_project, and acceptance test infrastructure — all additive; backward compatible with existing tool callers

#### VAL-01 — Test suite

- 415 tests across 15 test files — all passing (no regressions from Phases 1–6)

#### VAL-02 — End-to-end acceptance test

- New: `test/acceptance/m1-end-to-end.test.ts`
- Exercises the full primitive tool chain using real MCP tool handler functions (no direct JSON manipulation):
  1. `create_object` (Sprite with animation)
  2. `create_event_sheet`
  3. `create_layout` (with layer)
  4. `add_instance_to_layout`
  5. `add_event_block` (condition + action)
  6. `pack_project` → `.c3p` ZIP archive
- Asserts: `.c3p` exists on disk, ZIP unpacks without error, event sheet referenced by layout exists, object referenced in layout exists, structure is internally consistent

#### VAL-03 — Coverage gate

- Audited all tools added in Phases 4–7 against existing test coverage
- All tools have at least one passing test; no gaps found requiring new additions beyond VAL-02

#### Infrastructure

- `pack_project` tool description updated (removed EditorBridge upload reference)
- `generate_bridge_eval_script` description updated (generic CDP language)

## [1.6.0] - 2026-03-02

### Sprite Image Pipeline

Automatic placeholder PNG generation for Sprites and TiledBg objects, with `imageSpriteId` linking between object JSON and image files.

#### Added

- **PNG Generator** (`png-generator.ts`) — Zero-dependency transparent PNG generation using zlib; follows C3 image naming conventions (`objectname-animation-000.png` for Sprites, `objectname.png` for TiledBg)
- **`writeImageFile`** — Write a single placeholder PNG to the `images/` directory with auto-created directories
- **`writeImageFiles`** — Batch write multiple PNGs with rollback on failure (cleans up already-written files)
- **`generateImageSpriteId`** — 7-digit collision-checked ID generator for linking animation frames to image files
- **`imageSpriteId` support** — `createSpriteObject`, `createTiledBgObject`, and `createAnimationFrame` templates now accept optional `imageSpriteId`
- **Image pipeline integration tests** — 7 tests covering PNG creation, valid signatures, batch writes, Sprite/TiledBg round-trips, and ID uniqueness

#### Fixed

- **Behavior addition breaks project** — When `update_object_properties` adds a behavior or variable to an object type, existing layout instances of that object now get `behaviors` and `instanceVariables` dicts auto-synced so C3 can resolve them on project load. Without these fields, C3 could fail to open the project.
- **Fixture layout instance** updated to include `behaviors`, `instanceVariables`, and `tags` fields matching real C3 projects

#### Infrastructure

- 278 tests (up from 262), 12 test files
- `IdGenerator` now tracks `existingImageSpriteIds` from animation frames across the project
- 6 behavior workflow integration tests (add behavior, addon registration, multiple behaviors, field preservation, layout instance sync, full round-trip)
- 3 behavior unit tests (layout sync when instances exist, skip when none, preserve existing overrides)

## [1.5.0] - 2026-02-21

### Event Sheet & Layout Lifecycle

3 new mutation tools for deleting event sheets/layouts and updating layout properties (total: 14 mutation tools).

#### Added

- **`delete_event_sheet`** — Delete event sheets with reference checking (included-by sheets, bound layouts); supports `force` flag to override
- **`delete_layout`** — Delete layouts with reference checking (bound event sheets, placed objects); blocks deletion of the startup layout unconditionally; supports `force` flag
- **`update_layout`** — Update layout properties: event sheet binding (validated), width, and height

#### Enhanced

- **`add_event_block`** — Now supports sub-events (`children`), else blocks (`isElse`), OR conditions (`isOr`), and per-action disabling (`disabled` on actions). Recursive child building with safety limits (max depth 5, max 50 total events). Object class validation covers the entire event tree.

#### Closes

- Issue #2: `delete_event_sheet`
- Issue #3: `delete_layout`
- Issue #4: `update_layout`
- Issue #7: `add_event_block` sub-events, else, OR, per-action disabled

## [1.4.0] - 2026-02-19

### Phase 4: Event Blocks & Animation

3 new mutation tools for gameplay logic and animation management (total: 11 mutation tools).

#### Added

- **`add_event_block`** — Add block events with conditions + actions to event sheets, with group path targeting, script action support, inverted conditions, and object class validation
- **`add_animation_to_sprite`** — Add named animations with configurable frame count, speed, looping, ping-pong to Sprite objects
- **`update_animation_properties`** — Modify speed, looping, ping-pong, repeat count on existing Sprite animations

#### Infrastructure

- **`createBlockEvent`** template — Generates valid block event JSON with conditions, actions, children array
- **`createAnimation` / `createAnimationFrame`** templates — Animation and frame JSON builders
- **`findGroupByPath()`** helper — Two-pass group traversal (verify-then-mutate) for safe nested event insertion
- **`validateObjectClasses()`** helper — Validates objectClass references against project objects, families, and System

#### Fixes (pre-push audit)

- `findGroupByPath` no longer mutates event data on failed path resolution
- All Phase 4 tools now return `backupFile` in results (consistency with Phase 3)
- Animation name validated as non-empty (`.min(1)`)
- Animation speed validated as non-negative (`.min(0)`)
- `createBlockEvent` includes `children: []` for sub-event consistency
- Fixed stale documentation: tool counts (8→11), roadmap references, manual test checklist

## [1.3.0] - 2026-02-16

### Phase 3: Safe Modifications

8 new mutation tools that safely create, update, and delete project entities.

#### Added

- **`create_object`** — Create Sprite, Text, TiledBg, NinePatch, and global plugin objects with proper SID/UID generation
- **`update_object_properties`** — Add/remove instance variables and behaviors on existing objects
- **`delete_object`** — Delete objects with reference checking (event sheets, layouts, families); supports `force` flag
- **`create_event_sheet`** — Create event sheets with optional auto-includes
- **`add_event_to_sheet`** — Add groups, functions, variables, includes, and comments to event sheets
- **`create_layout`** — Create layouts with configurable dimensions and layers
- **`add_instance_to_layout`** — Place object instances on layout layers with plugin-specific default properties
- **`update_project_metadata`** — Update project name, version, author, description

#### Safety infrastructure

- **ID Generator** (`id-generator.ts`) — Scans all existing SIDs/UIDs across the project, generates collision-free new ones (15-digit random SIDs, sequential UIDs)
- **Project Writer** (`project-writer.ts`) — Backup-before-write, JSON pre-validation (round-trip test, 5MB limit), post-write file verification, path traversal protection
- **Templates** (`templates.ts`) — Validated templates for all entity types with correct field names (`isGlobal` not `is-global`), `editorNewInstanceIsReplica`, plugin-specific instance properties
- **Addon validation** — Plugins and behaviors checked against `usedAddons`; known Scirra addons auto-registered, unknown addons blocked
- **Reserved name protection** — Blocks creation of objects named "System"
- **Global plugin protection** — Prevents placing singleglobal-inst objects on layouts
- **Cache invalidation** — Reader caches, project index, and ID generator all reset after writes

## [1.2.0] - 2026-02-15

### Phase 2: Enhanced Analysis

6 new analysis tools with cross-reference indexing.

#### Added

- **`get_eventsheet_flow`** — Event sheet include hierarchy and layout bindings, with Mermaid diagram output
- **`get_function_map`** — Function definitions and call sites across all event sheets
- **`get_object_dependencies`** — Object usage across event sheets, layouts, families, and co-occurring objects
- **`find_orphaned_objects`** — Detect objects not referenced in any event sheet or placed in any layout
- **`get_asset_usage`** — Track sound, music, image, font, and video asset usage
- **`analyze_performance`** — Heuristic performance audit with info/warning/critical categorized issues
- **Cross-reference index** (`index-builder.ts`) — Cached project-wide index for fast dependency lookups

#### Infrastructure

- Modular analyzer architecture (`src/construct3/analyzers/`)
- Configurable detail levels (summary/normal/full) across analysis tools

## [1.0.0] - 2026-02-14


### Phase 1: Foundation

Initial release with read-only project access.

#### Added

- **7 Resources**: Project info, structure, addons, object/eventsheet/layout details, C3 documentation
- **9 Query Tools**: List/search objects, event sheets, layouts, families; get details; project summary
- **6 Prompts**: Analyze project, find object usage, explain event sheet, review game logic, document object, optimize project
- Project file parser with caching
- Fuzzy name matching with suggestions
- Official Construct 3 documentation access via resources
