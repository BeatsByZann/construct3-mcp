# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Query Tools](#query-tools)
- [Project Session Tools](#project-session-tools)
- [Analysis Tools](#analysis-tools)
- [Mutation Tools](#mutation-tools)
- [Timeline Tools](#timeline-tools)
- [Effect Tools](#effect-tools)
- [Flowchart Tools](#flowchart-tools)
- [Structure Tools](#structure-tools)
- [Rename Tools](#rename-tools)
- [Template and Tilemap Tools](#template-and-tilemap-tools)
- [Runtime Bridge and Packaging Tools](#runtime-bridge-and-packaging-tools)
- [Runtime Connection Tools](#runtime-connection-tools)
- [Prompts](#prompts)
- [Error Handling](#error-handling)
- [Type Definitions](#type-definitions)

---

## Resources

Resources provide read-only access to project data.

### `construct3://project/info`

Project metadata and basic info.

**Response:**
```json
{
  "name": "My Game",
  "version": "1.0.0",
  "author": "Developer",
  "runtime": "c3",
  "viewportWidth": 1920,
  "viewportHeight": 1080,
  "firstLayout": "Main"
}
```

### `construct3://project/structure`

Complete project structure with entity counts and folder hierarchy.

### `construct3://project/addons`

All used plugins, behaviors, and effects with metadata.

### `construct3://objects/{name}`

Full JSON for a specific object type.

### `construct3://eventsheets/{name}`

Full JSON for a specific event sheet.

### `construct3://layouts/{name}`

Full JSON for a specific layout.

### `construct3://docs/index`

Index of documentation: the manual URL, topic categories (interface, project, plugins, behaviors, effects, scripting, publishing) and popular plugin topics.

### `construct3://docs/manual/{topic}`

Official Construct 3 documentation fetched from construct.net.

### `construct3://docs/pitfalls`

Curated markdown list of Construct 3 behaviors that break game logic quietly: backslash escapes and empty expressions in event JSON, `Dictionary.Get` vs `GetDefault`, `int("")`/`int("0.20")`, *Compare two values* not picking, *Set animation* not restarting, signals not being queued, scripts needing `localVars` for function parameters, and exact window-size comparisons. Each item is tagged `[manual]`, `[projects]` or `[practice]` (reported in [komabear/c3-skill](https://github.com/komabear/c3-skill), MIT). The first two items are the `expression-syntax` and `empty-expression` load-time checks of [`validate_project`](#validate_project); the doc points to them and to `find_runtime_traps`. Also listed under `curated` in `construct3://docs/index`.

---

## Query Tools

### `list_objects`

List all object types with optional name filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | No | Case-insensitive name filter |

### `list_eventsheets`

List all event sheets. No parameters.

### `list_layouts`

List all layouts. No parameters.

### `list_families`

List all object families. No parameters.

### `get_object_details`

Get full details for a specific object type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (fuzzy suggestions on miss) |

### `get_eventsheet_details`

Get full details for a specific event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |

### `get_layout_details`

Get full details for a specific layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |

### `search_objects`

Search objects by name pattern (case-insensitive substring match).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Search pattern |

### `get_project_summary`

Comprehensive project overview including metadata, statistics, addon counts, and entity lists. No parameters.

The read-only timeline tools `list_timelines`, `list_timeline_tracks` and `get_timeline_details` are described under [Timeline Tools](#timeline-tools).

### `list_addons`

List the addons registered in the project's `usedAddons`, with a count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` \| `"all"` | No | Filter by addon type (default: all) |

---

## Project Session Tools

The server starts on the project its command line names. These tools report it, switch to another one while the server runs, re-read it after an outside save, and list or undo what recent calls changed.

### File stamps and the change journal

The server remembers the size and modification time of every project file it reads or writes. A call that reads a file Construct or another program saved since then says so in its result (`Note: 1 file(s) changed on disk since this server last read them ...`) and works from the file's current content. A write that starts from a stale bulk read (the caches `validate_project` and the analyzers fill) is refused with the same wording until `reload_project` runs, so a stale copy never overwrites an editor save.

Every call also gets a journal entry: the files it wrote, created, deleted or moved, and the `.bak` backup each write or delete left beside the file. A file written twice in one call keeps one backup, holding its content from before the call. A mutation result ends with `Changed N file(s): ...` naming them. `list_changes` shows the entries and `revert_last_change` undoes the most recent one from those backups. A placeholder image overwritten by `create_object` or `add_frame_to_animation` has no backup and is reported as not restorable. Files outside the served project (a `clone_project` target, a screenshot) and the `.c3p` write-back, which its own line reports, are not journaled.

### `reload_project`

Re-read the project from disk: every cached file, the project index and the file stamps. No parameters. Returns the project name and `changedOnDisk`, the files whose stamp no longer matched (`changed`) or that are gone (`missing`) before the stamps were cleared.

### `list_changes`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | How many calls to list, newest first, 1 to 50 (default 20) |

Returns `calls`: for each call that changed a file, its `id`, `tool`, `at`, `reverted` flag and `changes` (`kind` of `write`, `create`, `delete`, `move`, `copy` or `overwrite-no-backup`, the `file`, a move's `from`, and the `backup` when one exists), paths relative to the project.

### `revert_last_change`

Undo the most recent call that changed files, last change first: a written or deleted file is restored from its `.bak`, a created or copied file removed, a moved file moved back. No parameters. Refused when a later call, reverted or not, touched any of the same files, because their backups then hold that later state; the message names those calls. Also refused, before anything is restored, when any of the call's files or backups no longer holds what it held when the call ended (Construct, another program or a hand edit changed it), because restoring would then not return the project to its state before the call; the message names those files. Returns `reverted` (the entry), `restored` (file and how) and `notRestored` (file and why) when a change had no backup. The project is re-read afterwards.

### `get_open_project`

Report the served project. No parameters. Returns `name`, `projectFile` (the `.c3proj` path), `format` (`folder` or `c3p`) and, for a `.c3p`, `archivePath` and `workDir`, the working folder the archive is served through.

### `open_project`

Switch to another project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute path of a project folder, a `.c3proj` file, or a `.c3p` file |

**Behavior:**
- Waits until no other tool call is running, and holds calls that arrive meanwhile until the switch is done; they then run on the new project.
- A `.c3p` is unpacked into a new working folder and written back after every call that changes it, as when the server starts on one (see the README's "Single-file (.c3p) projects").
- A `.c3p` being left is written back first, then its working folder is removed. When it cannot be written (Construct saved the archive meanwhile, or the write failed), the switch still happens, the working folder is kept, and `warnings` names it.
- If the new project cannot be opened (no project file, an unreadable archive, an invalid `.c3proj`), the result is an error and the server keeps serving the project it had.
- Returns `opened` (`name`, `projectFile`, `format`, and `archivePath` and `workDir` for a `.c3p`) and `closed` (`name`, `projectFile`, `archivePath`).
- Close the project in Construct before editing it here.

---

## Analysis Tools

The analysis tools with a `detail` parameter accept `"summary"` (under ~2K tokens), `"standard"` (default), or `"full"`.

### `get_eventsheet_flow`

Event sheet include hierarchy and layout bindings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Start from a specific sheet (omit for full project) |
| `format` | `"mermaid"` \| `"json"` | No | Output format (default: mermaid) |
| `detail` | string | No | Detail level |

### `get_function_map`

Function definitions and call sites across event sheets. Call sites are *Call function* actions (`via: "callFunction"`), `Functions.Name(...)` calls in the expressions of conditions and actions, function call arguments included (`via: "expression"`), and *Map function* / *Map function default* actions of the Functions object (`via: "function-map"`). A function map registration does not call the function itself; it makes it callable by *Call mapped function*. All three count in `callCount` and `totalCallSites`, and a function that has any of them is not listed in `uncalledFunctions`. Function names are matched ignoring case, as the editor does. Scripts are not scanned.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `detail` | string | No | Detail level |

### `get_object_dependencies`

Where objects are used: event sheets, layouts, families, co-occurring objects. Event sheet uses include object parameters, expressions and script actions; layout uses include instances on sub-layers, non-world instances and object properties of other instances that hold the object's SID (see [`find_orphaned_objects`](#find_orphaned_objects)). The project-wide `orphanedObjects` list follows the same rule as `find_orphaned_objects`, and `totalReferenced` counts the other objects (use through a family included), so the two add up to `totalObjects`. `orphanedFamilyMembers` (present when there are any) lists the orphans that are members of a family, as `{ name, families }`: `delete_object` refuses them until they leave the family.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object` | string | No | Specific object (omit for project-wide top 20) |
| `detail` | string | No | Detail level |

### `find_orphaned_objects`

Find objects not used by any event and not placed in any layout. No parameters.

An object counts as used when it is the object of a condition or action or the object a custom action block (`custom-ace-block`) defines its custom action for (the block's conditions, actions and sub-events count like any others), or through a family it belongs to (a family that events use), or when it has an instance on a layer or sub-layer (`layers[].subLayers`, nested to any depth) or among a layout's non-world instances (`nonworld-instances`, e.g. Array or Dictionary), or when an instance property of another object holds its SID (object properties such as the Particles *Object* property, which editor-saved projects store as the object type's SID). Events also use an object when (heuristics that rather find too many uses than too few):
- a parameter's whole value is its name, as in object parameters (`"object": "Sprite2"`, `"object-to-create"`, `"pin-to"`, `"child"`, ...), function call arguments included. Not counted: keys that hold other names (`"audio-file"`, `"instance-variable"`, `"variable"`, `"layout"`), and a bare name that is also a declared event variable or function parameter, since in an expression parameter a bare name is a variable (Construct 3 lets variables share names with objects). Object parameter keys count even then;
- a parameter expression uses it as `Name.` or `Name(` (`Sprite4.X`, `Sprite4(0).X`), outside `"..."` string literals and not as a member (`Label.Text` does not use an object named `Text`). An object parameter whose value is not a plain name (an expression written by hand) is scanned the same way;
- a script action or script event reads `runtime.objects.Name` or `runtime.objects["Name"]` (also through `this.runtime` and the like).

Only names of existing object types and families are matched. Not detected: project script files, dynamic lookups (`runtime.objects[name]`, destructuring) and objects created by name at runtime. `validate_project`, `get_object_dependencies`, `analyze_performance` and the `delete_object` reference check use the same index: every object `delete_object` refuses because of a use is not an orphan, and every orphan is deleted without `force`, except an orphan that is a member of a family no event uses. Such orphans list that family in `families`; `delete_object` refuses them until they leave the family (`update_family` with `removeMembers`).

### `get_asset_usage`

Track asset usage across the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"sound"` \| `"music"` \| `"image"` \| `"font"` \| `"video"` \| `"icon"` \| `"general"` \| `"all"` | No | Filter by asset type (default: all) |
| `detail` | string | No | Detail level |

Returns `{ summary, assets, notes }`. `summary` has `totalAssets`, `byType`, `usedCount`, `unusedCount`, `notAnalysedCount` and `mostReferenced`. Each asset has `name`, `type`, `status` (`used`, `unused` or `not-analysed`), `referencedIn` (`eventSheets`, `layouts`, and when found `objectTypes`, `scripts`, `flowcharts`, `timelines`, `projectFiles`), `via` (how it is referenced) and, when not used, a `reason`. `standard` detail lists 50 assets, unused and not-analysed first; `full` lists all.

- **Images** are object types with animations (sprites) or a single image (Tiled Background, 9-patch, Particles, Sprite font and other plugins that save an `image`), one entry per object type. A sprite has its `animations` and `frames` counts; a single-image object type has `frames: 1` and no `animations`. Animations are read as the editor saves them (`animations.items`, and the animations in `animations.subfolders`). An image is used when its object type is used by the rule of [`find_orphaned_objects`](#find_orphaned_objects) (used in an event, directly or through one of its families; an instance in a layout, sub-layers and non-world instances included; or named by an object property of another instance), or when System "Create object (by name)" creates it with a literal name.
- **Sounds and music** are used when an Audio file parameter names them (`"audio-file"`: the name without extension, saved as a string or as `{ "path": name }`), when a by-name Audio action (`"folder"` + `"audio-file-name"`) names them with a literal, or when a string in events, scripts, flowcharts, timelines, layout instance values or project files is their name. Tag, layer, animation and text parameters and properties, and instance variable definitions, are not file references.
- **Project files, fonts and videos** are used when a parameter, a string literal, a script, a layout or object type property (for example Video sources, or plugin properties naming data files), a flowchart or timeline string, or the text of another used project file names them. A Text object's `font` property and a CSS font declaration (`font-family: 'Pixel Sans'`, in HTML content, scripts or project files) name a font without its extension.
- **Not analysed** (never reported as unused):
  - icons (used by the export) and project files with a purpose other than `none` (such as stylesheets);
  - files a name built at runtime may produce: by-name Audio actions with an expression, `"prefix" & ...` or `... & ".ext"` concatenations, `ProjectFileNameAt()`, and in scripts `runtime.assets` calls with a computed name and `fetch()`, `import()` or XMLHttpRequest `open()` with a `"prefix" + ...` URL. A prefix that starts with a server URL (`https://...`, `//...`) does not name a project file;
  - objects that may be created or looked up by name: System "Create object (by name)" with an expression, a script that indexes `runtime.objects[...]` with a computed name or passes `runtime.objects` on (an alias, `Object.keys`), an object in a container, and an object whose name (or family name) appears in an expression, as a script identifier, or as a string literal in a parameter, variable or script;
  - what an unreadable file may name: an event sheet, script, layout, object type or family makes every unreferenced asset not analysed; a flowchart or timeline, the file assets; a project file, the file assets once that project file is itself used or not analysed.
- Names built at runtime without a literal part in the project (server data, user input), or by script code other than the calls above, are not seen.

### `analyze_performance`

Heuristic performance audit with categorized issues (info/warning/critical).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | Event sheet or layout name to scope analysis |
| `detail` | string | No | Detail level |

The frame count check reports object types with more than 50 animation frames, counting every animation, including those in animation subfolders.

### `validate_project`

Run integrity checks over the whole project: 30 checks, from file existence, required fields, duplicate SIDs/UIDs and broken references to the editor load-time rules, conditions and actions against Construct's own definitions ([ACE validation](#ace-validation)) and the expressions inside their parameters ([expression checking](#expression-checking)). No parameters.

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `valid` | boolean | No error-level issues were found in the files that were scanned |
| `complete` | boolean | Every registered object type, event sheet and layout file was read. `false` when any was skipped for exceeding the 10MB read cap (listed in `unscannedFiles`); `valid` then only vouches for the files that were checked. Families are not covered |
| `summary` | object | `{ errors, warnings, info, checksRun, entitiesScanned, unscanned }` |
| `errors` / `warnings` / `info` | `IntegrityIssue[]` | `{ check, entity, message, suggestion? }` |
| `unscannedFiles` | string[] | `category/name` entries the reader could not scan (over the 10MB read cap); each is also an `unscanned-file` warning |

- **Errors:** registered entities whose file is missing or not valid JSON (`file-existence`; a file that exists but exceeds the read cap is an `unscanned-file` warning instead), missing required fields in objects, sheets and layouts, internal `name` differing from the registered name, malformed subfolder entries (a subfolder without a name or `items`; the first unnamed subfolder directly under `timelines` is the editor's Transitions folder, see [`list_timelines`](#list_timelines), and is accepted), an image-backed object type without its `image` record (`object-image`), conditions/actions that name their behavior only under the legacy `"behavior-type"` key (`legacy-behavior-key`, see [`fix_legacy_behavior_keys`](#fix_legacy_behavior_keys)), and the editor load-time rules below
- **Warnings:** registered files over the read cap (`unscanned-file`), image files an object type declares but `images/` lacks and sprites or animations without frames (`object-image`; the extension comes from each image's `fileType`), duplicate SIDs and UIDs (except the SID duplicates listed below as errors), broken object references (conditions/actions on a class that is no object type, family, `System` or the built-in Functions object, which is named by `functionsName` in `project.c3proj`, `"Functions"` by default), behaviors and instance variables that events use but their object type or family does not have (`missing-behavior-or-variable`), layer names repeated within a layout (`duplicate-layer-name`), layouts bound to missing event sheets, broken includes, plugins or behaviors missing from `usedAddons`, leftover `"behavior-type"` keys next to a valid `"behaviorType"`, event shapes that differ from what the current editor saves (`legacy-event-shape`, see [`fix_legacy_event_shapes`](#fix_legacy_event_shapes): block-level `isElse`, per-condition `isOr` and function calls with `id`/`objectClass` or keyed parameters, which older versions of this server wrote and Construct 3 never writes, and scripts stored as one string or without `language`, the shape older Construct 3 releases saved, which is harmless to convert), other keys Construct does not read (`event-legacy-key`, below), conditions and actions that do not match their definitions (`ace-*`, see [ACE validation](#ace-validation)), expressions whose names do not resolve (`expression-*`, see [expression checking](#expression-checking)), entity files whose name differs from the registered name only in letter case (`file-name-case-mismatch`), layout instances without an entry for a behavior of their object type or its families (`missing-behavior-entry`, one warning per layout and object type with the instance UIDs; the editor saves an entry for every behavior, see [`add_instance_to_layout`](#add_instance_to_layout), and older versions of these tools placed instances without them), and the partly verified load-time rules below
- **Info:** JSON files in `objectTypes`, `eventSheets`, `layouts` and `families` (subfolders included) not registered in `project.c3proj`, leftover `.bak` files in `objectTypes`, `eventSheets`, `layouts`, `families`, `timelines` (subfolders included) and next to `project.c3proj`, used plugins and behaviors that are neither built in nor loaded with [`load_addon_definitions`](#load_addon_definitions) (`ace-definitions-unavailable`), and orphaned objects (see [`find_orphaned_objects`](#find_orphaned_objects))

The orphan-file scan compares project-relative file paths with registrations. It does not follow symbolic links, skips absent or unreadable directories, and skips the editor's Layout View state files (`layouts/uistate/`).

An `event-legacy-key` warning names a block, condition or action carrying a key Construct never writes and does not read, which no fix tool converts: `object-class` or `is-inverted` on a condition or action (Construct's keys are `objectClass` and `isInverted`; with the wrong key the editor reports the ACE as a missing action or condition id on load), or `isOr` on a block (an OR block is marked with `isOrBlock`). The legacy `behavior-type` key, a block-level `isElse` and a condition-level `isOr` are reported by `legacy-behavior-key` and `legacy-event-shape` instead, with the tools that convert them; the keys `event-legacy-key` names are fixed by hand: rename each to Construct's key in the sheet file with the project closed in Construct. `fix_legacy_event_shapes`, `fix_legacy_behavior_keys` and `update_event_block` leave these keys in place (`update_event_block` with `isOrBlock: true` adds `isOrBlock` to a block but keeps its `isOr`), so the warning's suggestion names no tool that converts them.

Entity files are checked against the path each registered entity is read from: `<category>/<project-bar folders>/<name>.json`, since Construct 3 mirrors its project-bar folders on disk. `file-name-case-mismatch`: a file whose path differs from that path only in letter case, such as `layouts/Layout1.json` for a layout `layout1` at the root, is the entity's file on case-insensitive file systems (Windows, macOS by default), where it loads, but may not be found on case-sensitive ones (Linux). The suggestion is to rename it to the expected path; it is never reported as orphaned. Any other file is `orphaned-file`, including a copy named like a registered entity in another folder; its message names the path that entity is read from. The editor's `*.uistate.json` view-state files are not entity files and are skipped.

`duplicate-uid`: instance UIDs (instances on layers and sub-layers, non-world instances, single-global instances) must be unique across the project; locations of sub-layer instances name the layer path (`layouts/Layout1/layer:Main/layer:HUD/inst:Sprite`). According to Scirra ([Construct-bugs #8725](https://github.com/Scirra/Construct-bugs/issues/8725)), Construct 3 tries to cope by reassigning duplicated UIDs, which can still break hierarchies, timelines and events that refer to a specific UID, so re-saving is no fix: give the duplicates new unused UIDs by hand. Duplicates usually come from merging branches; projects edited on several branches should set the "UID numbering" project property to Random.

**Editor load-time rules.** The Construct 3 editor enforces these only when it opens a project, and breaking one can make the whole project fail to open. The rules come from [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT) and were checked against the Construct 3 manual, real editor-saved projects, and the error messages of the editor's project loader (release r495.2). Where only part of a rule could be verified, it is reported as a warning.

| Check | Severity | Rule |
|-------|----------|------|
| `expression-syntax` | error | A backslash outside a string literal, or an unterminated string literal, in any condition/action parameter (function and custom action call arguments included). C3 expressions have no escape sequences: a quote inside a string is written as two quotes (`"He said ""hi"""`), so `"{\"a\":1}"` fails with *Syntax error: Unknown character*. A backslash inside a string literal is fine. |
| `empty-expression` | error | A parameter whose value is `""` fails with *Empty expression: You must enter an expression*. Write an empty string literal as `"\"\""`. |
| `trigger-placement` | error / warning | Only one trigger per event, unless it is an OR block (`"isOrBlock": true` on the event), which may hold several. A branch holds one trigger: no trigger in a sub-event of a triggered event, of a function block or of a custom action block. Both fail with *cannot add another trigger to event branch*. Groups are transparent. A trigger that is not the first condition of its event is a warning: the editor moves it to the top when it opens the project. Triggers are conditions whose id starts with `on-`; the editor counts fake triggers (*On collision*, Timer *On timer*, Gamepad buttons) as triggers too. Problems involving third-party addon triggers are warnings, since those addons do not always follow the `on-` convention. |
| `else-placement` | warning | An else block (System `else` first condition) must come after a block without a trigger, with at most comments between them, and must not hold a trigger itself. The manual: *Else can only follow normal (non-triggered) events*; every else block in editor-saved projects follows such a block, directly or after comments. A trigger after `else` would be moved before it when the editor opens the project (see `trigger-placement`), so for else blocks this rule reports it instead. A block whose `else` condition is disabled (`"disabled": true`, which the editor saves in place) is an ordinary block, because a disabled condition is ignored when the event runs: the rule does not apply to it, and a trigger after a disabled `else` is judged by `trigger-placement` like any other block. Whether the editor refuses to open a project that breaks the rule is not verified. |
| `duplicate-object-name` | error | Object types and families share one name namespace that ignores case. A name listed twice in the `project.c3proj` objectTypes or families tree, two names that differ only in case, and a family named like an object type all fail with *object class name 'X' already used*. The editor also creates the built-in System object and the built-in Functions object (named by `functionsName` in `project.c3proj`, `"Functions"` without it) in the same namespace for every project, so an object type or family named like either, ignoring case, fails the same way. |
| `family-plugin-mismatch` | error / warning | Every member of a family must use the same plugin; a mixed family fails with *wrong plugin* (error). Members that agree with each other but not with the family's `plugin-id` are a warning. |
| `duplicate-sid` | error / warning | Two object types or families sharing a SID fail with *object class sid already in use* (error). A SID shared by behaviors or instance variables of object type or family files is a warning: SIDs should be unique, but no load failure is on record for this clash, and the editor's loader checks only object type and family SIDs. Animation and frame SIDs repeated across object types are warnings: a Scirra example project does this and opens. SIDs shared by events, conditions, actions or layout instances are warnings: editor-saved projects contain such duplicates and open, and the editor keeps them when it saves, so re-saving does not fix them. A clash involving a function or custom action parameter is a warning that may break loading, since the loader checks function parameter SIDs. Event sheet locations name the event path and the condition/action index (e.g. `eventSheets/Sheet1 > block (sid 12) > action 0 "wait" (System)`), and an event's own location ends with its JSON path (`eventSheets/Sheet1 > block (sid 12) at events[0].children[1]`), so events sharing a SID under the same parent can be told apart. When events in one sheet share a SID, whatever else also uses it, the suggestion adds that the SID-based event tools refuse it there unless `eventPath` names one of them (see [Events that share a SID](#mutation-tools)); a SID used more than five times lists the first five locations and a count per file, and the paths of the others come from the refused tool call or [`locate_event`](#locate_event). Layout `instanceFolderItem` SIDs legitimately repeat the instance SID and are not checked. |

`broken-object-reference`: what `delete_object` and `delete_family` with `force: true` leave behind. Reported are a name that is no object type, family, `System` or the built-in Functions object, used as the object of a condition or action or as the whole value of an object parameter (`"object"`, `"object-to-create"`, `"pin-to"`, `"child"`); layout instances (on any layer or sub-layer, or non-world) of an object type that does not exist, one warning per layout and type with the instance UIDs; family members that are no object type (one warning per family); and object properties that hold the SID of no object type or family. The only object property known to hold a SID is the Particles `"object"` property (`-1` when no object is set), so only that one is checked. Not reported: uses of a deleted object or family in expressions and scripts, which are only recognised by the names of existing objects; the `force` warnings of `delete_object` and `delete_family` list them. Uses of a deleted family's instance variables and behaviors through its members are `missing-behavior-or-variable` (below). What Construct 3 does with these leftovers when it opens the project is not verified, so they are warnings.

`missing-behavior-or-variable`: what `update_object_properties`, `update_family` and `delete_family` with `force: true` leave behind. Reported are conditions and actions whose `"instance-variable"` parameter or `behaviorType` names an instance variable or behavior their object type does not have, neither itself nor through one of its families, an `"instance-variable"` parameter of the form `{ name, objectClass }` (System actions such as *Sort Z order*) whose object type does not have the variable, and `Object.Behavior.Expression` or `Self.Behavior.Expression` in parameter expressions whose middle part names no behavior of that object type or its families. A family's conditions, actions and expressions reach only the family's own instance variables and behaviors, so for a family the family itself is checked. One warning per event sheet, object and name, with the locations (`block > action:0 at events[3]`: the event path, which sibling events share, and the JSON path of the event) and the names the object has. Names are compared ignoring case. Not reported: `Object.name` or `Self.name` whose name is neither an instance variable nor a behavior, since it can be one of the plugin's expressions (`Sprite.X`), conditions and actions on an object that does not exist (`broken-object-reference`), the legacy `"behavior-type"` key (`legacy-behavior-key`), scripts and timeline tracks. What Construct 3 does with such a use when it opens the project is not verified, so these are warnings. None of the editor-saved projects checked has one.

`duplicate-layer-name`: two or more layers of one layout, sub-layers included, whose names are the same ignoring case, one warning per layout and name with the layer paths. The editor's project loader (release r495.2) looks layer names up ignoring case over all layers of a layout and cannot load such a layout; this was not reproduced in the editor, so it is a warning. [`update_layer`](#update_layer) can rename one of them: it finds a sub-layer by its path, such as `"Main > HUD"`.

### ACE validation

Conditions and actions of Construct's built-in plugins and behaviors are checked against the definitions Construct r495.2 ships to its own editor. `add_event_block`, `update_event_block`, `update_event_block_action`, `replace_object_in_events` and `replace_in_expressions` warn about the conditions and actions they write or change, and `validate_project` reports the same problems across the whole project. A warning never blocks the write.

| Problem | Warning or check | Example |
|---------|------------------|---------|
| The plugin or behavior defines no such condition or action | `ace-unknown-ace` | `on-start-of-layuot` on System |
| A parameter the ACE does not define | `ace-unknown-parameter` | `z` on the Sprite action `set-position` |
| A parameter the ACE defines is absent | `ace-missing-parameter` | `set-position` with only `x` |
| A combo parameter holds something other than one of its choices | `ace-invalid-choice` | Platform `simulate-control` with `control: "fly"`; the choices are `left`, `right`, `jump` |

What is checked and what is not:

- `objectClass` is resolved to its object type's or family's plugin, and `behaviorType` to the behavior of that name on the object, on a family it belongs to, or on a family's member. `System` is the System object.
- The common ACEs Construct adds to plugin objects by capability (instance variables, position, size, angle, appearance, Z order, hierarchy, effects, picking, destroy) are accepted on any plugin object, not only those that have the capability.
- A third-party addon is checked the same way once its definitions are loaded: set `C3_ADDON_DEFINITIONS` (paths separated by the platform's path delimiter, each an unpacked addon folder, a `.c3addon`, or a folder holding several) before starting the server, or call [`load_addon_definitions`](#load_addon_definitions). Until then its ACEs are skipped, and `validate_project` lists it as an `ace-definitions-unavailable` info entry.
- Skipped: ACEs of addons with no definitions loaded, of objects the project does not declare, function and custom action calls, scripts, comments, and positional parameters.
- Parameter values other than combo choices are checked only as expressions, below; a number or string value is not checked for its type.

### Expression checking

The value of every parameter whose declared type holds an expression (`number`, `string`, `any`, `layer`, `animation`, `keyb`, `functionname`, `flowchart-string`; a `layout`, `object`, variable or combo value is a bare name or choice and is not one), and every argument of a function or custom action call, is parsed as a Construct expression and its names are resolved against the project and the catalogue. The same tools report these as warnings, and `validate_project` reports them across the project under these checks:

| Check | Meaning | Example |
|---------|------------------|---------|
| `expression-syntax` | The text does not parse: an unbalanced parenthesis or quote, a `?` without its `:`, or a character that is not part of an expression | `Player.X +` |
| `expression-unknown-object` | The name before a dot is not an object type or family of the project | `Ghost.X` |
| `expression-unknown-member` | The object has no expression, instance variable or behavior of that name (a family's instance variables count for its members), or a behavior is named without one of its expressions | `Player.Speeed`, `Player.Platform.Vector` |
| `expression-unknown-function` | A call to a name that is not a system expression, or `Functions.Name(...)` naming no function of any sheet | `distanse(1, 2, 3, 4)` |
| `expression-unknown-name` | A bare name that is not a system expression, an event variable, a function or custom action parameter, or an object | `Scor + 1` |
| `expression-argument-count` | A system, plugin or behavior expression, or a function, called with the wrong number of arguments (a variadic one with too few) | `distance(1, 2)` |

What is resolved: plugin and behavior expressions and the editor's common expressions (`X`, `UID`, `Count`, ...) by their written names, without case; instance variables of the object and of its families; behaviors by name, then their expressions; the functions namespace (`Functions`, or the project's `functionsName`) with each function's parameter count and `CallMapped`; `Self` as the object the condition or action belongs to; event variables and function or custom action parameters declared anywhere, without scope analysis; an instance index after an object name (`Player(2).X`). A third-party plugin or behavior without loaded definitions accepts any member. Checked against the 4,757 parameter values of one large game project: 0 problems.

Not checked: the type a parameter expects against the type an expression yields, string contents, and which variables are in scope at a given event.

The catalogue is `src/construct3/ace-catalog-data.ts`, generated by `scripts/build-ace-catalog.mjs` (see [DEVELOPMENT.md](DEVELOPMENT.md#ace-catalogue)).

### `load_addon_definitions`

Load a third-party addon's conditions and actions so the ACE checks cover it. Without `path`, list the definitions loaded so far.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | An unpacked addon folder (holding `addon.json` and `aces.json`), a `.c3addon` file, or a folder holding several of either |

Returns `loaded` (id, type, name, version, source and the counts of conditions, actions and expressions read), `nowLoaded` (every definition held by this server process), and `warnings` naming each path that could not be read and why. Only plugins and behaviors define ACEs; an effect is skipped with that reason. Definitions stay loaded for the life of the server process and apply to every project it serves.

### `get_group_settings`

Event group settings across event sheets: title, sheet, `isActiveOnStart`, `disabled`, nesting depth, parent group, child group and event counts. Returns `groups`, `summary` (totals) and `bySheet`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `activeOnly` | boolean | No | Only groups with `isActiveOnStart = true` |
| `inactiveOnly` | boolean | No | Only groups with `isActiveOnStart = false` |

### `locate_event`

Map an editor event number, as shown in the event sheet margin and in errors such as `es_game, event 72, action 1`, to the event's JSON path. Script syntax errors raised by the editor word it as `es_game, number 72, action 1, line 3`; the number is the same event number. The editor number is not the index into `events[]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheet` | string | Yes | Event sheet name |
| `eventNumber` | integer ≥ 1 | Yes | Event number as shown by the editor or an error message (`event N` or `number N`) |
| `conditionNumber` | integer ≥ 1 | No | Condition within the event (1-based) |
| `actionNumber` | integer ≥ 0 | No | Action within the event, counted from `actionIndexBase` (by default `action M` is `actions[M-1]`) |
| `countActionComments` | boolean | No | Count action comment rows (`{ "type": "comment" }`) when resolving `actionNumber` (default `true`, verified for runtime script errors). Disabled action rows always count |
| `actionIndexBase` | integer 0-1 | No | Number of the first action: `1` (default, verified for runtime script errors) or `0` (editor load errors according to c3-skill, unverified) |

Returns JSON with:

- `event`: `number`, `path` (e.g. `events[3].children[1]`), `sid`, `kind` (`block`, `else`, `group`, `function`, `custom-ace`, `script`, or `unknown` for an event type this server does not know), `eventType`, `depth`, `disabled`, `enclosingGroups`, `enclosingFunction`, a one-line `summary`, and numbered `conditions` and `actions` lists
- `condition` / `action` (when requested): `number`, `index` and `path` (the item's position in the JSON, e.g. `events[3].children[1].actions[0]`), `kind`, `sid`, `disabled`, `text`
- `previousEvent` / `nextEvent`: events n-1 and n+1, so you can check the mapping against the editor
- `numbering`, `notes` (assumptions that affect this answer), `warnings`

An event, condition or action number that is out of range returns an error that names the valid range. When `countActionComments=false` skipped comment rows, the error also says so and names the action that counting them would pick.

When `actionNumber` is given, `notes` always names the action the other `actionIndexBase` would pick, because the base is only verified for runtime script errors. It also says when the action is a comment row, which cannot raise an error.

**Numbering rules.** Events are numbered in display order: a depth-first walk of `events[]` where each event's `children[]` come right after it. This covers group contents, sub-events and function bodies. Numbers are 1-based and start again at 1 in each sheet. Blocks (including else, OR and disabled blocks), groups, functions, custom ACE blocks and script blocks get a number. Variables, includes and comments do not. A function's own conditions and actions belong to the function's event number.

These rules come from [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT). They were checked against 32 exported projects (r232 to r466): the display number that the editor writes into each event of an export's `data.json` matched this walk for every event whose export and source still agreed (1219 events). The runtime prints script errors as `Unhandled exception running script <sheet>, event <display number>, action <index + 1>`. Exports of further projects (r449) that contain event-level script blocks, one of them nested two levels deep inside sub-events, confirm that a script block takes one number at its depth-first position and that every later event keeps matching.

Disabled events keep their numbers, also when only a parent group or event is disabled; the export leaves a gap for them.

Action comment rows count toward `action M`. Exports remove the comment rows but keep each script action's index. In [AshleyScirra/CommandAndConstruct](https://github.com/AshleyScirra/CommandAndConstruct), `Multiplayer join events` event 5 (function `StartJoinAttempt`) has a comment row at `actions[4]` and a script at `actions[5]`. The live export has four actions and then the script with index 5 (`MultiplayerJoinEvents_Event5_Act6` in `scriptsInEvents.js`). So a runtime error in that script reads `action 6`, which is `actions[5]` only if the comment row is counted. `countActionComments=false` gives the other reading.

Disabled action rows count too. Exports drop disabled actions just as they drop comment rows, but each script action keeps its `actions[]` index: a script after two disabled rows at `actions[2]` keeps index 2 and reads `action 3`. `countActionComments` does not change this.

Not verified:

- How errors that the editor raises itself (e.g. `Empty expression` when loading a project) number actions. c3-skill (`references/c3-json-surgical-rewrites.md`) says that for these errors `actions[j]` is `action j`, counted from 0. The editor's message strings do not settle it. Use `actionIndexBase`; `notes` always gives the other reading.
- Whether editor load errors number events the same way as the runtime.
- Whether condition numbers are 1-based. `locate_event` assumes they are, like action numbers.
- How event types this server does not know are numbered. They are counted as events, and a warning says so.

The walk stops at sub-events nested deeper than 50 levels, or after 100,000 rows, and says so in `warnings`. It does not skip them: that would give every later event a wrong number. Events after that point are reported as out of range.

A block whose `else` condition is disabled is shown as an ordinary block (kind `block`, header `IF System.else() [disabled] AND ...`), since the disabled condition is ignored when the event runs; only an enabled `else` gives kind `else` and an `ELSE` header.

`isElse` on a block and `isOr` on a condition are flags that the event tools of construct3-mcp 1.8.1 and earlier wrote. Construct 3 does not write them: real sheets mark an else block with a System `else` first condition, and OR a block's conditions with the block's `isOrBlock`. Both tools show such blocks as stored, marked `[non-standard isElse]` or `[non-standard isOr]`, with a warning that points to [`fix_legacy_event_shapes`](#fix_legacy_event_shapes). A condition or action that names its behavior only under the legacy `"behavior-type"` key (written by construct3-mcp 1.8.1 and earlier, which Construct 3 does not read) is shown with its behavior, marked `[legacy behavior-type]`, and a warning points to [`fix_legacy_behavior_keys`](#fix_legacy_behavior_keys).

### `get_eventsheet_outline`

A compact, readable outline of an event sheet that uses editor event numbers. It is paged for large sheets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheet` | string | Yes | Event sheet name |
| `startEvent` | integer ≥ 1 | No | First event number to show (default 1) |
| `limit` | integer 1-1000 | No | Maximum events per page (default 100). With `maxDepth`, only the events shown count, so a page of a large group is not filled by hidden events. A page can end earlier because of the size budget (below) |
| `maxDepth` | integer 0-50 | No | Deepest nesting level to print (0 = top level only). Deeper events keep their numbers but are replaced by a `… events X-Y hidden` line |

Returns plain text: a header (event counts, the page range and the next `startEvent`, the numbering rule), then one line per row. Rows without an editor number are marked `-`. A page that starts inside a group, block or function begins with an `(inside event N: …)` line for each enclosing row. Each event lists at most 50 actions, followed by a `… (+N more actions; …)` line, and its header at most 50 conditions, followed by `… (+N more conditions)`; `locate_event` with `actionNumber` shows any single action.

**Size budget.** A page holds at most about 40,000 characters (roughly 10,000-13,000 tokens). This keeps it under common MCP client output limits, such as Claude Code's default `MAX_MCP_OUTPUT_TOKENS` of 25,000 tokens, which cut longer results. When the next event would take the page past the budget, the page ends before that event, even if fewer than `limit` events are shown, and the header says so:

```
Showing events 1-38. Page ended at the ~40000-character size budget before limit=100 was reached. Next page: startEvent=39.
```

A page always shows at least one event, so a single event larger than the budget is shown whole. Pages end only before an event that is shown, so the next page can start there. Follow `Next page: startEvent=N` until the header has no next page; do not assume that a page holds `limit` events.

```
 - VAR Score: number = 0
 - INCLUDE Common
 - COMMENT: Main logic
 1 GROUP [Movement]
 2   IF System.on-start-of-layout()
         DO Player[Platform].set-max-speed(max-speed=300)
         CALL Spawn("Enemy", 3)
         SCRIPT: runtime.globalVars.Score = 0; (+1 lines)
 3     IF NOT Player[Platform].is-on-floor()
 4     ELSE
           DO Enemy.destroy()
 -   COMMENT: sub comment
 -   VAR speed: number = 5 [static]
 5   IF Keyboard.key-is-down(key=37) OR Keyboard.key-is-down(key=39) [disabled]
         DO Player.set-x(x=Self.X + 1) [disabled]
```

`NOT` marks an inverted condition, `OR` joins the conditions of an OR block, and `[disabled]` marks disabled events, conditions and actions. `Obj[Behavior].ace-id` names a behavior ACE. Script actions show their first line. Functions and custom ACE blocks list their own conditions after the signature, e.g. `FUNCTION PlayAll() IF System.for-each(object=iframe)`. A custom action call that runs a family's custom action on an object type that overrides it shows the family as the editor does: `CALL monkey.PlayAnimation (Animals)()`.

### `find_runtime_traps`

Find event logic that loads fine but hangs or throws at runtime. Read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Only report issues located in this sheet (signal tags are still matched across all sheets) |
| `detail` | string | No | `summary` (first 10 issues, without suggestions, at most 3 related locations each), `standard` (all issues), `full` (issues + complete signal map) |

**Checks:**

| Check | Severity | Finding |
|-------|----------|---------|
| `signal-pairing` | warning | *Wait for signal* (or `runtime.waitForSignal()`) tag that no *Signal* action or `runtime.signal()` call raises anywhere: the wait can never finish. Reported as info instead when a signal with a non-literal tag may produce it, or when an event sheet could not be read. |
| `signal-pairing` | info | *Signal* nobody waits for or listens to; *On signal* nothing raises; tags that are not string literals (cannot be analyzed statically) |
| `signal-order` | info | *Wait for signal* whose tag was already raised before the wait starts, so the wait misses it: a *Signal* with that tag earlier in the same event or a parent event, or an earlier call (`callFunction` action, or `Functions.Name(...)` in an expression or condition) to a function that raises it before returning. A function raises a tag before returning when its *Signal* is reached on an unconditional path (no enabled conditions on the way) without passing a *Wait*, *Wait for signal* or *Wait for previous actions to complete* in its own event or an enclosing one; a *Wait* defers only the rest of its own event, so sibling sub-events after it still count. Calls are followed transitively, and a tag passed as a literal argument to a function that signals its parameter counts. Scripts are not followed. |
| `script-function-parameter` | warning | Script action/block inside a function block or custom action block (`functionParameters`) that uses a parameter as a bare JS identifier; it must be `localVars.<name>` |

A function registered in a function map (*Map function* / *Map function default* on the Functions object) can be called by *Call mapped function* with arguments chosen at runtime, so a tag forwarded through its parameters is treated as able to hold any value; mapped calls are not followed by `signal-order`, and a note says so when the project has function maps. Tags compare case-insensitively. A non-literal tag that starts with a literal (`"button_" & Button.type`, or `"step" + n` in a script) may produce any tag with that prefix: *On signal "button_ok"* next to it is not reported, and it only downgrades waits whose tag has that prefix. A *Signal* whose tag is a parameter of its function is resolved through the arguments at the function's call sites (event `callFunction` actions, `Functions.Name(...)` calls in expressions and `runtime.callFunction()` in scripts; function names compare case-insensitively). Disabled events, conditions and actions (`"disabled": true`) are skipped; groups that are only inactive on start are scanned. Names imported or declared in the *Imports for events* script (per language) count as in scope for scripts. Per-instance signals (the common *Signal* / *Wait for signal* / *On signal* of objects) are not analyzed. Script files are not scanned for `runtime.signal()`. In script actions, calls on `runtime`, on `x.runtime` (`inst.runtime`, `this.runtime`: the same IRuntime) and on a local alias (`const r = runtime`) are recognized, also as `runtime["signal"](...)`; a runtime passed in through a function parameter is not, and `inst.signal()` is a per-instance signal. A name the script declares itself (`let mode`) is not reported as a bare parameter use; a parameter of the script's own function or `catch` only hides the name inside that function. In TypeScript scripts, type positions (annotations, return types, `as` types, type arguments, index signatures) are ignored. Script actions are read in both saved shapes (`script` as a string or as an array of lines).

Locations are paths of event types (`function:Name > block > action:3`); `action:N` is the 0-based index into the event's `actions` array, not the action number the editor shows. Entries of `related` and of the signal map end with the SID of the event that holds the ACE (`(sid N)`), which the SID-based event tools accept; an event without a SID gets its index among its siblings instead (`block#2`).

**Response:**
```json
{
  "summary": { "warning": 1, "info": 0, "sheetsScanned": 3, "scriptsScanned": 2, "signalTags": 4 },
  "issues": [{
    "severity": "warning",
    "check": "signal-pairing",
    "location": "Battle > function:DoAttack > block > action:3",
    "eventSid": 123456789012345,
    "tag": "swingDone",
    "message": "Wait for signal \"swingDone\" can never finish: ...",
    "suggestion": "Add Signal \"swingDone\" where the awaited work completes, ...",
    "related": ["Battle > function:DoAttack > block > action:3 [Wait for signal] (sid 123456789012345)"]
  }],
  "notes": ["Signal tags are compared case-insensitively.", "..."]
}
```

### Usage queries

All read-only.

| Tool | Parameters | Returns |
|------|------------|---------|
| `get_project_properties` | none | `topLevel` (every top-level `project.c3proj` key except entity trees) and `properties` (the full settings bag) |
| `search_project` | `query`, `regex?`, `caseSensitive?`, `wholeWord?`, `scopes?` (`events`, `scripts`, `layouts`; default events and scripts), `sheets?`, `maxResults?` (default 200, max 1000) | `hits[]` of `{ where, file, eventSid?, path, field, text }`, `totalHits`, `truncated`. Event hits cover every string in the sheet (parameters and expressions, comments, names, titles, script lines) except the `eventType`, `type` and `language` keys; script hits give the line number |
| `find_behavior_usage` | `behaviorName?`, `behaviorId?` (at least one) | `declarations` on object types and families, `eventReferences` (conditions and actions with that `behaviorType` on the owner, a family member, or the family), `instanceSettings` (placed instances with their own behavior properties) |
| `find_effect_usage` | `effectId?`, `effectName?` (at least one) | `uses` on object types, families, layouts and layers, and `instanceStates` (per-instance `effects` entries) |
| `find_instance_variable_references` | `objectName` or `familyName`, `variableName` | `references` (`instance-variable` ACE parameters and `<Object>.<variable>` expressions, including positional call arguments) with the nearest event SID, and `storedValues` on placed instances. Uses the same rules as `update_instance_variable` |
| `get_instance_counts` | `objectName?`, `layoutName?` | `objectTypes[]` of `{ objectType, total, byLayout }` sorted by count, `notPlaced`, `totalInstances` |

References inside script actions, script files, and names built by string concatenation are not detected by the usage tools; `search_project` finds them as text.

---

## Mutation Tools

Mutation tools that write through the project writer (objects, families, event sheets, layouts, animations, project metadata, addon auto-registration) follow the safety pipeline: validate → backup → write → verify → invalidate caches. So do script and project file registration and the runtime bridge's registration in `project.c3proj`. The other write paths do less: the tools that write their own files (timelines and eases, flowcharts, containers, tilemap brushes, `register_addon` / `unregister_addon`, the rename and duplicate tools, the runtime bridge script and `scripts/main.js`) back each file up to `<file>.bak` once per call and write through a temp file and rename (the bridge script and `main.js` in place), but do not read the result back. A replaced image is backed up; a placeholder PNG is written without a backup, and the change journal reports it as not restorable. Mutation tools return a `WriteResult` object on success.

**Text style.** Writes through the project writer, the timeline and ease tools, `register_addon` / `unregister_addon`, and the flowchart, container, tilemap brush, rename and duplicate tools keep an overwritten file's line endings (LF or CRLF), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style: tab-indented JSON with LF line endings, no trailing newline and no BOM. Only files already in that tab layout get line-level diffs; files indented another way are re-indented in full. A leading BOM does not stop these tools from reading a file. Tilemap brush files are the exception in layout: Construct 3 writes them as one line of compact JSON, so the tilemap brush tools write a new brush file that way and keep an existing file's layout (compact, or its own indent string) together with its line endings, trailing whitespace and BOM.

**Names and file names.** Entity files are named after the entity (`<category>/<folders>/<name>.json`, folders mirroring the project bar), and on Windows and macOS names that differ only in case name the same file. Create and rename tools therefore compare names the way the Construct 3 editor does: event sheet and layout names project-wide ignoring case, object type and family names in one namespace ignoring case, layer names per layout ignoring case (sub-layers included; the editor cannot load a layout with two such layers), animation names per sprite ignoring case (in any animation folder), event variable names ignoring case within the variable's scope (see [Event variable names](#event-variable-names)), and sibling project-bar folders (`subfolder` segments) ignoring case — a case-only clash is refused with an error naming the existing entity or folder. Create tools also refuse to write an entity JSON file or a timeline file where one already exists, including one whose name differs only in case; nothing is backed up or replaced, and the error says to choose another name or, for a leftover of a deleted entity, to check and remove the file first. Placeholder PNGs are not covered: `create_object` and the animation tools write them over an image file of the same name in `images/`. Rewrites of an existing file keep its name on disk exactly, including case, and the `.bak` backup takes that name.

**Editor reload note.** Every response that reports a completed write includes `editorNote`: *"If this project is open in Construct 3, close and reopen it there before saving, or the editor can overwrite these changes."* The editor keeps an open project in memory, so saving from a session opened before the edit can overwrite it; its Project Bar reload (F9) re-reads script files only. A `WriteResult` with `success: true` counts as a write unless it is a dry run. Tools whose success does not imply a write carry no note: the `already_registered` no-op of `register_addon`, `fix_legacy_behavior_keys` with `dryRun: false` when it found nothing to rename, `fix_legacy_event_shapes` with `dryRun: false` when it found nothing to convert, `replace_object_in_events` and `replace_in_expressions` when nothing matched, `set_main_script` when the script already was the main script, `clone_project`, `export_for_preview` / `pack_project` with `injectBridge: false`, the project session tools `get_open_project`, `open_project` and `reload_project` (which write nothing), and the runtime connection and preview tools (`connect_to_game` through `stop_preview`, which drive a running game, not the project files). `revert_last_change` carries the note, since it rewrites project files. Error responses never carry the note, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

**Events that share a SID.** Event SIDs are not guaranteed to be unique: editor-saved sheets can contain two events with the same SID, and they open in the editor. The tools that find an event by SID (`delete_event_from_sheet`, `update_event_block`, `update_event_block_action`, `update_event_variable`, `update_event_group`, `update_comment`, `update_function`, `move_event_block`, `move_event_block_items`, and `move_events_between_sheets` for top-level events) refuse a SID that matches more than one event in the sheet, dry runs included, and write nothing. The error lists the matches in document order (the first 20, then a count of the rest): each one's JSON path (e.g. `events[3].children[1]`, the format [`locate_event`](#locate_event) returns), editor event number, enclosing group and function or parent event, and a one-line summary. Pass the path of the event you mean as `eventPath` (`eventPaths` for `move_events_between_sheets`, `sourceEventPath` and `targetEventPath` for `move_event_block_items`) to act on it; the path must point at an event with that SID, or the call is refused. A `parentSid` or `siblingSid` that places an event (`add_event_block`, `add_event_to_sheet`, `add_custom_action`, `move_event_block`) is refused the same way when several events share it. A unique SID works without `eventPath`, as before. The results of the single-event tools include the `eventPath` of the event they acted on. [`validate_project`](#validate_project) reports such SIDs as `duplicate-sid` warnings that name the same paths.

For a write through the project writer or a rename tool, the file's size and modification time must still match what the server last saw before it is backed up, so such a write never overwrites a save Construct made meanwhile (see [File stamps and the change journal](#file-stamps-and-the-change-journal)). Tools that read and write their own files (timelines, eases, flowcharts, containers, tilemap brushes, addon registration, script and project files) read the file fresh instead. Every result ends with the files the call changed.

Every tool that writes `project.c3proj` leaves it in the shape Construct r495.2 saves, so the editor's next save shows only its own changes. Script entries carry `script-info` instead of `file-info`, and an empty `models3d` folder is added after `flowcharts`. For a project an older release saved, `uidAllocationMode` is placed after `preloadSounds` and `scriptsType` last in `properties`, and a release-44903-or-older project's `zAxisScale` "normalized" is written as "regular", which r495.2 itself shows and saves for such a project. A project saved by r495.2 or later keeps its own order. `savedWithRelease` is never changed and `usedAddons` is never pruned.

### `create_object`

Create a new object type in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (unique, alphanumeric + underscore + spaces) |
| `pluginId` | string | Yes | Plugin ID: `"Sprite"`, `"Text"`, `"TiledBg"`, `"NinePatch"`, `"Audio"`, etc. |
| `isGlobal` | boolean | No | Auto-detected for known global plugins |
| `subfolder` | string | No | Subfolder path (e.g., `"UI/Buttons"`) |

**What it does:**
1. Validates name (uniqueness, reserved names, format). A name equal to an existing object type or family name, or to `"System"` or the name of the built-in Functions object (`functionsName`), ignoring case, is refused: the editor would fail to open the project (load-time rule `duplicate-object-name`, see [`validate_project`](#validate_project)).
2. Ensures plugin is registered in `usedAddons` (auto-adds known Scirra plugins)
3. Generates SID (+ UID for global plugins, + animation SID for Sprite)
4. Builds from plugin-specific template
5. Writes `objectTypes/<name>.json`
6. Adds name to `project.c3proj` objectTypes container

### `update_object_properties`

Update an existing object's instance variables and behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Existing object name, as registered: a name that differs only in letter case is refused as not found, naming the registered one |
| `isGlobal` | boolean | No | Change global status |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean", description?, showInPropertiesBar? }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |
| `force` | boolean | No | Remove instance variables and behaviors even if events use them (default: false) |
| `globalInstanceProperties` | object | No | Settings of a single-global object (Keyboard, Touch, Audio, Gamepad, LocalStorage...) merged into `singleglobal-inst.properties` |
| `globalInstanceTags` | string | No | Tags of the single-global instance |

**Removing what events use:** before anything is changed, the instance variables and behaviors to remove are checked against the events. A use is the `"instance-variable"` parameter or the `behaviorType` of a condition or action on the object, an `"instance-variable"` parameter that names the object itself as `{ "name": "hp", "objectClass": "Sprite" }` (the shape editor-saved System actions such as *Sort Z order* use, next to `"object": "Sprite"`), `Object.name`, `Object(0).name` or `Object.Behavior.Expression` in any parameter expression (function call arguments included), and `Self.name` or `Self.Behavior.Expression` in a parameter expression of a condition or action on the object. All these names are matched ignoring case: editor-saved projects spell object, instance variable and expression names in expressions in other case and open, and the `"instance-variable"` parameter and `behaviorType` are compared the same way, so a use that differs from the name only in letter case blocks the removal too (and `validate_project` does not report it). `Object.name` counts only when `name` is an instance variable or behavior of the object, since anything else there is one of the plugin's expressions (`Sprite.X`). A use that a family of the object still resolves after the removal (a family instance variable or behavior of the same name) does not count.
- If used and `force=false`: nothing is changed (`success: false`, `action: "update_blocked"`), also none of the other changes the call asks for. `message` sums up the uses; `references` holds `eventSheets` (names) and `uses` (`{ eventSheet, path, eventPath, sid, objectClass, kind, name, context, form }`), capped at 50 entries with `usesNotListed` counting the rest. `path` is the event path with the condition or action index (`block > action:0`), which sibling events share; `eventPath` is the JSON path of the event (`events[3].children[1]`), as [`locate_event`](#locate_event) returns it and the SID-based event tools take it; `sid` is the condition's or action's SID, when it has one. `kind` is `instance variable` or `behavior`, `context` is `condition`, `action` or `expression`, `form` is `instance-variable`, `behaviorType`, `legacy-behavior-type`, `behavior-expression` or `member-expression`
- If used and `force=true`: removes them with a warning that names the uses (they are NOT changed). [`validate_project`](#validate_project) then reports them as `missing-behavior-or-variable` (a behavior named under the legacy `"behavior-type"` key as `legacy-behavior-key`), except the uses written as `Object.name` or `Self.name` in expressions (form `member-expression`), which it cannot tell apart from the plugin's own expressions: a second warning lists those (`"Sheet1" block > action:0 at events[3]`)
- Scripts (script actions, script blocks and project script files) are not checked, since which object's instances they read cannot be told, and never block a removal. When a script reads a removed instance variable or behavior by name (`instVars.hp`, `instVars["hp"]`, `behaviors.Fade`, compared with their letter case, as in JavaScript) and the object no longer has one of that name, the result warns and says where, so the scripts can be reviewed
- Not checked: timeline tracks

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- Removing an instance variable or behavior that events still use is refused as described under *Removing what events use* above; placed instances (every layer depth and non-world) lose their entries for removed behaviors
- `globalInstanceProperties` and `globalInstanceTags` are refused for objects without `singleglobal-inst`; property keys not already stored produce a warning
- A new behavior is refused when a family already gives the object a behavior of that name, or when its addon is neither in `usedAddons` nor a known Scirra behavior (checked before anything is registered)
- If placed instances cannot be updated after the object file is written, the result is `success: false`, `action: "partially_updated"`, with `backupFile` and `writtenLayouts`
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)
- Updates the object's layout instances (all layers, sub-layers and `nonworld-instances`): each gets a default entry for an added behavior (see [`add_instance_to_layout`](#add_instance_to_layout)) and loses the entry of a removed one; existing entries keep their values and their order (a new entry goes next to the entries it follows in the editor's order)
- On any behavior or instance variable change, an instance that has no entry for another behavior of the object or its families (older versions of these tools placed instances without them) gets a default entry for it too, and a warning names these behaviors and counts the instances
- `description` sets C3's `desc` field and `showInPropertiesBar` sets `show` (defaults `""` and `true`). `update_family`'s `addVariables` accepts the same two options
- There is no `initialValue` parameter: a C3 instance-variable definition has no default-value field. A placed instance's starting value lives in that instance's own `instanceVariables` dict, set with `add_instance_to_layout` / `update_instance`
- To rename, retype or re-describe an existing variable, use `update_instance_variable`

### `reorder_behaviors`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` or `familyName` | string | One of them | Owner of the behaviors |
| `order` | string[] | Yes | Every behavior name exactly once, in the new order |

Returns `action: "unchanged"` when the order already matches.

### `update_instance_variable`

Edit an existing instance variable *definition* on an object type or a family, and keep placed instances and event-sheet references in sync.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | One of | Object type that owns the variable |
| `familyName` | string | One of | Family that owns the variable |
| `variableName` | string | Yes | Current variable name |
| `newName` | string | No | New variable name |
| `newType` | string | No | `"number"`, `"string"` or `"boolean"` — stored values are coerced |
| `description` | string | No | New description (C3 `desc`) |
| `showInPropertiesBar` | boolean | No | Show in the properties bar (C3 `show`) |
| `renameReferences` | boolean | No | Rewrite event-sheet references on a rename (default: false) |

Exactly one of `objectName` / `familyName` is required, and at least one of `newName`, `newType`, `description`, `showInPropertiesBar`.

**What it does:**
1. Reads the owning object type or family and locates the variable by name
2. On a rename: validates the new name and rejects a collision with another variable on the same owner, or — for a family — with a variable a member object type defines itself
3. On a rename: scans every event sheet for references (see below) and refuses the whole operation unless there are none or `renameReferences=true`
4. Writes the updated definition (`name` / `type` / `desc` / `show`), preserving every other field and the variable's `sid`
5. Renames the stored key and/or coerces the stored value on every placed instance of the affected object types, in all layers, nested sub-layers and non-world instances, across all layouts

**Affected object types:** for `objectName`, that object type. For `familyName`, every family member — C3 stores a family instance variable flat in each member instance's own `instanceVariables` dict.

**Event-sheet references** (both shapes confirmed against a production project):
- an ACE parameter keyed `instance-variable` whose value is the bare variable name, on an action/condition whose `objectClass` is the owner (or, for a family variable, the family or one of its members)
- expression text naming it as `<ReferringName>.<variableName>` in any other parameter value

Both are rewritten when `renameReferences=true`. A reference built by string concatenation, or written inside a JavaScript script action or a script file, is **not** rewritten; the result warns about this. An identically named variable on a different object type is left alone.

**Value coercion on `newType`:**

| To | Rule |
|-----|------|
| `string` | `String(value)`; `null`/`undefined` become `""` |
| `number` | `Number(value)`, falling back to `0` when not finite; `true`/`false` become `1`/`0` |
| `boolean` | JavaScript truthiness (`0` and `""` are false) |

### `list_containers`

List the project's object containers. A container makes C3 create, pick and destroy a set of object types together.

No parameters. Returns `{ containers: [{ members }], count }`.

Containers have no name and no file of their own: the whole set lives in a flat `containers: [{ "members": [...] }]` array at the root of `project.c3proj`, so a container is identified by any one of its members.

### `create_container`

Create an object container from existing object types.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `members` | string[] | Yes | Object type names (1-100; 2 or more for a meaningful container) |

**Behavior:**
- Every member must exist as an object type; a family is rejected with an explicit message (containers hold object types only)
- An object type may belong to at most one container; a member already held by another container is rejected and nothing is written
- A member listed twice in one request is rejected
- A single-member container is accepted with a warning: C3 containers are only meaningful with 2 or more members
- Backs up `project.c3proj`, writes it through a temp file and rename, then reloads the project

### `update_container`

Add or remove object types in an existing container.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `member` | string | Yes | Any object type currently in the container to update |
| `addMembers` | string[] | No | Object type names to add |
| `removeMembers` | string[] | No | Object type names to remove |

**Behavior:**
- `member` identifies the container; an object type in no container is an error
- `addMembers` runs the same validations as `create_container`
- A duplicate add or an absent remove warns and is skipped; it is not an error
- Removing the last member deletes the container and reports `action: "deleted"`
- When the last container in the project is removed, the `containers` key is dropped from `project.c3proj`

### `delete_container`

Delete the container that includes the named object type. The object types themselves are not deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `member` | string | Yes | Any object type currently in the container to delete |

### `delete_object`

Delete an object type from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references in event sheets, layouts, and families (what counts as a reference: see [`find_orphaned_objects`](#find_orphaned_objects); project script files are not scanned): uses in events, instances on any layer or sub-layer and non-world instances, object properties of other instances that hold its SID, and membership in any family
- If referenced and `force=false`: blocks (`action: "delete_blocked"`) and lists where the object is used. `message` sums it up; `references` holds `eventSheets`, `layouts` and `families` (names), `events` (`{ eventSheet, path, context }` with `context` `condition`, `action`, `parameter`, `expression`, `script` or `custom-action`), `instances` (`{ layout, layer, instances }` per layout and layer, `layer` being a path such as `"Main > HUD"` for a sub-layer and absent for non-world instances) and `instanceProperties` (`{ layout, layer, objectType, uid, property }`). Each list is capped at 50 entries; `eventsNotListed`, `instancesNotListed` and `instancePropertiesNotListed` count the rest
- If referenced and `force=true`: deletes with a warning that names the remaining uses (references NOT cleaned up). [`validate_project`](#validate_project) then reports the dangling instances, object parameters, family memberships and Particles object properties as `broken-object-reference`, but not the uses in expressions and scripts: a second warning lists those
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info at any subfolder depth if its directory is readable), never a registration that points at nothing; the error names the file to clean up

### `create_family`

Create a new family. Families group object types of one plugin and share instance variables and behaviors across them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name (unique) |
| `pluginId` | string | Yes | Plugin ID all members share (e.g. `"Sprite"`, `"Text"`) |
| `members` | string[] | No | Initial member object names (default: `[]`); unknown names produce a warning |
| `subfolder` | string | No | Subfolder path (e.g. `"UI"`) |

**Load-time checks** (see [`validate_project`](#validate_project)): a name equal to an existing object type or family name, or to `"System"` or the name of the built-in Functions object, ignoring case, is refused (`duplicate-object-name`). Members must all use one plugin: a member whose plugin differs from the others is refused (`family-plugin-mismatch`, *wrong plugin*). Members that agree with each other but not with `pluginId` only produce a warning. Members that do not exist produce a warning.

### `update_family`

Add or remove family members, shared instance variables and shared behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name, as registered: a name that differs only in letter case is refused as not found, naming the registered one |
| `addMembers` | string[] | No | Object names to add |
| `removeMembers` | string[] | No | Object names to remove |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean", description?, showInPropertiesBar? }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId, name }]` added to the family's `behaviorTypes`; the addon is registered if needed |
| `removeBehaviors` | string[] | No | Family behavior names to remove |
| `force` | boolean | No | Remove instance variables, behaviors and members even if events use them (default: false) |

At least one parameter besides `name` must be provided. Duplicates and missing entries are skipped with a warning.

**Removing what events use:** before anything is changed, the removal is checked against the events, with the uses and matching rules of [`update_object_properties`](#update_object_properties). A family's conditions, actions and expressions (`Family.name`, `Self.name` on the family) reach only its own instance variables and behaviors; a member object type reaches its own and those of all its families.
- `removeVariables` and `removeBehaviors`: uses on the family itself, and uses through a member that gets the variable or behavior from this family only (not one it declares itself or also gets from another family)
- `removeMembers`: uses through a leaving member of the family's instance variables and behaviors that it gets from this family only. Whether events that use the family itself rely on the member being in it (they no longer pick or affect its instances) cannot be checked: removing a member while events use the family succeeds with a warning that counts those uses
- If used and `force=false`: nothing is changed (`success: false`, `action: "update_blocked"`, `references` as for `update_object_properties`, where `objectClass` is the family or the member the use goes through). With `force=true` the change goes ahead with the same warnings as in `update_object_properties`
- Scripts: as in `update_object_properties`, a warning when scripts read by name an instance variable or behavior that a member loses (a removed variable, or for a leaving member each of the family's instance variables and behaviors that it does not declare itself or get from another family)

When the family has behaviors, the layout instances of members that join get default entries for them, those of members that leave lose them, and those of members that stay get entries for added behaviors and lose the entries of removed ones. Entries these instances lack for the other behaviors of their object and its families are added too, as in [`update_object_properties`](#update_object_properties).

**Load-time check:** a member change that makes the family mix plugins is refused and nothing is written (`family-plugin-mismatch`, *wrong plugin*). A mix that was already there does not block other updates, and removing the odd member is allowed.

**Behaviors:**
- Behavior names may use letters, digits (including a leading digit, as in `8Direction`), underscores and spaces
- Every member must be able to carry every family behavior name: a new behavior may not match a behavior of any member or of another family of a member, and a new member may not bring a behavior whose name the family already uses. All checks run before any addon is registered or file written
- A failed layout update after the family file is written returns `success: false`, `action: "partially_updated"` with `backupFile` and `writtenLayouts`

### `delete_family`

Delete a family. The member object types are kept. The layout instances of its members lose the entries for the family's behaviors, and get the entries they lack for their other behaviors (see [`update_object_properties`](#update_object_properties)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references first. Uses of the family's name count as for [`delete_object`](#delete_object): the family as the object of a condition or action or of a custom action, in object parameters, expressions and script actions (`runtime.objects.Family`), and object properties of instances that hold its SID. Uses through a member count too: the `"instance-variable"` parameter or the `behaviorType` of a condition or action whose object is a member, an `"instance-variable"` parameter `{ name, objectClass }` that names a member (System *Sort Z order*), `Member.name`, `Member(0).name` or `Member.Behavior.Expression` in a parameter expression, and `Self.name` or `Self.Behavior.Expression` in a parameter expression of a condition or action whose object is a member, where `name` is an instance variable or behavior the member gets from this family only (not one it declares itself or also gets from another family). Names are matched ignoring case, as in [`update_object_properties`](#update_object_properties). Not detected: project script files and script access to instance variables and behaviors of member instances (`instVars`, `behaviors`)
- If referenced and `force=false`: blocks (`action: "delete_blocked"`) and lists where the family is used. `message` sums it up; `references` holds `eventSheets` and `layouts` (names), `events` and `instanceProperties` (as for `delete_object`) and `memberUses` (`{ eventSheet, path, eventPath, sid, member, kind, name, context }`, `eventPath` and `sid` as for the `uses` of [`update_object_properties`](#update_object_properties), `kind` being `instance variable` or `behavior` and `context` `condition`, `action` or `expression`). Each list is capped at 50 entries; `eventsNotListed`, `instancePropertiesNotListed` and `memberUsesNotListed` count the rest
- If referenced and `force=true`: deletes with a warning that names the remaining uses (references NOT cleaned up). [`validate_project`](#validate_project) then reports the conditions, actions and object parameters that name the family and the Particles object properties that hold its SID as `broken-object-reference`, and the uses through members as `missing-behavior-or-variable`, but not the uses of the family's name in expressions and scripts, nor the uses through members written as `Member.name` or `Self.name` in expressions: a second warning lists those
- Values that member instances in layouts hold for the family's instance variables are left as they are; their entries for the family's behaviors are removed, and entries they lack for their other behaviors are added
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info at any subfolder depth if its directory is readable), never a registration that points at nothing; the error names the file to clean up

### `create_event_sheet`

Create a new event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |
| `subfolder` | string | No | Subfolder path |
| `includeSheets` | string[] | No | Sheets to auto-include (validated for existence) |

A name that differs from an existing event sheet (in any folder) only in case is refused, as is a `subfolder` folder that differs from an existing project-bar folder only in case (see [Names and file names](#mutation-tools)).

### `add_event_to_sheet`

Add a structural event to an existing event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` \| `"script"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name |
| `functionParams` | array | For functions | `[{ name, type }]` (names checked, see below) |
| `functionReturnType` | enum | For functions | `"none"` \| `"number"` \| `"string"` \| `"any"` (default: none) |
| `functionIsAsync` | boolean | For functions | Mark the function async (default: false) |
| `functionCopyPicked` | boolean | For functions | Copy picked instances into the function (default: false) |
| `variableName` | string | For variables | Variable name (checked, see below) |
| `variableType` | enum | For variables | `"number"` \| `"string"` \| `"boolean"` |
| `initialValue` | string | For variables | Initial value |
| `variableComment` | string | For variables | Declaration comment |
| `variableIsStatic` / `variableIsConstant` | boolean | For variables | Static and constant flags |
| `script` | string \| string[] | For script blocks | JavaScript; stored as `{ eventType: "script", language: "javascript", script: [lines] }` with no SID, as r495 does |
| `includeSheet` | string | For includes | Sheet to include (validated) |
| `commentText` | string | For comments | Comment text |
| `groupPath` | string | No | Insert inside a group by title path (e.g., `"Movement > Collision"`) |
| `parentSid` | number | No | Insert inside this group, block, or function-block SID |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |

Use at most one of `groupPath` or `parentSid`; with neither, the event is added at the event-sheet root. A nested `include` is rejected, because Construct only serializes includes at the sheet root. A `parentSid` that several events of the sheet share is refused (see [Events that share a SID](#mutation-tools)).

Runs the same load-time gate as `add_event_block` before writing.

#### Event variable names

A variable added with `add_event_to_sheet` at the top level of the sheet is a global variable; one added inside a group, block or function (`groupPath`, `parentSid`) is a local variable of that event. The variable's name, the names in `functionParams` and a new name given to `update_event_variable` are refused where the Construct 3 editor's event variable and function parameter dialogs refuse them (checked against the editor code of releases r449 and r495.2, which agree; both dialogs run the same checks):

- **In use in the scope, ignoring case.** A global variable's name must differ from every event variable (global, local, static) and function parameter in every event sheet of the project. A local variable's name must differ from every global variable, from the variables and parameters of each event enclosing it, and from every variable and parameter below its parent event; locals in other branches or other sheets do not count. A function parameter has the scope of a local variable declared directly in its function: for a new function, its name must differ from every global variable and from the function's other parameters, while parameters of other functions and locals elsewhere do not count. Changing only the case of a variable's own name is allowed.
- **A System expression name, ignoring case** — e.g. `time`, `dt`, `random`, `max`, `LayoutName` (all 136 System expressions of r495.2, deprecated ones included). Five of them (`ColorToHexString`, `distance3d`, `HexColor`, `ProjectFileCount`, `ProjectFileNameAt`) are not in r449, whose editor accepts these names; they are refused anyway, since the r495.2 editor refuses them, and the error says so.
- **Characters the editor removes** — whitespace, the characters `. , " ( ) ? : \ / ; * | ' - ! ¬ £ $ % ^ & + = < > { } [ ] @ # ~`, the backtick, the soft hyphen, the ideographic full stop `。`, the full-width forms `， （ ） ？ ：` of `, ( ) ? :` and the typographic double quotes `“ ”`, a leading underscore, or a name of digits only. Other full-width forms, such as `．` and `／`, are accepted, as in the editor.

Names of object types and families are not compared: the editor accepts an event variable named like an object. Event sheet files that are not registered in `project.c3proj` are not read, as the editor does not load them. The other sheets are read from disk for each check, so sheets saved outside the server count as well.

`move_events_between_sheets` applies the scope rule to the variables and parameters it copies or moves, in their new place: see [`move_events_between_sheets`](#move_events_between_sheets).

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events (blocks, comments and scripts), events without conditions, else and else-if blocks, OR blocks, function and custom action calls, script actions, comment rows, and disabling single conditions and actions. Everything is written in the shapes the Construct 3 editor saves (see **Written shapes** below). Arguments and keys the tool does not know are refused, never dropped (see **Unknown keys** below). Every built-in condition and action, sub-events included, is checked as described in [ACE validation](#ace-validation) and [expression checking](#expression-checking), and each problem is returned as a warning.

An `ease` parameter that names a registered custom ease is stored as Construct r495.2 saves it, `{ "name": "<ease>", "json": [{ "folders": [], "json": <ease file> }] }`, here and in `update_event_block` and `update_event_block_action`. Built-in ease names and other values stay strings (see [Custom eases](#custom-eases)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | `"block"` | No | Optional; only `"block"` is accepted. Any other value (e.g. `"comment"`) is refused: comments, groups, variables, functions and includes are added with `add_event_to_sheet`, and a comment or script can also be a sub-event in `children`. |
| `sid` | number | No | Ignored: a block copied from `get_eventsheet_details` may carry its SID, but the new block always gets a new one. |
| `conditions` | array | No | Conditions (default: `[]`). Each: `{ id, objectClass, behaviorType?, parameters?, isInverted?, disabled? }`. AND-combined, or OR-combined in an OR block. `[]` makes an event without conditions: at the top level (or in a group) it runs every tick, as a sub-event whenever its parent runs. |
| `actions` | array | No | Actions (default: `[]`); see **Action kinds** below |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`). Segments are split at `>`. A segment first matches a group title exactly as typed, one space on each side of `>` counting as part of the separator (`"HUD "` and `"Parent > HUD "` name the title `"HUD "`, `"HUD"` and `"Parent > HUD"` the title `"HUD"`), so each of two sibling groups titled `"HUD"` and `"HUD "` can be reached. The editor also saves titles with leading or trailing whitespace, so a segment without such a match then matches the one group whose trimmed title equals the trimmed segment (`"HUD"` finds a lone `"HUD "`). When several do (e.g. `"HUD"` next to `"HUD "` and `" HUD"`), the call is refused with the candidate titles. |
| `parentSid` | number | No | Insert as a sub-event of this group, block, function-block or custom action block SID |
| `siblingSid` | number | No | Insert beside this event SID; requires `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` for root/group/parent insertion; `"before"` \| `"after"` with `siblingSid` (default: end) |
| `disabled` | boolean | No | Create the block disabled (default: false) |
| `isElse` | boolean | No | Make it an else block (default: false): a System `else` condition is written first. Conditions given in `conditions` follow it and make an else-if. When the first condition is an `else` given with `disabled: true`, `isElse: true` enables it instead of adding a second one; without `isElse` the block stays ordinary. |
| `isOrBlock` | boolean | No | Make it an OR block: the event runs when any of its conditions is true (Construct 3 *Make 'Or' block*). An OR block may hold several triggers. |
| `children` | array | No | Sub-events nested inside this block (recursive), each one of: a block `{ eventType?: "block", conditions?, actions?, disabled?, isElse?, isOrBlock?, children? }`, a comment `{ eventType: "comment", text, "text-color"?, "background-color"? }` or a script `{ eventType: "script", script, language?, disabled? }`. Other event types are refused (see **Sub-events** below). |

Use at most one insertion locator: `groupPath`, `parentSid`, or `siblingSid`. Without a locator, the block is inserted at the event-sheet root. A `parentSid` or `siblingSid` that several events of the sheet share is refused with the candidates (see [Events that share a SID](#mutation-tools)).

An else block (`isElse`) must come after an event block in the same container, as Construct's editor only offers "else" there, with at most comments between them: an else with no block before it, or whose previous event (comments aside) is a group, variable or include, is refused. An else after a triggered block gets the `else-placement` warning of the load-time gate (below).

**Condition fields:**
- `behaviorType` — For behavior conditions/actions: the behavior's *name* as defined on the object type or one of its families (e.g. `"Platform"`, `"8Direction"` — not the behaviorId `"EightDir"`). Omit for plugin and System ACEs. Written to the event sheet as `"behaviorType"`, the key Construct 3 reads.
- `"behavior-type"` — **Deprecated** alias for `behaviorType`, still accepted and written as `behaviorType` (with a warning). Passing both with different values is an error.
- `isInverted` — Negate the condition.
- `disabled` — Disable an individual condition.
- `isOr` — **Deprecated**, never written: Construct 3 ORs a whole event, never single conditions. When every condition after the first carries `isOr: true`, the block is written as an OR block (`isOrBlock`), with a warning. `isOr` on the first condition only has no effect and is dropped. `isOr` on only some of the later conditions is refused, since one event cannot express it: use `isOrBlock`, or move the alternatives into sub-events.

**Action kinds** (each may carry `disabled` except comment rows):

| Kind | Input | Written as |
|------|-------|------------|
| Plugin, behavior or System action | `{ id, objectClass, behaviorType?, parameters?, breakpoint? }` | `{ id, objectClass, sid, disabled?, breakpoint?, behaviorType?, parameters? }` |
| Function call | `{ callFunction, parameters?: [args] }` | `{ callFunction, sid, disabled?, parameters?: [args] }` |
| Custom action call | `{ customAction, objectClass, customActionObjectClass?, parameters?: [args] }` | `{ customAction, objectClass, customActionObjectClass?, sid, disabled?, parameters? }`. `customActionObjectClass` names the family that defines the action when it is called on a member object type |
| Comment row | `{ type: "comment", text, "text-color"?, "background-color"? }` (`textColor` and `backgroundColor` are accepted as aliases) | `{ type: "comment", text, "text-color"?, "background-color"? }` with no SID |
| Script | `{ type: "script", script, language? }` (string split on newlines, or lines) | `{ type: "script", language: "javascript", script: [lines], disabled? }` with no SID |

**Action fields:**
- `behaviorType` / deprecated `"behavior-type"` — same as for conditions.
- `disabled` — Disable an individual action (the action exists but won't run).
- `breakpoint` — A debugger breakpoint on a plugin/behavior/System action, as the editor saves it; written only when `true`.
- Comment rows — `text`, plus the optional colours `"text-color"` and `"background-color"` (or `textColor` and `backgroundColor`; both spellings with different values are refused), each `[red, green, blue, alpha]` with values from 0 to 1 as the editor saves them. Other colour forms (e.g. `"#ffcc00"`) are refused.
- Function calls — `callFunction` names an event function, `parameters` is the argument list in the order of the function's parameters: expressions as strings (`"1"`, `"\"text\""`, `"Player.X"`; numbers are written as strings), `true`/`false` for boolean parameters. The older form `{ id, objectClass, callFunction, parameters: { ... } }` is still accepted: its `id`, `objectClass`, `behaviorType` and `"behavior-type"` are dropped with a warning, also next to positional parameters, and parameters keyed `"0"`, `"1"`, … or by the function's parameter names become the positional array (with a warning); other keys are refused. A `breakpoint` on a function call is refused in either form, since no editor-saved function call on record has one. A call to a function that no event sheet defines, a different number of arguments than the function has parameters, and a boolean parameter given an expression (or the reverse) are warnings. A name that differs from the function's only in case is written with the function's spelling, as editor saves always spell calls, with a warning.
- Custom action calls — `customAction` is the name (`aceName`) of a custom action block of `objectClass` or of one of its families; arguments are positional expression strings. An `objectClass` that is no object type or family is refused.
- Script actions — `script` is an array of lines, as the editor saves it, or one string that is split into lines. `language` is `"javascript"` (the default and only value).
- The built-in Functions object — the editor saves *Set return value* and the function map actions on it, not on System: `{ "id": "set-function-return-value", "objectClass": "Functions", "parameters": { "value": "..." } }`, and likewise `map-function`, `map-function-default` and `call-mapped-function`. Its name is `functionsName` in `project.c3proj` (`"Functions"` in every project on record). Conditions, other action ids and `behaviorType` on it, and these actions given on `System`, are written with a warning, since no editor save on record has them. *Set return value* outside a function block gets a warning too: it sets the return value of the function its event runs in. The `function` parameter of `map-function` / `map-function-default` names an event function: a name that differs from the function's only in case is written with the function's spelling (editor saves pick it from a list), with a warning, and a name no function block has gets a warning, since the editor's loader throws *cannot find function* for it. The same applies when `update_event_block` or `update_event_block_action` changes the parameters of a function map.

**Sub-events (`children`):**
- A child is a block, a comment or a script — the kinds of sub-events editor-saved sheets hold under blocks — told apart by `eventType`. A block may leave `eventType` out.
- A block child is a full block event with its own conditions, actions, and children.
- A comment child `{ eventType: "comment", text, "text-color"?, "background-color"? }` and a script child `{ eventType: "script", script, language?, disabled? }` are written as the editor saves them (see **Written shapes**). Like script actions, `script` is an array of lines or one string that is split into lines, and `language` is `"javascript"`.
- Other event types are refused with an error that names the sub-event's path, and nothing is written: event variables, groups, function blocks and includes cannot be added as sub-events with this tool, and an unknown `eventType` is refused too. Groups, functions, includes and local variables are added with `add_event_to_sheet` (`parentSid` or `groupPath`).
- Children without conditions are normal sub-events: they run whenever their parent runs.
- Children with `isElse: true` are else (or else-if) branches of the sub-event before them. An else block needs a block without a trigger before it, with at most comments between (manual: *Else can only follow normal (non-triggered) events*), so an else sub-event that is the first sub-event (comments aside), follows a triggered block or holds a trigger itself gets an `else-placement` warning from the load-time gate. To branch inside a trigger, put a block with the condition and then the else block as sub-events of the triggered event.
- With `isElse: true` (or a System `else` first condition), a further System `else` condition in `conditions` is a duplicate and is dropped, with a warning.
- Max nesting depth: 10 levels. Max total events (parent + all descendants, comments and scripts included): 200.

**Unknown keys.** Conditions, actions and sub-events accept only the keys listed here (and the entries of `update_event_block` only theirs). Any other key is refused with an error that names it and its path, and nothing is written — it would otherwise be dropped with its content (a mistyped `params`, a comment's `text` on a child without `eventType: "comment"`). The one exception is `sid`, which conditions, actions and sub-events copied from `get_eventsheet_details` carry: it is ignored, since everything written gets a new SID. The arguments of `add_event_block` and `update_event_block` are checked the same way: an argument the tool does not take (a mistyped `actons`, `subEvents` for `children`, `children` on `update_event_block`) is refused, and nothing is written. `add_event_block` ignores a `sid` argument, as on a block copied from `get_eventsheet_details`, and refuses an `eventType` other than `"block"`.

**Written shapes.** These match editor-saved projects (Construct 3 r449 and r495.2):
- Blocks: `eventType, conditions, actions, sid, disabled?, children?, isOrBlock?`. `children` is left out when there are none, and false flags are not written.
- Else: the System condition `{ "id": "else", "objectClass": "System", "sid" }` at index 0. There is no block-level `isElse` key. Saved with `"disabled": true` the condition is ignored when the event runs, so the block is an ordinary block: it needs no block before it and is not an else block for any check here.
- Conditions: `id, objectClass, sid, disabled?, behaviorType?, parameters?, isInverted?`; `isInverted` comes last, after `parameters`, in every inverted condition the editor wrote in the projects on record. Actions: `id, objectClass, sid, disabled?, breakpoint?, behaviorType?, parameters?`.
- Function calls: `{ "callFunction", "sid", "disabled"?, "parameters"?: [...] }` without `id`/`objectClass`. Custom action calls: `{ "customAction", "objectClass", "customActionObjectClass"?, "sid", "disabled"?, "parameters"? }`.
- Script actions: `{ "type": "script", "language": "javascript", "script": [lines], "disabled"? }`. Comment rows: `{ "type": "comment", "text", "text-color"?, "background-color"? }`. Neither has a SID.
- Comment sub-events: `{ "eventType": "comment", "text", "text-color"?, "background-color"? }`. Script sub-events: `{ "eventType": "script", "language": "javascript", "script": [lines], "disabled"? }`. Neither has a SID.

**Validation:**
- `objectClass` is hard-validated against project objects, families, `"System"` and the built-in Functions object — across the entire tree (parent + all descendants)
- `behaviorType` is soft-validated (warning only, never blocks the write): it must name a behavior on the object type or on a family the object belongs to (for a family `objectClass`: on the family). The warning lists the available behavior names and hints when a behaviorId was passed instead of the name. When the object type or a family file cannot be read, the warning says the behavior could not be verified instead.
- `id` (ACE identifier), parameters and expressions are checked against Construct's definitions as warnings (see [ACE validation](#ace-validation) and [expression checking](#expression-checking)); they never block the write
- Script actions, comment rows, function calls and comment/script sub-events skip objectClass validation; script actions, comment rows and comment/script sub-events get no SID

**Load-time gate:** before writing, the sheet is checked against the editor load-time rules `expression-syntax`, `empty-expression`, `trigger-placement` and `else-placement` (see [`validate_project`](#validate_project)). The check covers the whole sheet, so the new block's position counts, and it compares the sheet before and after the change. A new error blocks the write with an explanation and nothing is written. New warnings are returned in `warnings`. Problems that were already in the sheet do not block the write, unless the change makes one of them worse (a warning that becomes an error); fixing part of an existing problem is allowed. The same gate runs in `add_event_to_sheet`, `update_event_block`, `update_event_block_action`, `move_event_block` and `move_event_block_items`. `move_events_between_sheets` runs it over the source and target sheets together: moving an event that already breaks a rule (`deleteSource: true`) is allowed, while copying it is refused, since the copy adds the problem to a second sheet.

Two triggers in one AND block are rejected. For "Space OR Up pressed", make it an OR block (`isOrBlock: true`) or add one event per trigger.

**What it does:**
1. Reads the target event sheet
2. Validates all `objectClass` references across the entire event tree
3. Recursively generates SIDs for each block, condition, action, function call and custom action call
4. Builds conditions and actions in the editor's shapes and key order (see **Written shapes**)
5. Recursively builds child sub-events (blocks, comments, scripts), else branches and OR blocks
6. Resolves the optional group, parent SID, or sibling SID destination before changing the event tree (a group path miss names the groups at the level that did not match, titles quoted so outer whitespace shows)
7. Inserts at the requested start/end or before/after position
8. Runs the load-time gate (blocks on new errors)
9. Writes sheet back with backup

### `delete_event_sheet`

Delete an event sheet from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references: sheets that include this one, layouts bound to it
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info at any subfolder depth if its directory is readable), never a registration that points at nothing; the error names the file to clean up

### `delete_event_from_sheet`

Delete an event from an event sheet by SID or include name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | No* | SID of the event to delete (block, group, variable, function) |
| `eventPath` | string | No | With `sid`: picks one of several events that share the SID, e.g. `"events[3].children[1]"` (see [Events that share a SID](#mutation-tools)) |
| `includeSheet` | string | No* | For removing includes: the included sheet name |
| `dryRun` | boolean | No | Preview what would be deleted without deleting (default: false) |
| `force` | boolean | No | Delete even when functions or event variables the delete removes are still referenced (default: false); the references are listed in `references` and in a warning, and left dangling |

*Exactly one of `sid` or `includeSheet` must be provided.

**Behavior:**
- **SID deletion**: Finds the event anywhere in the tree (including nested inside groups) using iterative traversal. Reports children count for groups, checks the references below for the functions and variables it removes. A SID shared by several events is refused, also with `dryRun`, unless `eventPath` picks one; the result names the deleted event's `eventPath`.
- **Include deletion**: Finds and removes the include event by sheet name. Lists current includes in error messages.
- **Dry run**: Returns a preview of what would be deleted without writing changes, with the same `warnings` the delete would return. A dry run with `force=true` also lists the references the delete would leave dangling (`references`, as below).
- **Reference safety**: A delete removes the event with all its sub-events, so it can remove function blocks (the event itself, or ones inside a deleted group) and event variables (the event itself, or ones among the deleted sub-events). Unless `force=true`, it is refused (`success: false`, `action: "delete_blocked"`, also on a dry run) while anything outside the deleted events still names one of them, anywhere in the project:
  - functions: *Call function* actions, *Map function* / *Map function default* actions that register the function in a function map, and `Functions.Name(...)` calls in the expressions of conditions and actions (listed in `references.callers` with `function`, `via`, `sheet`, `path` and the `sid` of the event holding the condition/action);
  - event variables: the `variable` parameter of the System conditions and actions that compare, set, add to, subtract from, toggle or reset an event variable, and expressions that use the variable by name, such as `Score * 2` or a function call argument `Score` (listed in `references.variableReferences` with `variable`, `via`, `sheet`, `path` and `sid`; `via` is `event-variable` or `expression`). In expressions, names inside string literals, after a `.` (`Sprite.Score`) or before a `.` or `(` are not uses, and parameters that hold a name instead of an expression (object, instance variable, layout and audio file parameters) are not read; a combo value spelled like the variable is counted, so check the listed references and use `force=true` if none is a real use. Scope counts: a global variable (top level of a sheet) is visible in every sheet, any other variable to the events beside it and below them, and inside a function block a function parameter of the same name resolves the reference too.

  Names are compared ignoring case. A reference that another function or variable of the same name still resolves after the delete (e.g. a global of that name in another sheet) is not counted, and neither is one that was already dangling. After loading a project, the editor resolves these names and throws *invalid function name* (Call function), *cannot find function* (function maps) or *cannot find event variable* when one is missing (editor loader code, r495.2); whether the project then fails to open has not been confirmed in the editor. A `Functions.Name(...)` expression would call a function that no longer exists, and an expression that uses a deleted variable by name would name a variable that no longer exists. With `force=true` the delete goes ahead, and the references are named in a warning and listed in `references`. Scripts are not scanned, and `validate_project` does not report such references.
- **Load-time rules**: A delete takes an event out together with all its sub-events. The `expression-syntax`, `empty-expression` and `trigger-placement` rules look only at an event's own conditions and actions and at its ancestors, and no remaining event gains an ancestor or a condition, so a delete cannot introduce an issue of these rules; the names it leaves dangling are covered by the reference safety above. It can leave an else block without the block it belonged to (after a triggered block, after a non-block event or first in its list, comments aside): that `else-placement` warning is returned in `warnings`, also on a dry run. Include deletion is not checked (includes are not part of these rules).
- Error messages include a navigable summary of top-level events with their types and SIDs.

### `remove_event_from_sheet`

Remove an include from an event sheet, named by the sheet it includes. Other event types are removed by SID with `delete_event_from_sheet`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet to modify |
| `includeSheet` | string | Yes | Name of the included sheet whose include is removed |

### `update_event_block`

Update an existing block, function-block or custom action body — modify action parameters, call arguments and comment rows, add, insert, replace or remove actions or conditions, toggle disabled state, make it an else or OR block. The conditions and actions the call adds or changes are checked as described in [ACE validation](#ace-validation) and [expression checking](#expression-checking); the ones it leaves alone are not.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | Yes | SID of the `block`, `function-block` or `custom-ace-block` to update |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `disabled` | boolean | No | Enable or disable the entire block |
| `isElse` | boolean | No | `true`: put the System `else` condition first (existing conditions then make an else-if); `false`: remove a leading `else` condition, enabled or disabled. When the leading `else` is disabled, `true` enables it (the `disabled` key is removed, with a warning) instead of adding a second one. Blocks only. A block-level `isElse` key left by older versions is dropped either way. |
| `isOrBlock` | boolean | No | `true`: make it an OR block; `false`: AND-combine its conditions again |
| `updateActions` | array | No | `[{ index, parameters?, arguments?, text?, textColor?, backgroundColor?, disabled? }]` — update actions by index. `parameters` merges into a plugin, behavior or System action; for a function call it is an argument array that replaces all arguments, or an object keyed by position (`"0"`, `"1"`, …) or parameter name that replaces single ones. `arguments` replaces a custom action call's positional arguments; `text` and the colours edit a comment row. A field that does not fit the action kind, and any other key, is refused. |
| `updateConditions` | array | No | `[{ index, parameters?, isInverted?, disabled? }]` — update conditions by index. Other keys (e.g. `behaviorType`) are refused: remove the condition and add a new one instead. |
| `insertActions` | array | No | `[{ index, action }]` — insert at unique indexes measured after removals |
| `insertConditions` | array | No | `[{ index, condition }]` — insert at unique indexes measured after removals |
| `replaceConditions` | array | No | `[{ index, condition }]` — replace a condition in place and mint a fresh SID |
| `addActions` | array | No | Append new actions (same shapes as in `add_event_block`) |
| `addConditions` | array | No | Append new conditions |
| `removeActionIndices` | number[] | No | Remove actions by 0-based index |
| `removeConditionIndices` | number[] | No | Remove conditions by 0-based index |

At least one update parameter must be provided.

**Operation ordering:**
1. Block toggles (`disabled`, `isOrBlock`)
2. Updates and condition replacements use original array positions (non-length-mutating); replacements mint fresh SIDs
3. Removals use original positions and are applied in descending order, deduped
4. Indexed insertions use the post-removal array and are applied in descending order; duplicate insertion indexes are rejected
5. Additions append
6. `isElse` — adds or removes the leading `else` condition
7. Final state checks — warn if this call removed the last condition, and when an OR block has fewer than two conditions

**Notes:**
- Works on `block`, `function-block` and `custom-ace-block` events (not groups, variables, etc.)
- New conditions, plugin/behavior/System actions and calls get fresh SIDs via the ID generator (script actions and comment rows carry no SID, matching C3)
- `objectClass` and `customActionObjectClass` are validated on new conditions and actions; `behaviorType` is soft-validated and the deprecated `"behavior-type"` alias is normalized, as in `add_event_block`. All additions are validated in one pass before anything changes, so each warning appears once and a conflicting key aborts the call without writing.
- Existing conditions/actions edited through `updateConditions`/`updateActions` that still carry the legacy `"behavior-type"` key are normalized to `"behaviorType"` with the same rules as `fix_legacy_behavior_keys`, and each one is reported in `warnings`. `update_event_block_action` does the same for the action it edits.
- Duplicate removal indices are automatically deduplicated
- The `else` condition stays first in a block that starts with one: inserting at index 0 is rejected (before an enabled or a disabled `else`), and replacing or removing an enabled one warns that the block becomes an ordinary block (removing a disabled one changes nothing about how the block runs, so it does not warn). Conditions after it (else-if) are allowed
- A block written by an older version with a block-level `isElse` key or condition-level `isOr` flags is rewritten to the editor's shape, with a warning. `isOr` on only some of the later conditions is ambiguous and is refused (see [`fix_legacy_event_shapes`](#fix_legacy_event_shapes))
- Warns only when this call removed the last condition (the block then runs whenever its parent runs; a function body on every call). Blocks that never had conditions, such as function blocks and condition-less sub-events, get no warning.
- `disabled` on the block, an action or a condition is written right after its `sid`, as the editor does. Parameters added to a condition that has `isInverted` but no `parameters` go before `isInverted`, and a new `isInverted` goes last, where the editor writes them.
- Added actions on the built-in Functions object are checked as in `add_event_block`; *Set return value* gets no warning when the block is a function block or one of its sub-events.
- An added condition with the deprecated `isOr` flag is refused unless the block is (or becomes) an OR block. An added System `else` condition is appended: on a block without conditions it becomes the first condition; on a block that already starts with an `else` condition (enabled or disabled), or with `isElse: true`, it is a duplicate and is dropped; otherwise it lands after the existing conditions with a warning (use `isElse: true` instead).
- Comment rows and script actions have no parameters: `parameters` on them is refused, and so is `disabled` on a comment row (editor-saved comment rows are `{ type, text }` with the optional colours `"text-color"` and `"background-color"`; none on record carries `disabled`).
- Arguments the tool does not take are refused, and nothing changes: `update_event_block` does not add sub-events, so `children` is refused too. Added conditions and actions, and the entries of `updateConditions` / `updateActions`, refuse keys they do not know, as in `add_event_block` (see **Unknown keys** there); a `sid` on an added condition or action is ignored.
- A function call stored in an older shape (with `id`/`objectClass` or keyed parameters) whose arguments are edited is rewritten in the editor's shape, with a warning. A call whose name differs from its function's only in case is written with the function's spelling, with a warning.
- Runs the load-time gate (see `add_event_block`) on the whole sheet, so a trigger added to a sub-event of a triggered event, of a function block or of a custom action block is rejected, as is a second trigger in one event. New conditions are appended, so a trigger added to a block that already has conditions ends up after them; that only warns, since the editor moves it to the top when it opens the project. A block made an else block where Else cannot stand (no block before it, comments aside, or a block with a trigger) gets an `else-placement` warning.

### `update_event_block_action`

Replace the parameters of a single action. The block is found by SID anywhere in the sheet; the action by its 0-based index; `get_eventsheet_details` shows both.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `blockSid` | number | Yes | SID of the `block`, `function-block` or `custom-ace-block` holding the action |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `actionIndex` | number | Yes | 0-based action index |
| `parameters` | object \| array | Yes | New parameter values; replaces the existing `parameters` entirely (max 100 keys, depth 6). For a function call: the arguments in parameter order as an array; an object keyed `"0"`, `"1"`, … or by the function's parameter names is converted to that array. An array for any other action is refused. |

Runs the load-time gate (see [`add_event_block`](#add_event_block)): parameters that break `expression-syntax` or `empty-expression` are refused and nothing is written; function call arguments are checked position by position. The new parameters are also checked as described in [ACE validation](#ace-validation), as warnings. A legacy `"behavior-type"` key on the edited action is normalized as in `update_event_block` and reported in `warnings`, and a function call stored in an older shape is rewritten in the editor's shape (with the function's spelling of its name). Comment rows and script actions have no parameters and are refused; a custom action call's arguments are changed with `update_event_block` (`updateActions[].arguments`). The result names the action by `actionId`, or by `callFunction` for a function call.

### `move_event_block_items`

Move or reorder existing actions or conditions within one block or between two blocks. Existing SIDs are preserved. With `copy: true` the source block is left unchanged and the selected items are inserted as copies with fresh SIDs (nested `sid` keys included).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sourceBlockSid` | number | Yes | Source block or function-block SID |
| `sourceEventPath` | string | No | Picks one of several events that share `sourceBlockSid` (see [Events that share a SID](#mutation-tools)) |
| `targetBlockSid` | number | Yes | Target block or function-block SID |
| `targetEventPath` | string | No | Picks one of several events that share `targetBlockSid` |
| `itemType` | enum | Yes | `"actions"` or `"conditions"` |
| `indices` | number[] | Yes | Unique source indexes; selected items retain their source order |
| `targetIndex` | number | Yes | Destination index; for same-block reorder this is measured after selected items are removed (a copy removes nothing) |
| `copy` | boolean | No | Copy instead of move (default `false`). The result lists `reassignedSids` instead of `movedSids` |

Cross-block moves and all copies enforce the 100-item block limit. Conditions cannot move into first place of a block whose first condition is an `else` (enabled or disabled), and an else condition can be neither moved nor copied. Moving the last condition out of a non-else source succeeds with an unconditional-block warning. Runs the load-time gate (see [`add_event_block`](#add_event_block)) before writing.

### `move_event_block`

Move an existing event to another container in the same event sheet. The event keeps its SID, its conditions and actions with their SIDs, and every descendant.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the event |
| `sid` | number | Yes | SID of the event to move |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `groupPath` | string | No | Move inside a group by title path (e.g., `"Movement > Collision"`) |
| `parentSid` | number | No | Move inside this group, block, or function-block SID |
| `siblingSid` | number | No | Move beside this event SID; requires `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` for root/group/parent destinations; `"before"` \| `"after"` with `siblingSid` (default: end) |

Use at most one destination locator. Without a locator the event moves to the event-sheet root.

**Behavior:**
- Works on any event the SID index can find: `block`, `group`, `variable`, `function-block`, `custom-ace-block`. Construct does not write a `sid` on `comment` or `include` events, so those cannot be addressed here — the not-found error says so.
- An else block (an enabled `else` first condition; a block whose `else` is disabled is an ordinary block and moves freely) keeps needing an event block before it where it lands, with at most comments between them, so a move that would make it first, or put it after a group, variable or include (comments aside), is refused. Moving a block away from in front of an else succeeds with a warning that the else no longer follows a block.
- Refuses a destination inside the moved event's own subtree (`parentSid`, `groupPath` or `siblingSid` resolving to the event itself or one of its descendants), which would detach the branch from the sheet.
- Refuses `siblingSid` or `parentSid` equal to `sid`.
- The destination is resolved before anything is detached, so a rejected move leaves the file untouched.
- A move within one container is correct for `before`/`after`: the sibling's index is read after the event has been detached.
- A destination container with no `children` array gets one only after every check has passed.
- Runs the load-time gate (see [`add_event_block`](#add_event_block)) before writing, so a move that puts a trigger under a triggered event is refused.
- Cross-sheet moves are **not** supported here; use `move_events_between_sheets`, which copies or moves top-level events between two sheets.

### `move_events_between_sheets`

Copy top-level events from one sheet to another by SID; with `deleteSource` they are moved. A move keeps every SID and every nested child; a copy gets fresh SIDs throughout, because a SID must be unique in the project. To move an event within one sheet, use `move_event_block`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceSheet` | string | Yes | Sheet to copy/move from |
| `targetSheet` | string | Yes | Sheet to copy/move into (must differ from the source) |
| `sids` | number[] | Yes | SIDs of top-level events in the source sheet (min 1, each SID once) |
| `eventPaths` | string[] | No | Paths of top-level events (`"events[4]"`) that pick one of several top-level events sharing a SID in `sids`, one per such SID (see [Events that share a SID](#mutation-tools)) |
| `deleteSource` | boolean | No | Remove the events from the source after copying (default: false) |
| `targetGroupPath` | string | No | Insert into a group by title path (e.g. `"Movement > Collision"`), matched as `groupPath` in `add_event_block` (titles with leading/trailing whitespace included) |
| `position` | `"start"` \| `"end"` | No | Insert position (default: end) |

Copied and moved events keep their event variable and function parameter names. A copy or move that would give one of them a name that is in use, ignoring case, in its new scope (see [Event variable names](#event-variable-names)) is refused and nothing is written; the error lists the clashing names. The most common case is a copy of a global variable (`deleteSource: false`), since its original keeps the name; moving it is fine. A local variable or parameter moved into a group (`targetGroupPath`) can also clash with the group's variables. The editor renames a pasted variable in this case instead; rename it first with `update_event_variable`. Clashes that the events already had in their old place are not counted.

Runs the load-time gate (see [`add_event_block`](#add_event_block)) over the source and target sheets together, before anything is written. Moving an event that already breaks a load-time rule only relocates the problem and is allowed; copying it (`deleteSource: false`) adds the problem to a second sheet, so a copied error is refused and a copied warning is returned in `warnings`.

Only top-level events count: a SID shared by two top-level events of the source is refused unless `eventPaths` picks one, while a nested event with the same SID does not make it ambiguous. `deleteSource` removes exactly the copied events. A SID listed twice in `sids` is refused; top-level events that share a SID are moved one per call.

When a moved event, or one of its sub-events, has a SID that another event of the target sheet already has, the event is still written, since the editor opens such sheets, and `warnings` names each such SID with the paths of its events there: the SID-based event tools then refuse it in the target sheet unless `eventPath` picks one. A copy cannot cause this, since it gets fresh SIDs.

Returns `movedSids`, `movedCount`, `backupFiles` (target first, then source when modified), for a copy `copiedTopLevelSids` (the new top-level SIDs) and `reassignedSids`, and `warnings`, if any: new load-time warnings and the shared-SID warning.

### `add_custom_action`

Add a custom action definition — the `custom-ace-block` event Construct writes for an object type's or family's custom action.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `objectClass` | string | Yes | Object type or family that owns the custom action |
| `aceName` | string | Yes | Name as it appears in the editor; spaces and punctuation are allowed |
| `description` | string | No | `functionDescription` |
| `category` | string | No | `functionCategory` — the editor grouping, e.g. `"_Validate Behavior"` |
| `returnType` | enum | No | `"none"` \| `"number"` \| `"string"` \| `"any"` (default: none) |
| `isAsync` | boolean | No | `functionIsAsync` (default: false) |
| `copyPicked` | boolean | No | `functionCopyPicked` (default: false) |
| `parameters` | array | No | `[{ name, type, initialValue?, comment? }]` in call order; each gets a fresh SID |
| `groupPath` | string | No | Insert inside a group by title path |
| `parentSid` | number | No | Insert inside this group, block, or function-block SID |
| `siblingSid` | number | No | Insert beside this event SID; requires `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` \| `"before"` \| `"after"` (default: end) |

**Format:** the emitted event matches a real project's definitions — `aceType`, `aceName`, `objectClass`, `functionDescription`, `functionCategory`, `functionReturnType`, `functionCopyPicked`, `functionIsAsync`, `functionParameters`, `eventType: "custom-ace-block"`, `conditions`, `actions`, `sid`, `children`. Every definition observed in that project uses `aceType: "action"`, so that is the only form written; the condition and expression forms are deliberately not invented.

**Notes:**
- `objectClass` must be an existing object type or family. `System` is rejected — it has no custom ACEs.
- A duplicate `objectClass` plus `aceName` anywhere in the project is rejected.
- A `parentSid` or `siblingSid` that several events of the sheet share is refused (see [Events that share a SID](#mutation-tools)).
- The definition is created empty. Add its conditions and actions with `update_event_block` using the returned `generatedSid`, and nest sub-events with `add_event_block` and `parentSid`.

### `update_event_group`

Update a group event in place. Children are untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the group |
| `sid` | number | Yes | SID of the group event |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `title` | string | No | New group title |
| `description` | string | No | New group description |
| `isActiveOnStart` | boolean | No | Whether the group is active when the layout starts |
| `disabled` | boolean | No | Disable or enable the group |
| `backgroundColor` | number[4] | No | Written as the `background-color` key; RGBA as four 0-1 numbers |
| `textColor` | number[4] | No | Written as the `text-color` key; RGBA as four 0-1 numbers |

At least one update parameter must be provided.

**Notes:**
- `background-color` and `text-color` are the only color keys Construct serializes on a group; both are optional and are written only when supplied.
- A new `title` is rejected when a sibling group in the same container already uses it, because group paths resolve one title per container. A duplicate title in a *different* container is allowed and reported as a warning.

### `update_comment`

Update a comment event. Construct does not write a `sid` on comments, so a comment is normally addressed by its position.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the comment |
| `sid` | number | No* | SID of the comment, for the rare comment that carries one |
| `eventPath` | string | No | With `sid`: picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `index` | number | No* | 0-based index of the comment among its container's events |
| `groupPath` | string | No | With `index`: the container group by title path |
| `parentSid` | number | No | With `index`: the container group, block, or function-block SID |
| `text` | string | No | New comment text |
| `backgroundColor` | number[4] | No | Written as the `background-color` key |
| `textColor` | number[4] | No | Written as the `text-color` key |

*Exactly one of `sid` or `index` must be provided. `groupPath` and `parentSid` apply to `index` addressing only; with neither, `index` counts the event-sheet root.

**Notes:**
- `index` counts **every** event in the container, not only the comments. Addressing a non-comment is rejected and names the event type found.
- At least one of `text`, `backgroundColor`, `textColor` must be provided.

### `update_script_event`

Replace the JavaScript of a standalone script block, or remove it. Script blocks carry no SID, so they are addressed like comments.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the script block |
| `index` | number | Yes | 0-based index among the container's events |
| `groupPath` / `parentSid` | string / number | No | The container (default: the sheet root) |
| `script` | string \| string[] | No* | New JavaScript |
| `remove` | boolean | No* | Remove the block |

*Exactly one of `script` or `remove: true`. An index that points at another event type is rejected.

### `update_function`

Update a function-block or a custom action definition (`custom-ace-block`) and, on request, every action that calls it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the definition |
| `sid` | number | Yes | SID of the function-block or custom-ace-block |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `functionName` | string | No | New name (the `aceName` for a custom action) |
| `renameCallers` | boolean | No | Rewrite every call targeting the old name (default: false) |
| `dryRun` | boolean | No | Report the definition's call sites (and, with other parameters, what would change) without writing |
| `description` | string | No | New `functionDescription` |
| `category` | string | No | New `functionCategory` |
| `returnType` | enum | No | `"none"` \| `"number"` \| `"string"` \| `"any"` |
| `isAsync` | boolean | No | New `functionIsAsync` |
| `copyPicked` | boolean | No | New `functionCopyPicked` |
| `addParameters` | array | No | `[{ name, type, initialValue?, comment? }]` appended to the end of the list; each gets a fresh SID |
| `removeParameters` | string[] | No | Parameter names to remove |
| `renameParameters` | array | No | `[{ from, to }]` — rename in place, keeping the position and SID |

Caller sheets are written first and the sheet holding the definition last. If a write fails part way, the error names the sheets already written and those not written; the definition still carries the old name, so re-running the same call finishes the rename and skips the callers already done.

At least one update parameter must be provided, unless `dryRun` is set.

**Custom actions:** a call resolves to a custom action definition on `owner` when its `customActionObjectClass` is the owner, or it has none and its `objectClass` is the owner, or the owner is a family, the call is on a member, and that member does not define its own action of the same name. Only those calls are renamed; member overrides are reported and left unchanged. A duplicate name on the same owner is rejected.

**Caller handling:**
- A call site is a non-script action carrying `callFunction`, the same rule `get_function_map` and the project index use. All sheets are scanned.
- Renaming with callers present is **refused** unless `renameCallers=true`; the error names the caller count and the sheets. With `renameCallers=true` every matching `callFunction` is rewritten and each affected sheet is written with its own backup.
- Expression references of the form `Functions.<oldName>` are **not** rewritten; matches are counted and reported as a warning.
- `removeParameters` is **refused** while any caller exists: a `callFunction` action stores its arguments as a positional `parameters` array, so dropping a parameter would silently shift every later argument. Update or delete the callers first.
- `renameParameters` keeps each parameter's position, so callers keep working. A parameter is referenced by bare name inside the function body; those references are counted and reported as a warning rather than rewritten.
- `addParameters` appends, which leaves existing callers valid — they fall back to the declared `initialValue`. A warning reports how many callers do not pass the new parameter.

**Notes:**
- A new `functionName` is validated as a C3 identifier and rejected if another function in the project already uses it.
- Renaming, adding, removing and renaming parameters are all preflighted before anything is written, so a rejected call leaves every file untouched.

### `update_event_variable`

Update an event variable declaration found by SID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the variable |
| `sid` | number | Yes | SID of the `variable` event |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `newName` | string | No | New name (checked, see [Event variable names](#event-variable-names)) |
| `newType` | `"number"` \| `"string"` \| `"boolean"` | No | New type |
| `newInitialValue` | string | No | New initial value, as a string |
| `isStatic` | boolean | No | Value persists between calls |
| `isConstant` | boolean | No | Value cannot change at runtime |
| `comment` | string | No | New declaration comment |

At least one change must be provided. References to the old name are not updated; `rename_event_variable` renames the variable together with every reference in its scope. A new name is refused where the editor refuses it (see [Event variable names](#event-variable-names)): for a global variable it must differ, ignoring case, from every event variable and function parameter in the project, for a local one from those in its scope; changing only the case of the variable's own name is allowed.

### `fix_legacy_behavior_keys`

Repair event sheets written by construct3-mcp 1.8.1 and earlier, which stored the behavior of a condition/action under `"behavior-type"`. Construct 3 reads `"behaviorType"`; with only the legacy key it looks the ACE up on the object's base plugin and fails to open the project (e.g. `Error: missing action id 'flash'`, issue #16).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dryRun` | boolean | No | Only report what would change (default: **true**). Set `false` to rewrite the affected sheets. |

**Behavior:**
- Scans every event sheet, including groups, sub-events and function blocks.
- Renames `"behavior-type"` to `"behaviorType"` in place (key order is kept); drops the legacy key when an identical `"behaviorType"` already exists.
- Before renaming, checks that the value names a behavior on the object type or one of its families (as `add_event_block` does). Values that match no behavior — e.g. a behaviorId such as `"EightDir"` instead of the name `"8Direction"` — are reported under `unresolved` with a hint and left untouched, since renaming them would not make the project loadable. Values that cannot be checked (unreadable object type or family file) are renamed and carry a `warning`.
- Conditions/actions where both keys disagree, or the legacy value is not a non-empty string, are reported under `conflicts` and left untouched.
- Only sheets with changes are written, each through the normal pipeline (backup → validate → write → verify → invalidate caches).
- Returns `totalRenamed`, `totalUnresolved`, `totalConflicts` and per-sheet `changes` (SID, ACE id, objectClass; capped at 100 per sheet), `unresolved`, `conflicts` plus `backupFile` when written. Sheets that could not be read are listed in `unreadableSheets` and named in the message.
- If a write fails part-way, the error names the sheets already rewritten.

`validate_project` reports affected sheets with check `legacy-behavior-key`:
- **error** when a condition/action names its behavior only under `"behavior-type"` (the load failure above). The message calls out values that match no behavior, and the suggestion only points to this tool for the ones it can rename.
- **warning** when the legacy key is a leftover next to a valid `"behaviorType"` or holds no behavior name — Construct 3 does not read the key, so it is dead data.

### `fix_legacy_event_shapes`

Repair event sheets written by construct3-mcp 1.8.1 and earlier, whose event tools used shapes that Construct 3 itself never writes (issue #32): a block-level `"isElse"` instead of the System `else` first condition, a per-condition `"isOr"` instead of the block's `"isOrBlock"`, and function calls with `id`/`objectClass` and keyed parameters instead of `{ callFunction, sid, parameters: [...] }`. Whether the editor ignores these or refuses the project is not verified; at best an `isElse` block runs like an ordinary block and an `isOr` block like an AND block.

The tool also converts scripts stored as one string or without `language`. Older Construct 3 releases saved scripts that way, and construct3-mcp 1.8.1 and earlier wrote script actions that way too; current releases save `{ type: "script", language: "javascript", script: [lines] }`. Converting them is harmless (one report says the desktop editor did not show a script action stored as one string).

**Converting else and OR blocks can change what a game does.** The conversion follows what the old flag asked for, not how the event ran: an `isElse` block that ran like an ordinary block runs only when the block before it did not, and an `isOr` block whose conditions were AND-combined runs when any of them is true. These changes carry `changesBehavior: true` and say so in their `detail`, the result counts them in `totalBehaviorChanges`, and the message asks to test those events in the game.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dryRun` | boolean | No | Only report what would change (default: **true**). Set `false` to rewrite the affected sheets. |

**Converted** (the result is unambiguous):
- `isElse: true` on a block without conditions whose previous sibling, not counting comments, is a block without a trigger: a System `else` condition with a new SID is put first and the key dropped. When the block already starts with the `else` condition (also a disabled one, which stays disabled: the editor never read the key, so dropping it changes nothing about how the block runs), or the key is not `true`, the key is just dropped.
- `isOr` on every condition after the first: the block gets `isOrBlock: true` and the keys are dropped. `isOr` keys that never had an effect (on the first condition only, `false`, or in a block that already is an OR block) are dropped.
- Function calls: `id`, `objectClass` and behavior keys are dropped, and parameters keyed `"0"`, `"1"`, … or exactly by the function's parameter names become the positional array, in the order `callFunction, sid, disabled, parameters`.
- Script actions and script events: a script stored as one string becomes an array of lines (split at line breaks), and a missing `language` becomes `"javascript"`, in the order `type, language, script, disabled`.

**Reported under `manual`** (left untouched): an `isElse` block that has conditions (it would become an else-if that tests them: decide with `update_event_block` and `isElse: true` or `false`), an `isElse` block with no block before it (comments aside) or after a block with a trigger (Else can only follow non-triggered events), `isOr` on only some of the later conditions (make it an OR block, or split the event), calls whose parameter keys cannot be mapped, and scripts that are neither text nor a list of lines.

Only sheets with conversions are written, each backed up first. Returns `totalConverted`, `totalManual`, `totalBehaviorChanges` and per-sheet `changes` (kind, JSON path, SID, what changes, `changesBehavior`; capped at 100 per sheet), `manual` and `backupFile` when written. `validate_project` reports affected sheets as warnings with check `legacy-event-shape`.

### `create_layout`

Create a new layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |
| `width` | number | No | Width in pixels (default: project viewport width) |
| `height` | number | No | Height in pixels (default: project viewport height) |
| `eventSheet` | string | No | Linked event sheet name (validated) |
| `layers` | string[] | No | Layer names (default: single `"Layer 0"`) |

A name that differs from an existing layout (in any folder) only in case is refused: the editor compares layout names ignoring case. So are `layers` that differ from each other only in case.

### `add_instance_to_layout`

Place an object instance on a layout layer or sub-layer. For copying instances between layouts, read the source with `get_layout_details` and pass instance properties here.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout |
| `layerName` | string | Yes | Target layer: any layer or sub-layer of the layout, by name (a sub-layer also by its path, e.g. `"Main > HUD"`) |
| `objectType` | string | Yes | Object type to place |
| `x` | number | Yes | X position |
| `y` | number | Yes | Y position |
| `width` | number | No | Instance width (default: 100) |
| `height` | number | No | Instance height (default: 100) |
| `properties` | object | No | Plugin-specific properties (auto-filled for known plugins) |
| `angle` | number | No | Rotation angle in radians (default: 0) |
| `color` | number[4] | No | RGBA tint as `[r, g, b, a]` with values 0-1 (default: [1,1,1,1]) |
| `zElevation` | number | No | Z elevation for 3D layering (default: 0) |
| `originX` | number | No | Horizontal origin 0-1 (default: 0.5 = center) |
| `originY` | number | No | Vertical origin 0-1 (default: 0.5 = center) |
| `instanceVariables` | object | No | Instance variable values as `{varName: value}` |
| `behaviors` | object | No | Behavior property values as `{behaviorName: {properties: {prop: val}}}` (the shape `get_layout_details` returns) or `{behaviorName: {prop: val}}`; they override the defaults |
| `tags` | string | No | Comma-separated instance tags (alphanumeric only) |
| `showing` | boolean | No | Whether instance is initially visible (default: true) |
| `locked` | boolean | No | Whether instance is locked in the editor (default: false) |

**Notes:**
- Blocks global-only objects (singleglobal-inst) from being placed
- The new UID is above every UID in the project, sub-layer instances included, and the new SID is unused
- Nonworld-global objects (Array, JSON, Dictionary) are placed in `nonworld-instances` instead of on layers
- Auto-fills default instance properties for Sprite, Text, TiledBg, NinePatch
- Writes a behavior entry for every behavior of the object and of the families it belongs to, like the editor: family behaviors first, then the object's own, each as `{"properties": {...}}` with the built-in behavior's default values (from the Construct 3 r449 editor's behavior definitions). Values passed in `behaviors` override the defaults. A behavior without known defaults (third-party addons) gets `{"properties": {}}` and a warning; Construct 3 fills in missing properties with their defaults when it opens the project (Scirra's own example projects contain such entries). The warning also points out a behaviorId that is not one the editor defines, such as `"Solid"` for `"solid"`
- Warns on unknown instanceVariable keys (may be inherited from families), on behavior names that are not behaviors of the object or its families, on property ids that a built-in behavior does not have, and on values whose type differs from the property's default (e.g. a string for a check box)
- All visual and behavioral properties are preserved when specified

### `delete_instance_from_layout`

Remove a placed instance by UID from the layout's layers and sub-layers or its non-world instances. Hierarchy links to it are detached; the result names the layer or sub-layer it was removed from.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout holding the instance |
| `uid` | integer | Yes | UID of the instance to remove |

### `delete_layout`

Delete a layout from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Blocks unconditionally if the layout is the project's startup layout (`firstLayout`)
- Checks for bound event sheets and placed objects
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info at any subfolder depth if its directory is readable), never a registration that points at nothing; the error names the file to clean up

### `update_instance`

Update a placed instance on a layout. Instances are found by UID in any layer, nested sub-layer, or the layout's non-world instances.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the instance |
| `x`, `y`, `width`, `height`, `angle`, `zElevation`, `color` | number / number[4] | No | World transform and tint (ignored, with a warning, on non-world instances) |
| `originX`, `originY` | number | No | Origin as a fraction of the instance size; see the origin notes below |
| `blendMode` | string | No | `normal` (removes the stored key), `additive`, `xor`, `copy`, `destination-over`, `source-in`, `destination-in`, `source-out`, `destination-out`, `source-atop`, `destination-atop` |
| `depth` | number | No | 3D Shape depth (`world.depth`, written after the Z key); other plugins get a warning |
| `showing`, `locked`, `tags` | boolean / string | No | Editor visibility, lock, and tags |
| `instanceVariables` | object | No | Instance variable values to merge |
| `properties` | object | No | Plugin property values to merge, keyed by property ID (Text `text`, iframe `url`, Tilemap `tile-width`, ...) |
| `behaviors` | object | No | Per-instance behavior settings as `{ behaviorName: { properties: { ... } } }`, merged per behavior |
| `effects` | object | No | Per-instance effect state as `{ effectName: { isEnabled?, parameters? } }`, merged per effect |

**Notes:**
- Behavior names not defined on the object type or one of its families produce a warning; effect names not defined there are rejected, because Construct fails to load an instance with an unknown effect key. Attach the effect first with `add_effect`.
- Property keys are not validated against the plugin; use the IDs Construct writes into the layout file.
- Origin follows the editor: a Sprite instance always carries its animation frame's origin (30,222 of 30,223 sampled instances), so any other value is refused (use `update_frame`). Objects with an `origin` property (Text, Tiled Background, 9-patch, Sprite Font, SVG Picture) take only the nine grid points; `originX`/`originY` set `properties.origin` too, and `properties: { origin }` sets the world origin. The r495.2 editor recomputes the world origin from that property on load.
- `zElevation` is written to `world.zElevation` when the instance already stores that key (projects saved by older releases) and to `world.z` otherwise.

### `move_instance`

Move a world instance to another layer and/or change its Z order. A layer's `instances` array is stored bottom to top.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | World instance UID |
| `toLayer` | string | No | Destination layer at any depth (default: current layer) |
| `position` | `"top"` / `"bottom"` / number | No | Z position in the destination layer, index counted from the bottom (default: top when changing layer) |
| `aboveUid`, `belowUid` | number | No | Place directly above or below an instance on the destination layer |

Give at most one of `position`, `aboveUid` and `belowUid`. Non-world instances are refused. The result reports `fromLayer`, `fromIndex`, `toLayer` and `toIndex`; `action: "unchanged"` when nothing moved.

### Bulk instance tools

Four tools apply a list of instance edits to one layout in a single call. They share these rules:

- Items are applied in list order, so a later item sees what an earlier one did (a `move_instances` position counts the instances the earlier moves left on that layer).
- Every item is checked and applied in memory before anything is written. If any item fails, the call returns an error that names the item by its 0-based index (`Item 2: ...`) and writes nothing. Otherwise the layout file is written once, with one backup.
- Each item is checked exactly as its single tool checks it, and produces the same layout: the single and bulk tools share one implementation per edit.
- Up to 500 items per call. `dryRun: true` checks and applies every item in memory, reports the results with `action: "dry-run"`, and writes nothing.
- The result has `count`, per-item `results` (each with its `index` and `uid`), and `warnings` prefixed with the item index.
- Edits on several layouts need one call per layout; nothing links separate calls.

### `add_instances_to_layout`

Place many instances on one layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout |
| `instances` | object[] | Yes | 1 to 500 items, each with the parameters of `add_instance_to_layout` except `layoutName` (`layerName`, `objectType`, `x`, `y`, and the optional ones) |
| `dryRun` | boolean | No | Report the results and write nothing (default: false) |

Each result carries the `objectType` and the new `uid` and `sid`. New UIDs continue from the highest UID in the project. A dry run reserves UIDs for its preview only, so a real call afterwards assigns different ones.

### `update_instances`

Update many placed instances of one layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `updates` | object[] | Yes | 1 to 500 items, each with a `uid` and the parameters of `update_instance` except `layoutName` |
| `dryRun` | boolean | No | Report the results and write nothing (default: false) |

An item that names no field to change is refused before the layout is read.

### `move_instances`

Move many world instances of one layout to other layers or Z positions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `moves` | object[] | Yes | 1 to 500 items, each with a `uid` and the parameters of `move_instance` except `layoutName` (`toLayer`, `position`, `aboveUid`, `belowUid`) |
| `dryRun` | boolean | No | Report the results and write nothing (default: false) |

Each result reports `fromLayer`, `fromIndex`, `toLayer`, `toIndex`, `layerInstanceCount` and `unchanged`. When every item leaves its instance where it was, the call returns `action: "unchanged"` and writes nothing.

### `delete_instances_from_layout`

Remove many instances, world or non-world, from one layout by UID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uids` | integer[] | Yes | 1 to 500 UIDs; a UID listed twice is refused |
| `dryRun` | boolean | No | Report the results and write nothing (default: false) |

Hierarchy links are detached as `delete_instance_from_layout` detaches them: each removed instance leaves its parent's child list, and its children lose their parent link. Each result carries the removed `objectType`.

### `update_layout`

Update layout properties (event sheet binding, dimensions, scrolling, sampling, projection, viewport anchor).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to update |
| `eventSheet` | string | No | New event sheet binding (validated for existence) |
| `width` | number | No | New layout width in pixels |
| `height` | number | No | New layout height in pixels |
| `unboundedScrolling` | boolean | No | Allow scrolling beyond the layout bounds |
| `sampling` | string | No | `auto` (inherit the project setting), `nearest`, `bilinear`, `trilinear` |
| `projection` | string | No | `perspective` or `orthographic` |
| `vpX` | number | No | Viewport anchor X, 0-1 (Construct writes 0.5) |
| `vpY` | number | No | Viewport anchor Y, 0-1 (Construct writes 0.5) |

At least one parameter must be provided. Renaming a layout is not done here.

### `add_layer`

Add a layer to a layout, at the top level or inside another layer's `subLayers`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout to add the layer to |
| `layerName` | string | Yes | New layer name, different from every layer of the layout (sub-layers included) ignoring case, as the editor compares layer names |
| `parentLayer` | string | No | Create the layer inside this layer's `subLayers` (default: top level); a sub-layer can also be given by its path, e.g. `"Main > HUD"` |
| `index` | number | No | Position among its siblings, 0 = bottom (default: append to top) |
| `isInitiallyVisible` | boolean | No | Layer starts visible (default: true) |
| `isTransparent` | boolean | No | Layer is transparent (default: true) |
| `parallaxX`, `parallaxY` | number | No | Parallax rates (default: 1) |
| `blendMode` | enum | No | `"normal"` (default), `"additive"`, `"xor"`, `"copy"`, `"destination-over"`, `"source-in"`, `"destination-in"`, `"source-out"`, `"destination-out"`, `"source-atop"`, `"destination-atop"` |

**Notes:**
- The parent layer is found at any nesting level; a parent with no `subLayers` array gets one.
- A name used by another layer of the layout (sub-layers included) is refused, also when it differs only in case: the editor refuses such a layer name and cannot load a layout with two of them.

### `delete_layer`

Delete a layer from a layout, at the top level or nested in another layer. The last top-level layer of a layout cannot be deleted. A layer's sub-layers go with it, so without `force` the call is refused when the layer holds any instance at any depth or has any sub-layer at all; the `delete_blocked` result names the sub-layers and counts the instances, the layer's own and those below it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer or sub-layer to delete, by name (a sub-layer also by its path, e.g. `"Main > HUD"`) |
| `force` | boolean | No | Delete even when the layer or its sub-layers hold instances, or it has sub-layers at all; they are lost with it (default: `false`) |

A blocked delete returns `success: false`, `action: "delete_blocked"` with `instanceCount` (sub-layers included), and `subLayers` (their names) and `subLayerCount` when the layer has sub-layers.

### `update_layer`

Update an existing layer, at the top level or nested in another layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer or sub-layer to update, by name (a sub-layer also by its path, e.g. `"Main > HUD"`, which picks one of several layers with the same name) |
| `newName` | string | No | Rename the layer (must differ from the other layers of the layout, sub-layers included, ignoring case; changing the case of the layer's own name is fine) |
| `isInitiallyVisible`, `isInitiallyInteractive`, `isTransparent` | boolean | No | Initial visibility, interactivity, transparency |
| `parallaxX`, `parallaxY`, `scaleRate`, `zElevation` | number | No | Parallax rates, scale rate, Z elevation |
| `blendMode` | enum | No | Same values as `add_layer` |
| `color` | number[4] | No | Layer tint as `[r, g, b, a]`, values 0-1 |
| `backgroundColor` | number[4] | No | Background color as `[r, g, b, a]`, values 0-1 (used when the layer is not transparent) |
| `global` | boolean | No | Make the layer global (shared across layouts) |
| `isHTMLElementsLayer` | boolean | No | Mark the layer as the HTML elements layer |
| `sampling` | string | No | `auto` (inherit the project setting), `nearest`, `bilinear`, `trilinear` |
| `renderingMode` | string | No | Free-form; Construct 3 r495 writes `3d` |
| `forceOwnTexture` | boolean | No | Render the layer to its own texture |
| `useRenderCells` | boolean | No | Use render cells for culling |
| `drawOrder` | string | No | Free-form; Construct 3 r495 writes `z-order` |

At least one parameter must be provided. `sampling` is validated against the list above; `renderingMode` and `drawOrder` are accepted as bounded strings because only one value of each was observed in a real r495 project.

### `reorder_layers`

Reorder one nesting level of a layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerNames` | string[] | Yes | Every layer at that level, in the new order (index 0 = bottom) |
| `parentLayer` | string | No | Reorder this layer's sub-layers instead of the top-level layers |

**Notes:**
- `layerNames` must be a full permutation of that level. A missing name, a duplicate, or a name from another level is rejected and nothing is written — a partial list would silently drop layers and the instances on them.

### `move_layer`

Move a layer between nesting levels of the same layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer to move (searched at every nesting level) |
| `parentLayer` | string / null | No | Destination parent layer; `null` or omitted moves the layer to the top level |
| `index` | number | No | Position among the destination siblings *after* the layer is removed from its old position (default: append to top; larger values are clamped) |

**Notes:**
- Moving a layer into itself, or into one of its own sub-layers, is refused: it would detach the whole branch from the layout.
- The layout's last remaining top-level layer cannot be nested.
- Sub-layers move with the layer.

### `set_instance_parent`

Attach a world instance to a hierarchy parent in the same layout, or detach it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `childUid` | number | Yes | UID of the instance that becomes the child |
| `parentUid` | number / null | Yes | UID of the parent instance, or `null` to detach the child from its current parent |
| `flags` | object | No | Inheritance flags merged over the defaults; unknown keys are rejected |

**Flags** (the key set Construct 3 r495 writes): `x`, `y`, `z`, `w`, `h`, `d`, `a`, `o`, `v` are booleans and `sm` is one of `normal`, `wrap`, `all`. Defaults for a fresh child are `x, y, z, w, h, d, a: true`, `o: false`, `v: false`, `sm: "normal"` — the shape carried by 598 of the 669 child records in the reference project (opacity and visibility are not inherited unless asked for).

**Notes:**
- Both instances must be world instances (placed on a layer) in the same layout; non-world instances have no hierarchy.
- Both sides of the link are maintained: the child's `sceneGraphData["parent-uid"]` and its own `flags`, and a `{ uid, flags }` entry with the same values on the parent's `sceneGraphData.children`. A record is created in Construct's shape (including the `preview` block) when the instance has none.
- Re-parenting removes the entry from the previous parent, and an emptied `children` array is dropped, matching how Construct writes childless instances.
- Self-parenting is refused, as is a parent that already descends from the child (a hierarchy cycle).
- Detaching an instance that has no hierarchy record returns `action: "unchanged"` and writes nothing.

### `remove_instance_children`

Detach every hierarchy child of a world instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `parentUid` | number | Yes | UID of the parent instance whose children are detached |

**Notes:**
- Clears each child's `parent-uid` and removes the parent's `children` array.
- A parent with no children returns `action: "unchanged"` with `detached: 0` and writes nothing.
- A listed child UID with no matching world instance in the layout is reported as a warning; the stale link is still removed.

### `update_project_metadata`

Update project-level metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Project name |
| `version` | string | No | Project version |
| `author` | string | No | Author name |
| `description` | string | No | Project description |

At least one parameter must be provided. Every other project setting, including the startup layout and viewport size, is handled by `update_project_properties`.

### `update_project_properties`

Update project settings beyond the four metadata fields: any key of `project.properties`, plus the top-level startup layout, viewport size, worker mode and functions name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `properties` | object | No | Values merged into `project.properties`, keyed by Construct property name (max 60 keys, depth 3) |
| `firstLayout` | string | No | Startup layout name (validated for existence) |
| `viewportWidth` | number | No | Project viewport width in pixels |
| `viewportHeight` | number | No | Project viewport height in pixels |
| `useWorker` | string | No | Worker mode; Construct writes values such as `dom` or `auto` |
| `functionsName` | string | No | Script-interface name for functions (must be a JavaScript identifier, e.g. `Fn`) |

At least one parameter must be provided.

**Valid `properties` keys** (the writer's allowlist, compile-checked against the `ProjectProperties` type): `anisotropicFiltering`, `appId`, `author`, `authorEmail`, `authorWebsite`, `autoIncrementVersion`, `backgroundColor`, `cordovaAndroidScheme`, `cordovaiOSScheme`, `description`, `downscaling`, `exportFileStructure`, `fixedFramerate`, `fov`, `framerateMode`, `fullscreenMode`, `fullscreenQuality`, `gpuPreference`, `loaderStyle`, `maxSpriteSheetSize`, `multitexturing`, `orientations`, `pixelRounding`, `preloadSounds`, `renderingMode`, `sampling`, `scriptsType`, `splashColor`, `themeColor`, `uidAllocationMode`, `useLoaderLayout`, `useThemeColor`, `version`, `viewportFit`, `webgpu`, `zAxisScale`, `zFar`, `zNear`.

**Notes:**
- An unknown key is rejected with the full valid-key list and nothing is written.
- Top-level keys (`name`, `firstLayout`, `viewportWidth`, `viewportHeight`, `useWorker`, `functionsName`) cannot be smuggled through `properties`; use the parameters above, or `update_project_metadata` for `name`.
- `name`, `version`, `author` and `description` remain available through `update_project_metadata`, which is unchanged.

### `register_addon`

Add an addon to the project's `usedAddons`. Known Scirra plugins and behaviors are registered automatically by `create_object` and `update_object_properties`; effects are not, so register an effect with this tool before `add_effect` uses it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` | Yes | Addon type |
| `id` | string | Yes | Addon ID (e.g. `"Sprite"`, `"Tween"`, `"hsladjust"`) |
| `name` | string | Yes | Display name |
| `author` | string | No | Author (default: `"Scirra"`) |
| `bundled` | boolean | No | Value of the entry's `bundled` flag (default: false) |

An addon that is already registered returns `action: "already_registered"` and nothing is written.

### `unregister_addon`

Remove an addon from `usedAddons`. Construct 3 errors on load if objects or behaviors still use it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` | Yes | Addon type |
| `id` | string | Yes | Addon ID |
| `force` | boolean | No | Required to remove a known Scirra built-in plugin or behavior (default: false) |

### `add_animation_to_sprite`

Add a new animation to a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name (e.g., `"Idle"`, `"Walk"`) |
| `speed` | number | No | Frames per second (default: 5) |
| `isLooping` | boolean | No | Loop the animation (default: true) |
| `isPingPong` | boolean | No | Ping-pong playback (default: false) |
| `repeatCount` | number | No | Repeat count if not looping (default: 1) |
| `frameCount` | number | No | Number of blank frames to create (default: 1) |
| `frameWidth` | number | No | Frame width in pixels (default: existing sprite width) |
| `frameHeight` | number | No | Frame height in pixels (default: existing sprite height) |

**Notes:**
- Validates the object is a Sprite plugin (rejects non-Sprite objects)
- Checks animation name uniqueness within the sprite, including the animations in animation folders (their image file names do not contain the folder), ignoring case like the editor. A name that differs from an existing animation's only in case (`"walk"` next to `"Walk"`) is refused too: image file names are all lowercase, so both animations would use the same image files
- Refuses a name with a character that cannot be part of its image file names (`images/<object>-<animation>-NNN.png`): a path separator (`/`, `\`), a character Windows does not allow in file names (`:` `*` `?` `"` `<` `>` `|`) or a control character. The animation names of the editor-saved projects checked use only letters, digits, spaces, `_` and `-`. `add_frame_to_animation` and `replace_sprite_image` refuse an existing animation with such a name
- Frame dimensions default to the existing first animation's frame size

### `update_animation_properties`

Update properties of an existing animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name to modify |
| `speed` | number | No | New speed (frames per second) |
| `isLooping` | boolean | No | New loop setting |
| `isPingPong` | boolean | No | New ping-pong setting |
| `repeatCount` | number | No | New repeat count |

At least one property must be provided.

Like the other tools that take an existing `animationName` (`delete_animation`, `rename_animation`, `add_frame_to_animation`, `delete_frame_from_animation`, `update_frame`, `replace_sprite_image`), it finds the animation by its exact name in any animation folder, where the animation stays. When the name is not found, the error lists the sprite's animations, those in animation folders with their folder path (e.g. `Moves/Walk`); pass the name alone.

### `delete_animation`

Delete an animation from a Sprite object; an animation in an animation folder is removed from that folder. The last animation cannot be deleted (animations in folders count). The animation's image files are left in `images/`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation to delete |

### `rename_animation`

Rename an animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Current animation name |
| `newName` | string | Yes | New animation name |

A new name that differs from another animation of the sprite (in any animation folder) only in case is refused (see [`add_animation_to_sprite`](#add_animation_to_sprite)); changing only the case of the animation's own name is allowed. `objectName` must be spelled exactly like the object's name: layout instances and event sheets name the object exactly, so a differently cased name (which Windows and macOS would still find the object file with) is refused.

The rename also does what the editor does when it renames an animation:
- **Frame image files** are renamed with it: for every frame, the file it uses, `images/<object>-<old name>-NNN.<ext>` (`.png`, `.jpg` for a JPEG frame, or the file's own extension for another format such as GIF), becomes `images/<object>-<new name>-NNN.<ext>`, all lowercase. A file whose name differs only in case is found too and gets the lowercase name. Frames, `sid` and `imageSpriteId`s stay as they are (the file name does not contain them). A frame without an image file is named in a warning, and a warning says so when no frame file needed renaming. Files no frame uses (another extension, or an index past the last frame) keep their names.
- **Layout instances** of the object whose `initial-animation` is the old name get the new name (on every layer and sub-layer).

It is refused, and nothing is changed, when:
- a renamed image would replace an existing file in `images/` (also one whose name differs only in case);
- the new name has a character that cannot be part of a file name (see [`add_animation_to_sprite`](#add_animation_to_sprite));
- another animation of the object (in any animation folder) has frames and a name that differs from the old name only in case: both use the same image files, and renaming them would leave the other animation without images. Delete the duplicate first (`delete_animation` leaves the image files in place).

The image files are renamed first, then the object and the layouts are written; if a write fails, the files already written, and the file whose write failed if it was already replaced (e.g. its post-write check failed), are restored from their backups and the image files are renamed back. The image moves are recorded in the change journal with the object and layout writes, so `revert_last_change` undoes the whole rename.

Strings in event sheets that name the old animation (e.g. `"Walk"` in *Set animation*) are not changed; a warning lists the event sheets with such parameters on the conditions and actions of the object and of the families it belongs to. Parameters that compute a name (e.g. `"Walk" & n`) are not counted.

### `add_frame_to_animation`

Add a blank frame (with a placeholder PNG in `images/`) to a Sprite animation. Like every image the tools write, the file is named as the editor names it: `<object>-<animation>-<frame, 3 digits>.png`, all lowercase, spaces kept (e.g. `hero-walk left-001.png`). Frames after the insertion point have their image files renamed to their new index, whatever their file type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `index` | integer | No | Insert at this frame index (default: append) |
| `width` | integer | No | Frame width in pixels (default: the first frame's) |
| `height` | integer | No | Frame height in pixels (default: the first frame's) |
| `duration` | number | No | Frame duration (default: `1`) |

### `delete_frame_from_animation`

Delete one frame of a Sprite animation, by index. The last frame cannot be deleted. The image files of later frames are renamed to their new index, whatever their file type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | integer | Yes | 0-based index of the frame to delete |

### `update_frame`

Update per-frame properties of one Sprite animation frame.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |
| `width` | number | No | New frame width in pixels |
| `height` | number | No | New frame height in pixels |
| `duration` | number | No | New frame duration in seconds |
| `originX` | number | No | Horizontal origin, normalized 0-1 |
| `originY` | number | No | Vertical origin, normalized 0-1 |
| `tag` | string | No | Frame tag; an empty string clears it |
| `imagePoints` | array | No | Replace the whole image point list with `{ name, x, y }` entries |
| `addImagePoints` | array | No | Append `{ name, x, y }` entries to the existing list |
| `removeImagePoints` | string[] | No | Remove image points by name |
| `collisionPoly` | number[] | No | Custom collision polygon as `[x0, y0, x1, y1, ...]`, or `[]` to clear it |
| `useCollisionPoly` | boolean | No | Whether C3 uses the custom polygon for this frame |

At least one updatable property must be provided.

**Notes:**
- Image point `x`/`y` are normalized 0-1 relative to the frame, and names must
  be unique within a frame. The frame origin is not an image point; it is
  stored separately as `originX`/`originY`.
- `imagePoints` replaces the whole list and cannot be combined with
  `addImagePoints` or `removeImagePoints`. Within one call, removals are
  applied before additions, so a point can be replaced by name.
- `removeImagePoints` fails if any named point is absent, rather than removing
  the points it did find.
- `collisionPoly` is a flat list of x,y pairs normalized 0-1 relative to the
  frame, so its length must be even and at least 6 (three points). Values
  outside 0-1 are accepted with a warning, because a polygon point may sit
  beyond the frame edge.

### `replace_sprite_image`

Replace the image of one Sprite animation frame with PNG data. The PNG is written to the frame's file in `images/` (the old image is backed up first, so `revert_last_change` can restore it); the object JSON is backed up and rewritten. The editor picks the file's extension from the frame's `fileType`, so a frame stored in another format (JPEG in `<name>.jpg`, GIF in `<name>.gif`) gets `fileType: "image/png"` and the new `<name>.png`; the old file is left in `images/` and a warning names it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object type |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | integer | Yes | 0-based frame index |
| `pngBase64` | string | Yes | The PNG, base64-encoded (checked for the PNG signature) |
| `width` | integer | No | Image width in pixels; updates the frame's metadata when given |
| `height` | integer | No | Image height in pixels; updates the frame's metadata when given |

**Notes:**
- Images of other object kinds are replaced with `replace_object_image`.

### `replace_object_image`

Replace the image of an object type that has a single `image` (Tiled Background, 9-patch, Particles, Sprite Font, Tilemap).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type name (Sprites are refused; use `replace_sprite_image`) |
| `pngBase64` | string | Yes | Base64 PNG data |

Writes `images/<lowercased name>.png`, the naming every single-image object uses in the r495 examples, and sets `image.width`/`image.height` from the PNG header (and `fileType` to `image/png` when the key is present). A Tilemap whose tileset changes size gets a warning, because tile numbers count across the image. If the object type write fails, the previous image is restored.

### `reorder_frames`

Reorder the frames of a Sprite animation. Every frame tool that moves, copies or renames image files (`reorder_frames`, `reverse_frames`, `duplicate_frame`, `delete_frame_from_animation`, `add_frame_to_animation`, `rename_animation`) takes each file's extension from the frame's `fileType`, so a GIF-backed frame is moved as `.gif`; only `image/png` and `image/gif` were seen in the r495.2 samples.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `order` | number[] | Yes | Full permutation of the current 0-based frame indices |

**Notes:**
- `order` must list every current frame index exactly once. A partial list, a
  repeated index, or an out-of-range index is rejected before anything is
  written.
- C3 addresses a frame's image by the frame index baked into its file name
  (`images/<object>-<animation>-NNN.png`), so the tool renames the frame image
  files to match the new order. Without that rename the reordered frames would
  each show whichever image previously sat at their index. The files are parked
  under temporary names first, and the renames are rolled back if the JSON
  write then fails.
- When no frame image files exist under `images/` the frame JSON is reordered
  on its own, and the result says so in `warnings`.

### `reverse_frames`

Reverse the frame order of a Sprite animation. Shares `reorder_frames`'
image-file handling.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |

### `duplicate_frame`

Duplicate one frame of a Sprite animation, copying both its JSON and its image
file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based index of the frame to duplicate |
| `insertAt` | number | No | 0-based insert position (default: immediately after the source frame) |

**Notes:**
- The copy receives a freshly generated `imageSpriteId` when the source frame
  has one, so the two frames do not share an image identity. A frame without
  that field stays without it.
- Frame image files at or after `insertAt` are shifted up by one and the source
  frame's image is copied into the freed slot. All moves are rolled back if the
  JSON write fails.

### `create_animation_folder`

Create an animation subfolder on a Sprite object, mirroring C3's
`animations.subfolders` tree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `folderPath` | string | Yes | Slash-separated folder path, e.g. `"Combat/Melee"` |

Missing parent folders are created. The call fails when the full path already
exists.

### `move_animation_to_folder`

Move an animation between the animations root and an existing subfolder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name to move |
| `folderPath` | string or null | Yes | Destination folder path, or `null` for the animations root |

The animation is found anywhere in the folder tree. The destination folder must
already exist; create it with `create_animation_folder` first. A move that
would not change the folder is rejected.

### `register_script_file`

Register a script file in `rootFileFolders.script`. The registration uses C3's
`script-info` metadata and an SID allocated by the project-wide ID generator.
The tool changes `project.c3proj` only; it does not copy or delete the script
file under `scripts/`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Script file name, without a folder path |
| `type` | string | No | MIME type (default: `application/javascript`) |
| `purpose` | string | No | `script-info.purpose` (default: `none`) |
| `subfolder` | string | No | Slash-separated folder path under `scripts/` |

### `deregister_script_file`

Remove a script registration from `rootFileFolders.script`; the script file
itself is preserved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Script file name |
| `subfolder` | string | No | Slash-separated folder path under `scripts/` |

### `register_project_file`

Copy a source file into the directory its Project File family uses and register
it under that family (`general`, `sound`, `music`, `video`, or `font`). The
registration uses `file-info` metadata and a collision-safe SID. Nested
subfolders are created below the family directory and mirrored in
`rootFileFolders`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourcePath` | string | Yes* | Source file to copy (`filePath` and `source` are aliases) |
| `name` | string | No | Destination name; defaults to source basename |
| `folder` | enum | No | `general`, `sound`, `music`, `video`, or `font` (default: `general`; `category` is an alias) |
| `type` | string | No | MIME type (`mimeType` is an alias; inferred when omitted) |
| `purpose` | string | No | `file-info.purpose` (default: `none`) |
| `subfolder` | string | No | Slash-separated folder path inside the family directory |

*Required unless the exact Project File registration already exists.

Each family keeps its files in its own directory of a project saved as a
folder, so a file copied into the wrong one leaves the registration pointing at
nothing:

| Family | Directory |
|--------|-----------|
| `general` | `files/` |
| `sound` | `sounds/` |
| `music` | `music/` |
| `video` | `videos/` |
| `font` | `fonts/` |

`files/` and `sounds/` are confirmed against the C3-ACE project on r495; the
other three follow Construct's project-folder layout.

### `create_data_file`

Create a Construct 3 data file under `files/` and register it as a `general`
Project File.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | File name including its extension |
| `kind` | enum | Yes | `array`, `dictionary`, `json`, or `text` |
| `content` | string | No | `dictionary`/`json`: a JSON document. `text`: the literal body. `array`: an optional JSON `[width][height][depth]` data array |
| `arraySize` | number[] | No | `array` only: `[width, height, depth]` (default: `[1, 1, 1]`) |
| `type` | string | No | MIME type recorded by C3 (inferred from `kind` when omitted) |
| `purpose` | string | No | `file-info.purpose` (default: `none`) |
| `subfolder` | string | No | Slash-separated folder path under `files/` |

**Notes:**
- `array` writes `{"c2array":true,"size":[w,h,d],"data":[[[...]]]}` and
  `dictionary` writes `{"c2dictionary":true,"data":{}}` — the bodies the Array
  and Dictionary plugins load. `json` and `text` are written verbatim for a
  project that parses them itself.
- `array` and `dictionary` register as `application/json`, `text` as
  `text/plain`.
- Supplied `array` content must match `arraySize` in all three dimensions.
- The tool never overwrites: it refuses when the name is already registered or
  a file already sits at the destination, and it deletes the file it wrote if
  the registration then fails.

### `set_main_script`

Mark one registered script as the project main script.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Registered script file name |
| `subfolder` | string | No | Script subfolder; required only when the same name is registered more than once |

**Notes:**
- Exactly one script may carry `script-info.purpose` of `main`, so the tool
  sets `main` on the target and clears every other script that held it back to
  `none`. Other purposes are left alone.
- The script must already be registered; register it with
  `register_script_file` first.
- The result reports `unchanged` when the script was already the main script.

### `deregister_project_file`

Remove a Project File registration and its corresponding file from the
directory its family uses (see the table under `register_project_file`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Project File name |
| `folder` | enum | No | Project File family (default: `general`; `category` is an alias) |
| `subfolder` | string | No | Slash-separated folder path inside the family directory |

---

## Timeline Tools

Timelines live in `timelines/[subfolder/]<name>.json` and are registered in the
`timelines` container of `project.c3proj`. The first nameless subfolder of
that container (the editor writes it first) lists custom eases, whose files live in `timelines/transitions/`
(see [Custom eases](#custom-eases)); timeline tools never treat either as a
timeline. Every write makes a `.bak` copy
first and then replaces the file through a temp file and a rename.

`playheadTime`, `stepTime` and the `showing*` flags are editor UI state: the
tools preserve whatever the editor wrote and never compute them. Unknown keys
survive a read-modify-write at the file, track, property-track and keyframe
level.

### File format

The track shape below was confirmed against a timeline saved by Construct 3
r495.2 with one instance track (`test/fixtures/timeline-sample`).

| Field | Meaning |
|-------|---------|
| `tracks[]` | Tracks at the root of the track list: `type` `instance-track`, `value-track` or `audio-track`. Tracks with no `type` are an older instance-track form (below) |
| `tracks[].worldInstance` | UID of the animated world instance |
| `tracks[].objectType` | Object type name of that instance |
| `tracks[].project` | The project's `uniqueId` |
| `tracks[].initialVisibility` | Visibility applied when the timeline starts. New tracks get `true` |
| `tracks[].virtualPosition` | Editor anchoring state. A new track gets the r495.2 values, including `relativeFlags: 16383`, which the tools never compute |
| `tracks[].keyframes[]` | Master keyframes: `{ time, tags, enabled, ease, pathMode }`. They carry no value |
| `tracks[].propertyTracks[]` | One per animated property: `{ property, source, enabled, interpolationMode, resultMode, ease, pathMode, propertyKeyframes }` |
| `propertyKeyframes[]` | `{ time, enabled, resultMode, ease, pathMode, value, rValue, aValue, addons }` |
| `propertyKeyframes[].addons` | r495.2 writes one `cubic-bezier` entry with all four anchors disabled; new keyframes get exactly that entry |
| `tracks[].propertyTracksRoot` | The per-track `Property Track Folder` tree |
| `tracksRoot` | Track folder tree. A track in a folder is removed from `tracks` and stored whole in the folder's `items` (robotic-loader example: 12 tracks in 3 folders, `tracks` empty). The root folder's own `items` stayed empty in every sample |
| `transitionsData[]` | `{ folders: [], json: <ease file> }`, one copy of each custom ease the timeline uses |

Other track kinds, from the r495.2 example packages:

| Kind | Shape |
|------|-------|
| `value-track` (10 samples, 3 packages) | `{ type, name, project, enabled, interpolationMode, ease, initialVisibility, id, keyframes, propertyTracks, propertyTracksRoot }` with no `resultMode`/`pathMode`/`resizeMode`. Master keyframes are `{ time, tags, enabled, ease }`. One property track, `{ property: "value", source: { type: "value", uid: "value" }, enabled, interpolationMode, ease, propertyKeyframes }`, whose keyframes are `{ time, enabled, ease, value, rValue, aValue, addons: [] }` with the three values equal (32 of 32) and one keyframe per master keyframe time |
| `audio-track` (1 sample, synth-sunset) | Like a value track plus `resultMode` after `interpolationMode`. One property track `{ property: "audioSource", source: { type: "audio", uid: "audio" }, enabled, propertyKeyframes: [], sourceAdapter }`; `sourceAdapter` is `{ audioProjectFile, audioStartOffset, audioTag, audioType }`, where `audioProjectFile` is a verbatim copy of the file's `rootFileFolders` entry and `audioType` names that folder (`music` in the sample) |
| untyped (5 samples, 4 packages saved by r168-r184) | An older instance track: `worldInstance` but no `type`, `objectType`, `project` or `resizeMode`; property keyframes without `resultMode` and mostly without `rValue`/`aValue`. No sample shows how Construct upgrades one, so the tools read these tracks, and can re-flag, move or remove them, but refuse edits that would rewrite their values (`set_keyframe`, `add_property_track`, a result-mode change) and refuse a second track for the same instance |

Property-track folders were sampled only as the editor's own folders for
behavior property tracks (tasty-cappuccino): each carries
`ownerId: "behavior"` and `ownerUid: <behavior name>` after `subfolders`.
The tools find and edit property tracks inside such folders but do not
create, rename or delete property-track folders.

Folders carry `resultMode` too. Every sampled folder (72 track roots, 397
property-track roots, 3 track folders, 6 property-track folders) has
`"default"`, so how Construct applies a folder's mode to the tracks inside is
unknown. Tools that compute stored values (`add_timeline_track`,
`add_property_track`, `set_keyframe`, a result-mode change in `update_track`
or `update_timeline`, and `move_timeline_track` for instance tracks) refuse
when a folder above the track or its property tracks has another mode.

### Keyframe values: `value`, `rValue` and `aValue`

`aValue` is the property's absolute value and `value` is its value relative to
the instance's own layout value. `rValue` equals `value` in every observed
keyframe, and these tools always write the two equal. In the sample, an
instance placed at x 324 has an offsetX keyframe of
`value: 0, rValue: 0, aValue: 324`, so for `offsetX` and `offsetY`:

```
value = rValue = absolute - instance.world.x|y
aValue = absolute
```

**Verified property names:** `offsetX` and `offsetY`. Those are the only two a
Construct sample confirmed, and the only two whose absolute and relative values
the tools can relate on their own.

**Unverified property names:** `property` is a free string, so a name the
Construct editor uses for width, height, angle, opacity, zElevation or color
can be written, but none of those names was observed and the Construct manual
text bundled with this server does not list them. Any name other than
`offsetX`/`offsetY` is accepted, reported in the result `warnings`, and given
no derived value: `set_keyframe` requires both `absolute` and `relative` for
it, and a track created for it starts at `value: 0, aValue: 0`. Check such a
track in the Construct 3 editor before relying on it.

Nested timelines (`nestedData`, `childrenNestedData`, `nestedTimelinesRoot`)
have no tool support. Their containers are created empty and preserved as
written.

Tools that take `instanceUid` or `trackName` address one track, wherever it is
in the track folders: an instance track by UID, or a value or audio track by
name. Give exactly one. Every timeline write also refreshes `transitionsData`:
a copy of each custom ease the timeline uses is added or updated, and copies of
project eases it no longer uses are dropped. Ease names that are neither
Construct's own ids nor a custom ease are written with a warning. Construct's
ids are `default`, `noease`, `linear` and `easein`/`easeout`/`easeinout`
followed by `sine`, `quad`, `cubic`, `quart`, `quint`, `expo`, `circ`, `back`,
`elastic` or `bounce`, in lower case. Fourteen of them were seen in the
samples; the rest complete Construct's documented list in the same pattern.

`update_timeline` refuses a result-mode change while an untyped (older) track
takes its mode from the timeline (neither the track nor its property tracks
set one); every sampled untyped track sets its own.

### `list_timelines`

List all timeline names (root and subfolders) with a count, in project-bar order. No parameters. Returns `{ timelines, count, transitions }`. Transitions (the custom easing curves in the editor's Transitions folder, which `project.c3proj` keeps as the first-level `timelines` subfolder without a `name`; see [Custom eases](#custom-eases)) are returned separately in `transitions`. Any other subfolder without a name is malformed (reported by `validate_project`); its items are not listed, the other timeline tools report them as unresolvable, and `create_timeline` refuses their names so they are not registered twice.

### `list_timeline_tracks`

Summarize every track: `kind` (`instance-track`, `value-track`, `audio-track`,
`legacy-instance-track` or `unknown`), `instanceUid`/`objectType` or `name`,
`folder`, `enabled`, `keyframeTimes`, and each property track's `property`,
`sourceType`, `folder` and `keyframeCount`. Audio tracks also report
`audioFile`, `audioType`, `audioStartOffset` and `audioTag`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |

### `get_timeline_details`

Return the parsed timeline file unchanged, including all tracks, property tracks and keyframes. The file is located from the timeline's folder in `project.c3proj`: `timelines/<name>.json` at the root, `timelines/<folder>/.../<name>.json` in a subfolder. Transitions (stored in `timelines/transitions/`) are refused and pointed to the ease tools: the timeline tools never read, change or delete them. A registered name whose file has no `tracks` (an ease file) is reported as not a timeline, and a file that cannot be read is named with the read error.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |

### `create_timeline`

Create a timeline in `timelines/` (or `timelines/<subfolder>/`) and register it in `project.c3proj`, in the same project-bar folder. The name must not be used by another timeline, by a transition (custom ease), or by an entry in a malformed nameless folder (see [`list_timelines`](#list_timelines)). Construct 3 compares timeline names exactly, but a name that differs only in case from a timeline in the same folder is refused: on Windows and macOS both would be one file. A case variant of a timeline in another folder, or of a transition, is created with a `warnings` entry. A `subfolder` folder that differs from an existing project-bar folder only in case is refused, and an existing file at the target path is never replaced (no backup is made on create).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name (unique) |
| `totalTime` | number | No | Total duration in seconds (default: 5) |
| `loop` | boolean | No | Loop the timeline (default: false) |
| `pingPong` | boolean | No | Ping-pong playback (default: false) |
| `repeatCount` | number | No | Repeat count when not looping (default: 1) |
| `startOnLayout` | string | No | Layout to auto-start on (default: `""` = none) |
| `ignoreSystemTimescale` | boolean | No | Ignore the system timescale (default: true) |
| `subfolder` | string | No | Project-bar folder within `timelines/`, `/`-separated (e.g. `"UI"` or `"UI/Menus"`), stored as the same folder on disk. A path starting with `transitions` (any case) is refused: Construct 3 keeps custom eases there |

### `update_timeline`

Update timeline-level properties of an existing timeline, in whichever `project.c3proj` folder it is. The file is backed up to `<file>.bak` and rewritten at the same path. Transitions are refused. At least one property is required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |
| `totalTime` | number | No | New duration in seconds |
| `loop`, `pingPong`, `enabled` | boolean | No | Playback flags; `enabled` enables or disables the timeline |
| `repeatCount` | number | No | Repeat count |
| `startOnLayout` | string | No | Auto-start layout (empty string = none) |
| `ignoreSystemTimescale` | boolean | No | Ignore system timescale |
| `ease` | string | No | Timeline-level ease name (e.g. `noease`) |
| `interpolationMode` | string | No | Timeline-level interpolation mode |
| `resultMode` | string | No | Timeline-level result mode |
| `pathMode` | string | No | Timeline-level path mode (e.g. `line`) |
| `transformWithSceneGraph` | boolean | No | Apply values through scene-graph parents |

The five mode strings are written as given: they are not validated against the
project's ease list or against an enumeration, because no such list was
observed in the project format.

### `delete_timeline`

Delete a timeline: back up exactly the file that is deleted to `<file>.bak`, delete it, and remove the timeline from its folder in `project.c3proj`. Transitions are refused, and so is a registered name whose file is not a timeline (an ease file).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name to delete |

**Notes:**
- A registered timeline whose file is missing is only removed from `project.c3proj`: the result has `action: "deregistered"` and a warning that no file was removed.
- When the file exists but cannot be deleted, the tool returns an error and `project.c3proj` is not changed. When `project.c3proj` cannot be updated after the file was deleted, the error says so.

### `add_timeline_track`

Add an instance track for one world instance, with a master keyframe at each
`keyframeTimes` entry and one property track per `properties` entry whose
keyframes hold the instance's current values. Refused when the instance already
has a track in this timeline, when the UID is not in the layout, when it is a
non-world instance, when `properties` repeats a name, or when a time falls
outside `[0, totalTime]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `layoutName` | string | Yes | Layout that holds the instance |
| `instanceUid` | number | Yes | UID of the world instance to animate |
| `properties` | string[] | No | Property track names (default: `["offsetX","offsetY"]`) |
| `keyframeTimes` | number[] | No | Master keyframe times in seconds (default: `[0]`) |

### `remove_timeline_track`

Remove one track, at the root or in a track folder, with all of its property
tracks and keyframes. Untyped (older) instance tracks can be removed too.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | One of | UID of the animated instance |
| `trackName` | string | One of | Name of a value or audio track |

### `add_property_track`

Add one property track to an existing instance track. Its keyframes are created
at every existing master keyframe time, holding the instance's current value
(`value: 0, aValue: 0` for an unverified property name). Refused when the track
already has that property, including inside a property-track folder, and on
untyped (older) tracks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | Yes | UID of the animated instance |
| `property` | string | Yes | Property name; only `offsetX` and `offsetY` are verified |

### `remove_property_track`

Remove one property track and all of its keyframes, also from a
property-track folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | Yes | UID of the animated instance |
| `property` | string | Yes | Property track name to remove |

### `set_keyframe`

Create or update the master keyframe at `time`, and create or update the
keyframe at `time` on each property track named in `values`, creating a missing
property track (reported in `warnings`). Keyframes stay sorted by time. `time`
must be within `[0, totalTime]`; raise `totalTime` with `update_timeline`
first if it is not.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | One of | UID of the animated instance; it must already have a track |
| `trackName` | string | One of | Name of a value or audio track |
| `time` | number | Yes | Keyframe time in seconds, within `[0, totalTime]` |
| `values` | object | No | Per-property `{ absolute?, relative?, ease? }`, e.g. `{ "offsetX": { "absolute": 400 } }`; `ease` sets that property keyframe's ease |
| `ease` | string | No | Master keyframe ease (a new keyframe gets `default`) |
| `enabled` | boolean | No | Master keyframe enabled flag |
| `tags` | string | No | Master keyframe tags string |

For `offsetX`/`offsetY`, give `absolute` **or** `relative` and the other is
computed from the instance's layout position; supplying neither is refused. For
any other property name, both `absolute` and `relative` are required, because
no mapping between them was observed; supplying only one is refused. Resolving
a position property needs the instance to still exist in some layout: a track
left behind by a deleted instance is refused with a message naming
`remove_timeline_track`.

A value track takes only `values.value` with an `absolute` number, and needs
it when `time` has no keyframe yet; its master keyframe and value keyframe are
kept at the same times. An audio track takes no `values`: only its master
keyframe is created or updated. Untyped (older) instance tracks are refused.

### `delete_keyframe`

Without `property`, delete the master keyframe at `time` and every property
keyframe at that time. With `property`, delete only that one property keyframe
and leave the master keyframe in place (instance tracks only). Deleting the
last remaining master keyframe is refused, because a track with no keyframes
is not a valid track; use `remove_timeline_track` instead. Property keyframes
inside property-track folders are removed with their master keyframe. An audio
track's keyframe at time 0 is also refused: Construct moves a keyframe there on
load, so deleting it would leave a track the editor silently rewrites.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | One of | UID of the animated instance |
| `trackName` | string | One of | Name of a value or audio track |
| `time` | number | Yes | Time of the keyframe to delete |
| `property` | string | No | Delete only this property track's keyframe |

### `update_track`

Update the playback properties of one track. At least one is required.
Keyframes and property tracks are left alone, except that a result-mode change
recomputes the stored `value` of typed instance-track keyframes. Fields a
track kind does not have are refused (`resultMode` on value tracks and untyped
tracks, `pathMode` on value and audio tracks).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | One of | UID of the animated instance |
| `trackName` | string | One of | Name of a value or audio track |
| `enabled` | boolean | No | Enable/disable the track |
| `ease` | string | No | Track ease name |
| `interpolationMode` | string | No | Track interpolation mode |
| `resultMode` | string | No | Track result mode (instance and audio tracks) |
| `pathMode` | string | No | Track path mode (instance tracks) |
| `initialVisibility` | boolean | No | Visibility applied when the timeline starts |
| `name` | string | No | New name of a value or audio track (unique in the timeline) |
| `audioFile` | string | No | Audio track: another registered sound or music file |
| `audioFolder` | `sound` / `music` | No | Where `audioFile` is registered, when both folders hold that name |
| `audioStartOffset` | number | No | Audio track: offset into the file, in seconds |
| `audioTag` | string | No | Audio track: tag given to the playing audio |

### `add_value_track`

Add a value track: a named number animated over time. Each keyframe creates a
master keyframe and a value keyframe at the same time. Refused when the
timeline already has a value or audio track of that name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `name` | string | Yes | Track name |
| `keyframes` | array | No | `{ time, value, ease? }` (default: one keyframe of value 0 at time 0) |
| `folder` | string | No | Track folder to put it in (default: the root) |

### `add_audio_track`

Add an audio track that plays a sound or music file. The file must be
registered in `rootFileFolders.sound` or `.music`; its entry is copied into
the track's `sourceAdapter.audioProjectFile` and the folder name becomes
`audioType`. Only one audio track was sampled, so check the result in the
editor. The result carries `trackName`.

`sourceAdapter.audioProjectFilePath` follows `audioProjectFile`. Live r495.2
saves of a project whose `exportFileStructure` was `folders` wrote
`media/Theme.webm` for a music file at the root and `media/Sfx/Blip.webm`
for a sound file in the Sounds subfolder `Sfx`; the r432.3 sample has no such
key. The tools write `media/[<subfolder>/]<file name>` when the project uses
`folders`, and no path otherwise, with a warning. `update_track` writes the
path when `audioFile` changes and removes a path that no longer applies.

The first keyframe must be at time 0: r495.2 moved a lone keyframe written at
1s back to 0, and the sampled audio track starts at 0.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `audioFile` | string | Yes | Registered file name, e.g. `Theme.webm` |
| `audioFolder` | `sound` / `music` | No | Needed only when both folders hold that name |
| `name` | string | No | Track name (default: `Audio Track N`, the next free number) |
| `audioStartOffset` | number | No | Offset into the file, in seconds (default: 0) |
| `audioTag` | string | No | Tag given to the playing audio (default: empty) |
| `keyframeTimes` | number[] | No | Master keyframe times (default: `[0]`) |
| `folder` | string | No | Track folder to put it in (default: the root) |

### `add_timeline_folder`, `rename_timeline_folder`, `delete_timeline_folder`

Edit track folders in `tracksRoot`. Folder paths are slash-separated
(`"Doors"`, `"Doors/Left"`); sibling folder names must differ. Every sampled
folder sat directly under the root, so creating a nested folder returns a
warning. Deleting a folder moves its tracks and subfolders to the parent
(tracks moved to the root go back into `tracks`) unless `deleteContents` is
true.

| Parameter | Type | Tool | Description |
|-----------|------|------|-------------|
| `timelineName` | string | all | Timeline name |
| `name` | string | add | New folder name |
| `parentFolder` | string | add | Parent folder (default: the root) |
| `folder` | string | rename, delete | Folder path |
| `newName` | string | rename | New folder name |
| `deleteContents` | boolean | delete | Delete the contents too (default: false) |

### `move_timeline_track`

Move a track into a track folder, or back to the root (`tracks`) with
`folder: ""`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | number | One of | UID of the animated instance |
| `trackName` | string | One of | Name of a value or audio track |
| `folder` | string | Yes | Destination track folder, or `""` for the root |

### Custom eases

A custom ease (sample: tasty-cappuccino `LightOutBack`) is
`timelines/transitions/<name>.json`:

```json
{
  "name": "LightOutBack",
  "linear": false,
  "purpose": "any",
  "transitionKeyframes": [
    { "x": 0, "y": 0, "sax": 0.433, "say": 1.329, "eax": 0, "eay": 0, "se": true, "ee": false, "sm": "cubic" },
    { "x": 1, "y": 1, "sax": 0, "say": 0, "eax": -0.355, "eay": 0.009, "se": false, "ee": true, "sm": "cubic" }
  ]
}
```

Its name is listed in the first nameless subfolder of the `project.c3proj`
`timelines` container (every sampled project has that folder, first among the subfolders), and each
timeline using the ease holds a copy in `transitionsData`. `sax`/`say` is the
outgoing handle and `eax`/`eay` the incoming handle, as offsets from the
point; `se`/`ee` mark which handles exist. The sample has two points only:
points between the ends get both handles, which is unsampled. `purpose` is
always written as `any`, the only sampled value.

#### `list_eases`

List custom eases with `linear`, `purpose`, `points`, `usedBy` (the
timelines that name the ease) and `usedByEventSheets` (sheets whose ACE `ease`
parameters name it, as a string or an embedded copy). No parameters.

#### `create_ease`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Ease name; refused when it equals a Construct ease id in any letter case, or is already an ease or timeline name |
| `points` | array | Yes | `{ x, y, startHandle?: { x, y }, endHandle?: { x, y } }` from `(0,0)` to `(1,1)`, x strictly increasing; the first point takes no `endHandle` and the last no `startHandle` |
| `linear` | boolean | No | Default: false |

#### `update_ease`

Rewrite the points or `linear` flag, then refresh the copy in every timeline
that uses the ease and every embedded copy in an event-sheet `ease`
parameter. The result lists `timelinesRefreshed` and `eventSheetsRefreshed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Ease name |
| `points` | array | No | New points, as for `create_ease` |
| `linear` | boolean | No | New flag |

#### `delete_ease`

Delete an ease that no timeline uses: first its registration, then its file
and `.uistate.json` (with `.bak` copies), and any stale copy left in a
timeline's `transitionsData`. Refused, naming them, while a timeline uses the
ease or a registered timeline cannot be opened. The Tween behavior and
scripts can also name an ease, so event sheets and registered script files
are searched for the name as a whole word; a hit, or a file that cannot be
read, refuses the delete unless `force` is true, and a forced delete reports
them in `warnings`. A forced delete leaves embedded copies in event
parameters in place (and says so); what Construct does with such a copy
after its ease is gone was not sampled.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Ease name |
| `force` | boolean | No | Delete despite event-sheet or script mentions (default: false) |

---

## Effect Tools

Effects attach to object types, families, layers, and layouts. Object-type and family effects keep the shared definition on the type (`effectTypes: [{ effectId, name }]`) and the per-instance state on every placed instance (`effects: { name: { isEnabled, parameters } }`). Layer and layout effects keep both in one entry (`effectTypes: [{ effectId, name, instance: { isEnabled, parameters } }]`).

Effects are never auto-registered: the effect addon must already be listed in `usedAddons` (add it in the Construct editor or with `register_addon`), because the effect's files must be present in the project. Neither coordinate parameter defaults nor parameter validation come from the addon; when `parameters` are omitted the tools write an empty parameter set for Construct to default on load.

All targets take the same addressing parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `targetType` | `objectType` / `family` / `layer` / `layout` | Yes | What the effect is attached to |
| `targetName` | string | Yes | Object type, family, layout, or layer name |
| `layoutName` | string | For `layer` | The layout containing the layer |

### `list_effects`

Returns the target's effect stack and the effect addon IDs registered in the project.

### `add_effect`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `effectId` | string | Yes | Effect addon ID from `usedAddons` |
| `name` | string | No | Effect name shown in the editor (default: the ID); must be unique on the target |
| `parameters` | object | No | Initial parameter values |
| `isEnabled` | boolean | No | Initially enabled (default: true) |
| `index` | number | No | Position in the stack (default: append) |

For object-type and family targets, every placed instance of the type (or of each member) receives the per-instance state; the layouts written are listed in `warnings`.

### `update_effect`

Set `isEnabled` and/or merge `parameters` on a **layer or layout** effect identified by `name`. Per-instance state of object-type and family effects is edited with `update_instance` (`effects`).

### `remove_effect`

Remove the effect named `name` from the target, and its per-instance state from every placed instance.

### `reorder_effects`

`names` must list every effect on the target exactly once, in the new order. Effects render in array order.
## Flowchart Tools

Flowcharts live in `flowcharts/[subfolder/]<name>.json` and are registered in
the `flowcharts` container of `project.c3proj`, exactly like timelines. Every
new `sid` comes from the project-wide ID generator, and every write makes a
`.bak` copy first and then replaces the file through a temp file and a rename.

### File format

The shape below was confirmed against a real Construct 3 r495 project (31
flowchart files, 1539 nodes).

| Field | Meaning |
|-------|---------|
| `sid`, `name`, `w`, `h` | Flowchart SID, name and canvas size (20000 x 20000 on a new flowchart) |
| `preset-nodes` | `{ items, subfolders }` preset-node folder tree |
| `nodes[].t` | Node type/title. Equal to `c` on 1170 of the 1539 sampled nodes; empty on comment boxes |
| `nodes[].c` | Node caption. **Not** a color: node and output colors live in the sibling `<name>.uistate.json` |
| `nodes[].s` | Start node. All 31 sampled files carry exactly one |
| `nodes[].e` | Enabled |
| `nodes[].ty` | Value type. Observed values: `dictionary` (1373) and `comment` (166) |
| `nodes[].n`, `fo`, `fs`, `fb`, `fi`, `fc` | Comment nodes only, after `prfnsid`: body as the editor's HTML (first line plain, later lines in `<div>`, blank lines `<div><br></div>`), font face, font size, bold, italic and `#rrggbb` font color. Comment nodes have no outputs or connections and `t: ""`; their `c` is a separate caption |
| `nodes[].pi` | Observed values 0, 1 and 2; meaning could not be determined from the sample |
| `nodes[].pr`, `prfsid`, `prfnsid` | Preset-node markers. Never taken from tool input: new nodes get `false`/`null`/`null` and existing nodes keep whatever they carry |
| `nodes[].pnSIDs`, `poSIDs` | Strictly parallel, one entry per incoming connection (1295 of 1295 sampled pairs valid): `poSIDs[i]` is an output of the node `pnSIDs[i]` |
| `nodes[].nodeSIDs` | Distinct child node SIDs, in an order independent of the `outputs` array order |
| `nodes[].outputs[]` | `{ sid, cnSID, name, value, enable, default }`; `cnSID` is the connected node SID or `null` |

Every unknown key is preserved on read-modify-write, at both the file and node
level. These tools never create, update or delete the sibling
`<name>.uistate.json` except when `delete_flowchart` removes the flowchart
itself, which removes that file too (with its own `.bak`).

### `list_flowcharts`

List every flowchart registered in the project, at the container root and in
every subfolder. Returns `{ flowcharts: string[], count: number }`.

No parameters.

### `get_flowchart_details`

Return the parsed flowchart file, including all nodes, outputs and connections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Flowchart name |

### `create_flowchart`

Create an empty flowchart file and register it. The call is refused when the
Flowchart plugin is not already in `usedAddons`; add a Flowchart object in the
Construct 3 editor first, because this tool never registers plugins itself.
Duplicate names are refused wherever the existing name is registered.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Flowchart name |
| `subfolder` | string | No | Slash-separated folder path under `flowcharts/`, created in both places |

### `delete_flowchart`

Delete the flowchart file, its `.uistate.json` sibling and the `project.c3proj`
registration. The file is removed first, so a failure leaves the registration
intact and the call retryable.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Flowchart name to delete |

### `add_flowchart_node`

Add a node. Outputs are created unconnected; wire them with
`connect_flowchart_nodes`. When `isStart` is true the flag is cleared on every
other node, because Construct 3 keeps exactly one start node per flowchart. The
result carries `generatedSid` for the node and `outputSids` for its pins, plus a
warning when the flowchart is left without a start node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `caption` | string | Yes | Node caption (the `c` field) |
| `nodeType` | string | No | Node type/title (the `t` field; defaults to `caption`) |
| `x`, `y` | number | Yes | Canvas position |
| `width`, `height` | number | No | Box size (defaults: 300 x 133) |
| `isStart` | boolean | No | Make this the start node (default: false) |
| `enabled` | boolean | No | The `e` field (default: true) |
| `valueType` | `dictionary` / `comment` | No | The `ty` field (default: `dictionary`). A comment node takes no `outputs`, gets `t: ""` unless `nodeType` is given, and gets the comment keys |
| `outputs` | array | No | `{ name, value?, enabled?, isDefault? }` pins to create |
| `commentText` | string | No | Comment body as plain text, escaped and stored as the editor's HTML (default: the caption). Runs of spaces become alternating `&nbsp;` and spaces starting with `&nbsp;`, ending in `&nbsp;` at a line end, and a lone space at a line start or end becomes `&nbsp;`, as in 7,888 of the 7,922 space runs in the C3-ACE comments |
| `commentHtml` | string | No | Comment body as HTML, stored unchanged; give this or `commentText` |
| `font`, `fontSize`, `bold`, `italic`, `fontColor` | string, number, boolean, boolean, `#rrggbb` | No | Comment formatting (`fo`, `fs`, `fb`, `fi`, `fc`). Missing values take the most common sampled values (Calibri, 36, bold, not italic, `#39b530`) with a warning; Construct's own defaults were not sampled |

The comment fields are refused on a dictionary node, and a comment node
cannot be the start node (none of the 166 sampled comment nodes is).

There is no `color` parameter: the node `c` field is the caption, and colors are
held in the `.uistate.json` file these tools do not write.

### `update_flowchart_node`

Update node properties. Connections, preset markers and unknown keys are
preserved. `isStart: true` clears the flag on every other node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | SID of the node to update |
| `caption` | string | No | New caption (`c`) |
| `nodeType` | string | No | New type/title (`t`) |
| `tags` | string | No | Writes a `tags` key. **Not observed** in any r495 sample flowchart; the result carries a warning saying so |
| `isStart` | boolean | No | Set or clear the start flag |
| `enabled` | boolean | No | The `e` field |
| `parentIndex` | number | No | The `pi` field (meaning undetermined) |
| `x`, `y`, `width`, `height` | number | No | Canvas position and box size |
| `valueType` | `dictionary` / `comment` | No | Change the `ty` field. To `comment`: refused while the node has outputs or connections, or is (or is being made) the start node; `t` is cleared and the comment keys are added (body from the caption unless given). To `dictionary`: the comment keys are removed and an empty `t` takes the caption |
| `commentText`, `commentHtml`, `font`, `fontSize`, `bold`, `italic`, `fontColor` | | No | Comment fields as for `add_flowchart_node`; only on a node that is, or becomes, a comment |

### `delete_flowchart_node`

Delete a node and clean every reference to it: other nodes' `nodeSIDs`, their
parallel `pnSIDs`/`poSIDs` entries, and any output whose `cnSID` pointed at it
(set back to `null`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | SID of the node to delete |

### `add_flowchart_output`

Add an output pin, unconnected, at the end of the array or at `index`.
Refused on a comment node, which has no outputs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | Node to add the pin to |
| `name` | string | Yes | Output pin name |
| `value` | string | No | Output value (default: empty string) |
| `enabled` | boolean | No | The `enable` field (default: true) |
| `isDefault` | boolean | No | The `default` field (default: false) |
| `index` | number | No | Insertion index; must not exceed the current output count |

### `update_flowchart_output`

Update an output pin. Its `cnSID` is preserved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | SID of the output to update |
| `name`, `value` | string | No | New name / value |
| `enabled` | boolean | No | The `enable` field |
| `isDefault` | boolean | No | The `default` field |

### `delete_flowchart_output`

Delete an output pin, first undoing any connection it held.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | SID of the output to delete |

### `reorder_flowchart_outputs`

Reorder a node's output pins. `outputSids` must be a permutation of that node's
current output SIDs, so a wrong, short or duplicated list is rejected and
nothing is written. Output array order is execution order in Construct 3, so
this changes behavior.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | Node whose outputs to reorder |
| `outputSids` | number[] | Yes | The node's output SIDs in their new order |

### `connect_flowchart_nodes`

Set the output's `cnSID`, append the source node SID to the target's `pnSIDs`
and the output SID to its `poSIDs`, and add the target to the source's
`nodeSIDs`. Connecting a node to itself is refused, as is reusing an output that
is already connected (disconnect it first) and connecting from or to a comment
node, which has no connections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | Source output pin |
| `targetNodeSid` | number | Yes | Node to connect to |

### `disconnect_flowchart_nodes`

Reverse one connection. Because `pnSIDs` and `poSIDs` are per connection, only
the entry for this output is removed; the target stays in the source's
`nodeSIDs` while any other output still points at it, so a second connection
between the same two nodes survives untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | Output pin to disconnect |

---

## Structure Tools

Moving and copying Project Bar items (`src/tools/structure-tools.ts`) and
Construct's Replace object and expression find-and-replace
(`src/tools/replace-tools.ts`).

### Project Bar folders

`project.c3proj` stores each tree as `{ "items": [...], "subfolders": [...] }`
and each folder as `{ "items", "subfolders", "name" }`, in that key order.
Construct keeps the file path in step with the folder: an item in folder
`Enemies/Bosses` lives at `<category>/Enemies/Bosses/<name>.json`, with its
`<name>.uistate.json` beside it (sheets, layouts, flowcharts) and, for a
layout, `layouts/uistate/Enemies/Bosses/<name>.instancesBar.json`. A tilemap's
brush file mirrors the object type's folder under
`tilemapBrushes/objectTypes/`. Scripts and imported project files follow the
same rule under `scripts/` and `files/`. Folders keep the user's order; new
ones are appended.

### `move_project_item`

Move an existing item to another folder, or to the root.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | enum | Yes | `objectType`, `family`, `layout`, `eventSheet`, `flowchart`, `script` or `file` (an imported project file under `files/`) |
| `name` | string | Yes | Item name; for scripts and files, the file name (`main.js`) |
| `folder` | string | No | Destination path such as `Enemies/Bosses`; empty (default) moves to the root |
| `sourceFolder` | string | No | Scripts and files: the current folder, when the file name exists in more than one folder |
| `createFolders` | boolean | No | Create a missing destination path (default `true`) |

The files are copied to the new location first, then `project.c3proj` is
rewritten, then the old files are deleted. A failure before the rewrite
removes the copies; a failure after `project.c3proj` was replaced (while
verifying or re-reading it) keeps them and finishes the move with a warning,
because the project already points at the new location. An old file that
cannot be deleted is reported in a warning. A move is refused when any
destination file already exists. The emptied source folder is kept, with a
warning.

Folder names become directory names, so they are matched without case: moving
to `enemies` when `Enemies` exists uses `Enemies` (with a warning), and the
current folder in another case counts as the same folder. Segments that
Windows cannot store are refused: a leading space, a trailing space or dot,
`< > : " | ? *` or control characters, and reserved device names such as
`CON` or `LPT1`. Moving a script
warns that module imports naming its path are not rewritten. Timelines cannot
be moved: no sample project has a timeline in a named folder.

Result: `from`, `to`, `foldersCreated`, `filesMoved` (`[{ from, to }]`),
`warnings`, `backupFile`.

### Duplicates

Every duplicate gets fresh SIDs throughout (one old SID always maps to the
same new SID inside the copy), is registered directly after its source in the
same folder, and does not copy editor state (`*.uistate.json`,
`*.instancesBar.json`). New names are compared with existing ones without
case, because they become file names. A copy that cannot be faithful is
refused with the reason and nothing is written.

### `duplicate_layout`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout to copy |
| `newName` | string | Yes | Name of the copy |

Every instance (world and non-world) gets a UID above the project maximum;
`sceneGraphData.uid`, `parent-uid` and `children[].uid` are remapped through
the same map, and `instanceFolderItem.sid` and `scene-graphs-folder-root`
entries follow their instance's new SID. The copy keeps `eventSheet`. Refused
when an instance is a template (`template.mode: "template"`), because a
template name exists only once per object type; replicas copy normally. Warns
when the layout places global object types, when a timeline addresses one of
the source instances by UID (the copy is not animated), and when an event
picks one of them by a fixed `unique-id` (it still picks the original).

### `duplicate_layer`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout that owns the layer |
| `layerName` | string | Yes | Layer to copy |
| `newName` | string | Yes | Name of the new layer (unique in the layout) |

The copy is inserted directly above the source (the next index in the same
sibling array). Its instances get new UIDs and SIDs, and a
`scene-graphs-folder-root` entry is added after each entry of a copied
instance. Refused for a layer with sub-layers (their names would repeat), for
template instances, and for hierarchy links to instances on other layers.

### `duplicate_event_sheet`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet to copy |
| `newName` | string | Yes | Name of the copy |

Refused when the sheet declares a group, a function, a custom action or a
root-level (global) variable anywhere, since the copy would declare the name
twice. Group names are unique project-wide: the samples hold 508 groups with no
title repeated within a project. The copy is attached to no layout.

### `duplicate_object_type`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type to copy |
| `newName` | string | Yes | Name of the copy (must not match an object type or family) |

Behaviors, instance variables, effects and animations are copied with fresh
SIDs and fresh `imageSpriteId` values. Image files named from the lowercased
object name (`<name>-<animation>-NNN.<ext>` and `<name>.<ext>`) are copied
under the new name, and a tilemap brush file is copied beside the original.
No instances are placed, and family and container membership is not copied
(the result warns). Single-global objects are refused.

### `duplicate_timeline`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline at the root of the timelines tree |
| `newName` | string | Yes | Name of the copy |

Writes `timelines/<newName>.json` with only `name` changed. The copy's tracks
address the same instances by UID. Custom eases (the unnamed subfolder of the timelines list) are refused.

### `replace_object_in_events`

Construct's event-sheet Replace object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromObject` | string | Yes | Object type or family to replace |
| `toObject` | string | Yes | Replacement of the same plugin |
| `sheetName` | string | No | Limit to one sheet (default: all sheets) |
| `dryRun` | boolean | No | Report only (default `false`) |

The references are the rename scanner's: `objectClass`, the bare object-name
parameters (`object`, `object-to-create`, `parent`, `child`, `instance`) and
identifier tokens in expressions. The unit of a swap is a branch: an event
that references the replaced object together with all its sub-events, which
share its picked instances. A branch is swapped whole or not at all; the
reasons of a sub-event are reported as `sub-event <path>: ...` on the branch's
top event. An event is incompatible when a condition or action on the replaced object uses a
behavior (`behaviorType`), an instance variable (`instance-variable`) or an
effect (an `effect` parameter holding a quoted name) that the replacement
lacks (object types inherit their families' behaviors, variables and
effects), or has one of the same name but of another kind (a `Move` that is
Platform on the replaced object and Bullet on the replacement), when an
expression reads `From.Member` for such a behavior or variable, or when it
calls a custom action. A custom action definition owned
by the replaced object is skipped with its body. Layouts are not changed. The
result has `references` (as in the rename tools), `skippedEvents`
(`[{ file, path, eventSid, references, reasons }]`) and `filesWritten`. The
swapped conditions and actions are checked as described in
[ACE validation](#ace-validation), and each problem is a warning.

### `replace_in_expressions`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `find` | string | Yes | Text, or a regular expression when `regex` is true |
| `replace` | string | Yes | Replacement; `$1`-style groups only with `regex` |
| `regex` | boolean | No | Default `false` |
| `caseSensitive` | boolean | No | Default `true` |
| `wholeWord` | boolean | No | Default `false` |
| `sheets` | string[] | No | Limit to these sheets |
| `parameterKeys` | string[] | No | Only these parameter keys; positional call arguments use `"0"`, `"1"`, ... |
| `dryRun` | boolean | No | Report only (default `false`) |
| `maxReported` | number | No | Individual changes listed (default 100); counts are always complete |

The rewritten conditions and actions are checked as described in [ACE validation](#ace-validation), so a combo value changed through `parameterKeys` that is no longer one of its choices draws a warning. A dry run is not checked.

Only condition and action parameter strings are changed, never comments,
scripts or variable declarations. Parameters that hold a name are skipped
unless `parameterKeys` names their key: `variable`, `instance-variable`,
`object`, `object-to-create`, `parent`, `child`, `instance`, `layout`,
`timeline`, `property`, `object-class`, `pin-to`, `target`, `function`,
`file` and `audio-file` (keys whose sample values are names). So are combo
choices (a bare lower-case ID such as `enabled` under keys like `state`,
`mode`, `ease` or `visibility`). Matches in skipped parameters are counted in
a warning. Repeated `sheets` entries are scanned once.

A pattern that matches zero characters anywhere (for example `a?` with
`wholeWord`) is refused before anything is written. All matching for one call
runs in a `vm` script limited to 2000 ms in total; V8 enforces the limit inside
regular expression execution, so a catastrophically backtracking pattern
fails the call instead of hanging the server. The result has `totalMatches`, `parametersChanged`, `bySheet`,
`changes` (`[{ sheet, eventSid, path, key, before, after }]`) and
`filesWritten`.

---

## Rename Tools

Renaming an entity in Construct 3 touches many files: the name is duplicated
into event sheets, layouts, families, `project.c3proj` trees and containers,
the entity's own file name, and (for object types) its image and tilemap-brush
file names. These tools collect every reference through one shared scanner,
rewrite exactly what they report, and return the counts per reference kind.

Every tool accepts `dryRun` (default `false`). A dry run returns the same
reference report and writes nothing.

**Result shape** (extends the standard `WriteResult`):

```json
{
  "success": true,
  "entity": "Hero",
  "category": "objecttype",
  "action": "renamed",
  "previousName": "Player",
  "references": {
    "total": 21,
    "byKind": { "objectClass": 4, "expression": 6, "instanceType": 2 },
    "byFile": [
      { "file": "eventSheets/Main.json", "count": 13, "kinds": { "objectClass": 4 } }
    ]
  },
  "filesWritten": ["eventSheets/Main.json", "project.c3proj"],
  "dryRun": false,
  "warnings": ["..."],
  "backupFile": "..."
}
```

### Expression rewriting

Expression text is rewritten token-aware, never textually:

- only a whole identifier run matches, so `PlayerShip.X` survives a rename of
  `Player`;
- a run right after a `.` is a member name, so `Enemy.Player` is left alone;
- text inside a `"..."` string literal is never touched, so
  `"Player wins" & Player.X` rewrites only the second occurrence.

Layer names are the one exception: a layer reaches an expression only as a
whole string literal (`"layer": "\"UI\""`, `LayerScale("UI")`), so
`rename_layer` rewrites whole literals and nothing else.

### Write order and interrupted renames

Referencing files are written first and the entity itself (file plus
`project.c3proj` registration) last. Every scan looks for the *old* name, so a
file already rewritten contributes nothing on a second pass: re-running the
identical call after a failure finishes the rename. Each result lists
`filesWritten` in order, and a failure message repeats that list.

### What is never rewritten

| Location | Why |
|---|---|
| `script` action and event bodies | JavaScript; a name there cannot be told from an unrelated identifier. Counted and reported as a warning. |
| `comment` text and a variable's `initialValue` | Free text. Counted and reported as a warning. |
| Instance-variable values holding a layer or layout name | Data, not a reference. |
| `parameters.instance-variable` | A different name space from event variables. |
| Layout names in general expression text | No layout-valued parameter exists in the reference project, so only `layout`-keyed parameters are rewritten. |

### `rename_object_type`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current object type name |
| `newName` | string | Yes | New name; must be unique among object types *and* families |
| `dryRun` | boolean | No | Report only (default `false`) |

Object type, family, layout and event sheet names are compared without case, because they become file names: renaming `Player` to `enemy` while `Enemy` exists is refused, since on Windows or macOS the new file would replace the other entity's. A rename that changes only the case of the same name (`Main` to `MAIN`) is refused too, because the new file would replace the old before the old is deleted; rename to a temporary name first, then to the final one.

Reference kinds: `objectClass` (conditions and actions),
`customAceObjectClass` (a `custom-ace-block` event's owner),
`parameterObjectName` (the bare-name keys `object`, `object-to-create`,
`parent`, `child`, `instance`), `expression` (identifier tokens in any other
string parameter, including the array-form arguments of a custom-action call),
`instanceType` (layout instances, nested sub-layers and `nonworld-instances`),
`familyMember`, `containerMember` (`containers[].members`),
`timelineTrackObjectType` (`tracks[].objectType` on an instance track, in
every `timelines/**/*.json`), `projectTree`, `entityName`, `entityFile`,
`imageFile` (`images/<lowercase name>-...png` and the TiledBg form
`images/<lowercase name>.png`) and `tilemapBrushFile`.

Timeline files are found by walking the `timelines/` directory rather than the
`project.c3proj` `timelines` tree, so a transition timeline in a subfolder the
tree does not list is still rewritten; `*.uistate.json` siblings are skipped.
Construct r495.2 refuses to open a project whose track names an object type
that no longer exists, so this is not optional. A track's `worldInstance` and
a property track's `source: { type: "world-instance", uid }` address an
instance by UID and are left alone, as is `tracks[].project` (the project's
`uniqueId`).

An image whose new name is already taken is skipped with a warning rather
than overwritten.

### `rename_family`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current family name |
| `newName` | string | Yes | New name; must be unique among families *and* object types |
| `dryRun` | boolean | No | Report only |

Same event-sheet kinds as `rename_object_type`, plus `projectTree`,
`entityName` and `entityFile`. A family has no layout instances, images or
brush file, and its own `members` list holds object types, which a family
rename does not touch.

### `rename_layout`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current layout name |
| `newName` | string | Yes | New layout name |
| `dryRun` | boolean | No | Report only |

Reference kinds: `firstLayout`, `projectTree`, `timelineStartOnLayout`
(`startOnLayout`, the only key in a timeline file that names a layout, in
every `timelines/**/*.json`), `layoutParameter` (a `layout`-keyed parameter,
in both the bare-name and quoted-expression forms), `entityName` and
`entityFile`.

### `rename_event_sheet`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current event sheet name |
| `newName` | string | Yes | New event sheet name |
| `dryRun` | boolean | No | Report only |

Reference kinds: `layoutEventSheet` (each layout's `eventSheet`),
`includeSheet`, `projectTree`, `entityName` and `entityFile`.

### `rename_layer`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout that owns the layer |
| `layerName` | string | Yes | Current layer name |
| `newName` | string | Yes | New name; must be unique within this layout |
| `dryRun` | boolean | No | Report only |

Reference kinds: `layerName` (the layer in its layout), `layerParameter` (a
`layer`-keyed parameter) and `layerLiteral` (a whole `"<name>"` literal in any
other expression, such as `LayerScale("UI")`).

A layer name is unique only within its layout, but an event-sheet `layer`
parameter is not layout-scoped. When another layout has a layer of the same
name, the event-sheet pass is skipped and the affected layouts are named in a
warning; only the chosen layout's layer is renamed.

### `rename_event_variable`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Sheet holding the declaration |
| `sid` | number | Yes | SID of the `variable` event |
| `newName` | string | Yes | New variable name |
| `dryRun` | boolean | No | Report only |

Reference kinds: `variableDeclaration`, `variableParameter` (the `variable`
key used by `set-eventvar-value`, `add-to-eventvar`, `subtract-from-eventvar`,
`reset-eventvar` and `compare-eventvar`) and `expression`.

A declaration at the sheet root is a global event variable and is rewritten
across every sheet; a nested declaration is local and only its own sheet is
rewritten. A new name that collides with another sheet's global is refused; a
local declaration of the same name is allowed but warned about, because
Construct resolves the local first inside its container.

---

## Template and Tilemap Tools

### Instance templates

A Construct 3 template is a layout instance the editor treats as the master
copy for other instances ("replicas"). The state lives entirely in the
instance's `template` block inside `layouts/<name>.json`; there is no separate
registry. The block carries `mode`, `templateName`, `sourceTemplateName`, the
three hierarchy flags, a `components` list and `replicasUIDs`.

`components` always holds the five ids `plugin`, `instance-variable`,
`behavior`, `effect` and `world-instance`, in that order. Each entry says
which properties the instance keeps in sync with its template. The tools
derive them from the instance itself:

| Component | Derived from | Notes |
|---|---|---|
| `plugin` | the instance's `properties` keys | `live-preview` is excluded; it is the only property observed being dropped |
| `instance-variable` | `instanceVariables` keys | written as `{ iv, state }` records |
| `behavior` | one entry per `behaviors` key | state lists that behavior's own property keys; a behavior with no properties gets `[]` |
| `effect` | one entry per `effects` key | state lists the effect's parameters plus the `<<effect-template-enable>>` marker |
| `world-instance` | fixed 24-key list | `x` and `y` are `false`, every other key `true`; empty for a non-world instance |

`replicasUIDs` is always written as `null`: it is `null` on every template
block on disk, including templates that have replicas, so Construct
recomputes it on load.

### `list_templates`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectType` | string | No | Only list templates for this object type |

Returns one row per template instance with its `templateName`, `objectType`,
`layout`, `uid` and `replicaCount`. A replica whose named template is not in
the project is reported separately under `orphanedReplicas`.

### `set_instance_template`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout holding the instance |
| `uid` | number | Yes | Instance UID (searched across nested sub-layers and non-world instances) |
| `mode` | enum | Yes | `none`, `template` or `replica` |
| `templateName` | string | For `template` | Template name; must be unique per object type |
| `sourceTemplateName` | string | For `replica` | Name of the template to follow |

`none` removes the `template` block. `replica` is written even when the named
template does not exist yet, with a warning. A non-world instance gets a
warning: no template block was observed on one in the reference project.

### `set_default_template`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type name |
| `templateName` | string \| null | Yes | Template to create new instances from, or `null` to clear it |

Sets `editorNewInstanceIsReplica` and `editorNewInstanceTemplateName` on the
object type, which is how the editor decides what a newly placed instance
copies. In the reference project 109 object types carry the flag and only 53
also carry the name, so the flag can stand alone; this tool always writes them
together and says so in a warning.

### Tilemap brushes

A tilemap object type's editor brushes live at
`tilemapBrushes/objectTypes/<same subfolder as the object type>/<name>.brush.json`
— the brush path mirrors the object type's subfolder. The file is a JSON array
of `{ name, type, data }`:

| `type` | `data` |
|---|---|
| `auto16` | 4 rows of 4 cells |
| `auto47` | 6 rows of 8 cells |
| `patch` | `{ width, height, data }`, where `data` has `height` rows of `width` cells |

A cell is a non-negative tile index, `null` for an empty cell, or a list of
weighted alternatives `[{ index, probability }, ...]`. Grid dimensions and
every cell are validated before the file is written.

**Tile data is not implemented.** No sample of a Tilemap instance's tile-data
serialization exists in the reference project, so its shape would have to be
invented; use the Construct editor for tile data.

### `list_tilemap_brushes`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |

Returns the brush file path, whether it exists, and each brush's index, name,
type and grid size. A non-`Tilemap` plugin is a warning, not an error.

### `add_tilemap_brush`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |
| `name` | string | Yes | Brush name, unique within this object type |
| `type` | enum | Yes | `auto16`, `auto47` or `patch` |
| `data` | object | Yes | Grid matching the type |

Creates the brush file when it does not exist yet.

### `update_tilemap_brush`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |
| `name` | string | Yes | Current brush name |
| `newName` | string | No | New brush name |
| `type` | enum | No | New brush type — requires `data` |
| `data` | object | No | Replacement grid, validated against the brush's (new) type |

### `delete_tilemap_brush`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |
| `name` | string | Yes | Brush name to delete |

Removing the last brush leaves the file as an empty array.

### Tilemap data

The painted cells of a placed Tilemap instance. Each cell value is `null` for an empty cell, a tile index, or `{ tile, flipX, flipY, flipDiagonal }`. Editor rotations: 90 is `flipY` plus `flipDiagonal`, 180 is `flipX` plus `flipY`, 270 is `flipX` plus `flipDiagonal`.

#### `get_tilemap_data`

Read a placed Tilemap instance's cells as `rows[y][x]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout holding the instance |
| `uid` | integer | Yes | UID of the Tilemap instance |
| `region` | object | No | `{ x, y, width, height }` cell rectangle to return; required when the tilemap has more than 10000 cells |

#### `set_tilemap_tiles`

Paint or erase individual cells, or fill a rectangle. Cells not named keep their value.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout holding the instance |
| `uid` | integer | Yes | UID of the Tilemap instance |
| `tiles` | object[] | No | `{ x, y, value }` cells to set, applied in order (at most 250000) |
| `fill` | object | No | `{ x, y, width, height, value }` rectangle filled before `tiles` is applied |

**Notes:**
- A `value` of `null` erases the cell.

#### `set_tilemap_data`

Replace all of a placed Tilemap instance's cells.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout holding the instance |
| `uid` | integer | Yes | UID of the Tilemap instance |
| `rows` | array[] | Yes | `rows[y][x]` cell values; every row the same length |
| `resizeInstance` | boolean | No | Resize the instance to columns times tile width and rows times tile height (default: `true`) |

**Notes:**
- The grid takes the size of `rows`.

---

## Runtime Bridge and Packaging Tools

These prepare a project for a live run: they inject or remove the runtime bridge script that exposes the running game as `globalThis.__c3bridge`, and copy or pack the project. The connection tools in the next section drive the running game.

### `inject_runtime_bridge`

Add the runtime bridge script `scripts/c3-runtime-bridge.js` to the project, register it in `project.c3proj` (`rootFileFolders.script.items`, with `script-info`) and import it from `scripts/main.js`. It runs on startup through `runOnStartup()` and processes bridge commands every tick, so the connection tools below, or external tools such as Playwright, a browser console or curl, can control the running game.

No parameters.

### `remove_runtime_bridge`

Remove the runtime bridge script, its registration and its import from `scripts/main.js`, after testing.

No parameters.

### `get_bridge_commands`

List the commands the runtime bridge supports, which is what `call_bridge` accepts.

No parameters.

### `generate_bridge_eval_script`

Generate a shell command, using curl or Python, that runs one bridge command in the running game over the browser's remote debugging protocol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Bridge command, for example `callFunction`, `getGlobalVar` or `getObjectState` |
| `args` | object | No | Command arguments (max 100 keys, depth 6) |

### `export_for_preview`

Pre-flight check for a preview test: reports the project's worker mode (`useWorker` should be `"dom"` so the bridge can reach `globalThis`; the tool reports it and does not change it) and, by default, injects the runtime bridge. Returns what is needed to serve and open the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `injectBridge` | boolean | No | Inject the runtime bridge (default: `true`) |

**Notes:**
- This writes to the project. Pass `injectBridge: false` when the project should stay as it is.

### `clone_project`

Copy the project folder to a new directory, for example to test on a copy, optionally with the bridge injected into the copy. The original project is not modified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `targetDir` | string | Yes | Directory to copy the project into |
| `includeBridge` | boolean | No | Include the runtime bridge in the copy (default: `true`) |

### `pack_project`

Pack the project folder into a `.c3p` archive that the Construct editor opens directly. Skips `.git`, `node_modules`, `.bak` files, `.DS_Store` and `Thumbs.db`. Returns `success`, `packed`, `outputPath`, `fileCount`, `sizeBytes`, `sizeMB` and `bridgeInjected`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `outputPath` | string | Yes | Path of the `.c3p` to write |
| `injectBridge` | boolean | No | Inject the runtime bridge before packing (default: `true`) |

**Notes:**
- With the default, packing also injects the bridge into the source project. Pass `injectBridge: false` for a package that is only inspected or load-checked.
- When the server was started on a `.c3p`, the source project is its working folder, so an injected bridge is also written back into that `.c3p` after the call, like any other change. The same holds for `export_for_preview` and `inject_runtime_bridge`.

---

## Runtime Connection Tools

These tools use the Chrome DevTools Protocol (CDP) to communicate with a
running game whose injected `globalThis.__c3bridge` is active. Start the
browser with a remote debugging port and keep the game in DOM mode.

### `connect_to_game`

Open and retain a CDP WebSocket connection. Supply either a direct page
WebSocket endpoint or discovery host/port. The tool waits for the runtime
bridge to report `ready: true` before returning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cdpEndpoint` | string | No* | Direct `ws://` or `wss://` page endpoint |
| `host` | string | No* | CDP discovery host (default: `localhost`) |
| `port` | integer | No* | CDP discovery port (default: `9222`) |
| `timeoutMs` | integer | No | Connect and bridge-ready timeout, 100 to 60000 ms (default: 10000) |
| `allowRemoteHost` | boolean | No | Allow a host other than this machine (default: `false`) |

*Use `cdpEndpoint` alone, or `host`/`port`; do not combine the two routes.

Only `localhost`, `127.x.x.x` and `::1` are accepted unless `allowRemoteHost` is
true, whether the host comes from `host` or from the `cdpEndpoint` URL: the
runtime bridge runs script in whatever page it reaches.

The result contains `connectionId`, `bridgeReady`, `gameState`, and, for a
discovered connection, the selected page target metadata.

### `call_bridge`

Submit one of the 16 commands listed by `get_bridge_commands`, poll the bridge
for its result, and return `commandId`, `result`, and `elapsedMs`. The two
coordinate commands, `layerToCssPx` and `cssPxToLayer` (`{ layer?, x, y }`),
convert between layout coordinates on a layer and CSS pixels relative to the
page viewport through the game's own transform; a game running a bridge
injected before they existed answers them with an unknown-command error, so
inject the current bridge and export again.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | UUID | Yes | ID returned by `connect_to_game` |
| `command` | enum | Yes | A command listed by `get_bridge_commands` |
| `args` | object | No | Command-specific arguments |
| `pollIntervalMs` | integer | No | Poll interval, 10 to 1000 ms (default: 50) |
| `timeoutMs` | integer | No | Command timeout, 100 to 60000 ms (default: 5000) |

### `wait_for_condition`

Poll the connected game until a global variable, object property, layout name,
or page expression matches the requested condition. The first check is
immediate. A timeout is a successful tool response with `met: false`, not a
tool error; the response always includes `elapsed_ms` and the last
`final_value` observed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | UUID | Yes | ID returned by `connect_to_game` |
| `condition` | object | Yes | One of the condition shapes below |
| `pollIntervalMs` | integer | No | Poll interval, 10 to 5000 ms (default: 100) |
| `timeoutMs` | integer | No | Wait timeout, 100 to 120000 ms (default: 30000) |

Condition shapes:

- Global variable: `{ type: "globalVar", name, operator, value }`
- Object property: `{ type: "objectProperty", objectType, property, operator, value }`
- Layout: `{ type: "layout", name }`
- Page expression: `{ type: "expression", expr, operator, value }`

Operators are `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, and `contains`.
Ordered comparisons require two numbers or two strings. `contains` supports a
string containing a string or an array containing a value. Object properties
are resolved first from the bridge's object-state result and then from its
`_instVars` object.

Expression conditions execute caller-supplied JavaScript in the connected
page through CDP. Use them only with trusted expressions and pages; they have
the same authority as code entered in that page's DevTools console.

### `simulate_input`

Send a mouse, touch, keyboard, or text action through the connected page's CDP
Input domain. The result is `{ success: true, action }` after every protocol
command for the action succeeds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | UUID | Yes | ID returned by `connect_to_game` |
| `action` | object | Yes | One of the action shapes below |
| `delayMs` | integer | No | Delay before dispatch, 0 to 60000 ms (default: 0) |
| `coordinateSpace` | string | No | `viewport` (default), `canvas` or `layout` |
| `layer` | string or integer | No | For `layout`: the layer name or index the coordinates are on (default: layer 0) |

Action shapes:

- Click: `{ type: "click", x, y, button?, clickCount? }`; `button` defaults
  to `left`, and `clickCount` is `1` or `2` with default `1`.
- Touch: `{ type: "touch", x, y, gesture, endX?, endY? }`; `gesture` is
  `tap`, `longPress`, or `swipe`, and a swipe requires both end coordinates.
- Key: `{ type: "key", key, modifiers? }`; modifiers are `Alt`, `Control`,
  `Meta`, and `Shift`.
- Text: `{ type: "type", text }`; text is inserted one Unicode character at
  a time and is limited to 1,000 characters per call.
- Mouse move: `{ type: "mouseMove", x, y }`.

With the default `viewport` space, coordinates are CSS pixels relative to the
page viewport, which is also the coordinate system used by CDP. With `canvas`,
coordinates are CSS pixels relative to the top-left corner of the page's first
`canvas` element; the tool reads the canvas bounding rectangle immediately
before dispatch, adds its offset, and rejects points beyond the canvas CSS
width or height. With `layout`, coordinates are layout coordinates on
`layer`, and every point (the start, and a swipe's end) is converted by the
game itself through the bridge's `layerToCssPx`, so scaling, letterboxing,
the canvas offset and the device pixel ratio are Construct's arithmetic;
the game must run the current bridge, and a layer the layout does not have is
an error before anything is dispatched. Long press holds for 500 ms; swipe
interpolates eight move events from the start to the end point. A swipe
without both end coordinates is rejected before any event is dispatched.

### `get_canvas_size`

Read the geometry of the connected page's first `canvas` element. Parameter:
`connectionId` (required UUID). Returns `left` and `top` (CSS pixels in the
viewport), `cssWidth` and `cssHeight`, `backingWidth` and `backingHeight`
(canvas pixel buffer), `devicePixelRatio`, and `viewportWidth` and
`viewportHeight`. The tool returns an error when the page has no canvas.

### `subscribe_events`

Start observing the running game through its bridge, so a test sees what
happened between polls instead of polling fast or missing it. Three event
types, from documented runtime state only:

| Event type | What it reports | Filter |
|------------|-----------------|--------|
| `globalVarChange` | Each change of one global variable, compared on every tick with `Object.is` | `filter.variable`, required: the global's name |
| `layoutChange` | Each change of the current layout's name | none |
| `custom` | Each call of `globalThis.__c3bridge.emit(name, data)` from the game's own script or a page evaluation | `filter.name`, optional: only that name |

There is no documented Construct interface that observes every event-sheet
signal or plugin trigger, so a generic "signal" subscription is not offered;
a game that wants a trigger observed emits a custom event where it fires.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | UUID | Yes | ID returned by `connect_to_game` |
| `eventType` | enum | Yes | `globalVarChange`, `layoutChange` or `custom` |
| `filter` | object | No* | `{ variable? , name? }` as above; *required with `variable` for `globalVarChange` |
| `bufferSize` | integer | No | Events kept per subscription, 1 to 1000 (default 100); the oldest is dropped when full |

Returns `subscription_id` (a bridge-local id such as `sub-1`) with the type,
filter and buffer size. Subscribing captures the current value as the
baseline and emits no initial event; the bridge processes queued commands
before comparing baselines on each tick, so a subscription made on one
tick starts observing on the next. Events carry `type`, `name`, `value`,
`previousValue` (global and layout changes), `timestamp` (`Date.now()`) and
`tick` (`runtime.tickCount`). The game must run the current bridge.

### `read_events`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | UUID | Yes | ID returned by `connect_to_game` |
| `subscriptionId` | string | Yes | The `subscription_id` returned by `subscribe_events` |
| `clear` | boolean | No | Empty the buffer after reading (default `true`); `false` returns a copy and keeps the events |

Returns `events`, oldest first, and `count`. An unknown subscription is an error.

### `unsubscribe_events`

Stop a subscription and release its buffer. Parameters: `connectionId` and
`subscriptionId`. Returns `subscription_id` and `unsubscribed: true`; an
unknown subscription is an error rather than a claimed cleanup.

### `screenshot_game`

Capture the connected page as an image file, so a run keeps visual evidence
of a state without an editor or a browser tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | UUID | Yes | ID returned by `connect_to_game` |
| `outputPath` | string | Yes | File to write; missing folders are created |
| `format` | enum | No | `png` (default) or `jpeg` |
| `quality` | integer | No | JPEG quality 0 to 100 |
| `canvasOnly` | boolean | No | Capture only the game canvas rectangle (default: the whole viewport) |

Returns `path`, `bytes`, `format` and, with `canvasOnly`, the `clip`
rectangle in viewport CSS pixels.

### `serve_preview`

Serve an exported Construct game over HTTP on this machine and, on request,
launch Chrome (or Edge) on it with a remote-debugging port, so a run starts,
connects to, drives and stops the game with no editor open.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | Yes | The HTML5 export folder, the one holding `index.html` |
| `port` | integer | No | HTTP port (default 0: any free port) |
| `host` | string | No | Interface to listen on (default: `localhost`) |
| `allowRemoteHost` | boolean | No | Allow an interface other than this machine (default: `false`) |
| `launchBrowser` | boolean | No | Launch the browser on the served URL (default: `false`) |
| `chromeDebuggingPort` | integer | No | Its remote-debugging port (default: 9222) |
| `chromePath` | string | No | Browser executable (default: `CHROME_PATH`, then the usual Chrome and Edge locations) |
| `headless` | boolean | No | Headless with software WebGL (default: `false`, a visible window) |
| `windowWidth`, `windowHeight` | integer | No | Window size in pixels |
| `readyTimeoutMs` | integer | No | Wait for the debugging port, 1000 to 120000 ms (default: 15000) |

Returns `serverId`, `url`, `host`, `port`, `folder`, `browser` (`pid`,
`executable`, `cdpPort`, `headless`) when one was launched, and `next`, the
call to make after this one.

- The input must be what Construct's Export > Web (HTML5) produced. A source
  project folder (`project.c3proj`) or a `.c3p` is refused: Construct exports
  only from its editor, and a source project is not a runnable game. For the
  bridge tools to work, inject the bridge (`inject_runtime_bridge`) before
  exporting.
- Files are served as they are, with `Cache-Control: no-store`, from under the
  folder only; a path that escapes it is a 404.
- The launched browser gets a fresh temporary profile and ends with the MCP
  server process or on `stop_preview`, which asks it to close over CDP and
  kills it if it does not.

### `stop_preview`

Stop a preview server and the browser it launched. Parameter: `serverId`
(the UUID `serve_preview` returned); without it, every preview server this
MCP server holds is stopped. Returns the stopped servers' details.

### `disconnect_from_game`

Close a persistent connection. Parameter: `connectionId` (required UUID).
All remaining connections are terminated, and every preview server stopped,
when the MCP transport closes or the server receives SIGINT/SIGTERM.

---

## Prompts

### `analyze_project`

Analyze project structure, naming conventions, and organization.

### `find_object_usage`

Find where a specific object is referenced. Parameter: `objectName`.

### `explain_eventsheet`

Explain how an event sheet works. Parameter: `eventSheetName`. Asks to run `find_runtime_traps` for that sheet and to check `construct3://docs/pitfalls`.

### `review_game_logic`

Review overall game logic architecture, including a `find_runtime_traps` pass and the pitfalls in `construct3://docs/pitfalls`.

### `document_object`

Generate documentation for an object. Parameter: `objectName`.

### `optimize_project`

Get optimization suggestions.

### `debug_stuck_game`

Diagnose a game that gets stuck or a feature that silently does nothing. Optional parameter: `symptom`. Embeds the current `find_runtime_traps` findings and walks through signals, script exceptions, picking and animation restarts using `construct3://docs/pitfalls`. For a script exception in the console (`<sheet>, event N, action M`) it points to `locate_event`.

---

## Error Handling

### Success Response

```json
{
  "content": [{ "type": "text", "text": "{...JSON result...}" }]
}
```

### Error Response

```json
{
  "content": [{ "type": "text", "text": "Error: message" }],
  "isError": true
}
```

### WriteResult

Mutation tools return this structure on success:

```typescript
interface WriteResult {
  success: boolean;
  entity: string;        // name of the entity
  category: string;      // "object" | "family" | "eventsheet" | "layout" | "timeline" | "project" | "addon"
  action: string;        // "created" | "updated" | "deleted" (also "delete_blocked", "would_delete", "already_registered")
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];   // e.g., "Auto-registered plugin..."
  backupFile?: string;   // path to .bak file
  editorNote?: string;   // not in the TypeScript type: toolResult adds it to every completed write
}
```

Some tools add their own fields (for example `deletedSid`, `movedSids`, `backupFiles`). Responses with `success: false` (`action: "delete_blocked"`), dry runs and no-ops carry no `editorNote`.

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `Object "X" not found` | Misspelled name | Check suggestions or use `list_objects` |
| `Object "X" already exists` | Duplicate name | Use `update_object_properties` instead |
| `Plugin "X" is not registered` | Third-party addon not in project | Add addon in C3 editor first |
| `"System" is a reserved name` | Name conflicts with C3 engine | Choose a different name |
| `Path traversal detected` | Name contains `..` or `/` | Use simple alphanumeric names |
| `Object is still referenced` | Delete blocked by references | Use `force: true` or remove references first |

---

## Type Definitions

### Key Types

```typescript
interface Addon {
  type: 'plugin' | 'behavior' | 'effect';
  id: string;
  name: string;
  author: string;
  bundled: boolean;
  version?: string;
  sdkVersion?: number;
}

interface WriteResult {
  success: boolean;
  entity: string;
  category: string;
  action: string;
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];
  backupFile?: string;
}

interface ReferenceCheckResult {
  safe: boolean;
  references: {
    eventSheets: string[];
    layouts: string[];
    families: string[];
  };
}
```

---

**Last Updated**: 2026-09-28
