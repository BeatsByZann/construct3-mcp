# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Query Tools](#query-tools)
- [Analysis Tools](#analysis-tools)
- [Mutation Tools](#mutation-tools)
- [Runtime Tools](#runtime-tools)
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

A short Markdown stub with the construct.net manual URL for the topic. The page content is not fetched; the stub asks the client to open the URL itself (construct.net blocks many automated requests).

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

### `list_timelines`

List all timeline names (root and subfolders) with a count, in project-bar order. No parameters. Transitions (the easing curves in the editor's Transitions folder, which `project.c3proj` keeps as the first-level `timelines` subfolder without a `name`) are returned separately in `transitions`. Any other subfolder without a name is malformed (reported by `validate_project`); its items are not listed, the other timeline tools report them as unresolvable, and `create_timeline` refuses their names so they are not registered twice.

### `get_timeline_details`

Full timeline JSON, including tracks and settings. The file is located from the timeline's folder in `project.c3proj`: `timelines/<name>.json` at the root, `timelines/<folder>/.../<name>.json` in a subfolder. Transitions (stored in `timelines/transitions/`) are refused: the timeline tools never read, change or delete them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |

### `list_flowcharts`

List all flowchart names (root and folders) with a count, in project-bar order. No parameters. A name registered in a folder without a name is not listed, and the other flowchart tools do not resolve it.

### `get_flowchart_details`

Full flowchart JSON: its nodes, outputs and connections. The file is located from the flowchart's folder in `project.c3proj`: `flowcharts/<name>.json` at the root, `flowcharts/<folder>/.../<name>.json` in a folder. The name must be given as registered; a name in another letter case is refused with the registered name. A file that is missing, cannot be read, is not valid JSON or holds no list of nodes is refused, with the file named project-relative.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Flowchart name |

### `list_addons`

List the addons registered in the project's `usedAddons`, with a count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` \| `"all"` | No | Filter by addon type (default: all) |

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

Function definitions and call sites across event sheets. Call sites are *Call function* actions (`via: "callFunction"`), `Functions.Name(...)` calls in the expressions of conditions and actions, function call arguments included (`via: "expression"`), and *Map function* / *Map function default* actions of the Functions object (`via: "function-map"`). A function map registration does not call the function itself; it makes it callable by *Call mapped function*. All three count in `callCount` and `totalCallSites`, and a function that has any of them is not listed in `uncalledFunctions`. Function names are matched ignoring case, as the editor does. Scripts are not scanned. Every function block is listed on its own, with its `sheet` and `params`, the names of its parameters as the editor saves them (`functionParameters`); function blocks whose names match ignoring case (which the editor refuses to create, see `duplicate-function-name` in [`validate_project`](#validate_project)) each get `sameNameAs` (the others, `{ name, sheet }`) and the same call sites, which `totalCallSites` counts once, and `summary.duplicateFunctionNames` lists such names. `totalFunctions` counts function blocks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `detail` | string | No | Detail level |

### `get_object_dependencies`

Where objects are used: event sheets, layouts, families, co-occurring objects. Event sheet uses include object parameters, expressions, script actions and System *Create object (by name)* with a literal name; layout uses include instances on sub-layers, non-world instances and object properties of other instances that hold the object's SID (see [`find_orphaned_objects`](#find_orphaned_objects)). The project-wide `orphanedObjects` list follows the same rule as `find_orphaned_objects`, and `totalReferenced` counts the other objects (use through a family included), so `totalReferenced`, `orphanedObjects`, `possiblyUsedObjects` and `unanalysedObjects` add up to `totalObjects`. `orphanedFamilyMembers` (present when there are any) lists the orphans that are members of a family, as `{ name, families }`: `delete_object` refuses them until they leave the family. An object that a container lists gets `containers` (`{ index, members, others }`), read from `project.c3proj` as it is at the call.

While registered event sheets, layouts or families could not be parsed (see [Files the server could not parse](#mutation-tools)), they are searched as text and the result carries `unscannedFiles` (`{ file, reason, textSearch }`, `textSearch` being `possible-use`, `no-match`, `unreadable` or `not-searched`). For one object, `textSearch` is about that object; project-wide, only the objects without a use the index found are searched for, so `textSearch` is about them only (`not-searched` when there are none), and used objects in `topConnected` get no `possiblyReferencedIn`. An object whose name (or, in layouts, SID) such a file holds, or every object when such a file cannot be read at all, gets `possiblyReferencedIn` (the files), which `referenceCount` does not count; project-wide, the objects without a use that such files possibly use are listed in `possiblyUsedObjects` (`{ name, files }`) instead of `orphanedObjects`. Without such files these fields are absent.

An object whose own object type file could not be parsed gets `unanalysed` (`{ file, reason, unchecked }`): its SID is unknown, so references by SID (object properties of other instances) are not counted in `referenceCount`. Project-wide, such an object without a use the index found is listed in `unanalysedObjects` (as in [`find_orphaned_objects`](#find_orphaned_objects)) instead of `orphanedObjects` and `possiblyUsedObjects`; one with a use found counts in `totalReferenced`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object` | string | No | Specific object (omit for project-wide top 20) |
| `detail` | string | No | Detail level |

### `find_orphaned_objects`

Find objects not used by any event and not placed in any layout. No parameters.

An object counts as used when it is the object of a condition or action or the object a custom action block (`custom-ace-block`) defines its custom action for (the block's conditions, actions and sub-events count like any others), or through a family it belongs to (a family that events use), or when it has an instance on a layer or sub-layer (`layers[].subLayers`, nested to any depth) or among a layout's non-world instances (`nonworld-instances`, e.g. Array or Dictionary), or when an instance property of another object holds its SID (object properties such as the Particles *Object* property, which editor-saved projects store as the object type's SID). Events also use an object when (heuristics that rather find too many uses than too few):
- a parameter's whole value is its name, as in object parameters (`"object": "Sprite2"`, `"object-to-create"`, `"pin-to"`, `"child"`, ...), function call arguments included. Not counted: keys that hold other names (`"audio-file"`, `"instance-variable"`, `"variable"`, `"layout"`), and a bare name that is also a declared event variable or function parameter, since in an expression parameter a bare name is a variable (Construct 3 lets variables share names with objects). Object parameter keys count even then;
- a parameter expression uses it as `Name.` or `Name(` (`Sprite4.X`, `Sprite4(0).X`), outside `"..."` string literals and not as a member (`Label.Text` does not use an object named `Text`). An object parameter whose value is not a plain name (an expression written by hand) is scanned the same way;
- a script action or script event reads `runtime.objects.Name` or `runtime.objects["Name"]` (also through `this.runtime` and the like);
- System *Create object (by name)* creates it with a literal name (`"object-name": "\"Bullet\""`, surrounding spaces allowed), matched ignoring case as the runtime looks it up; a family created by name counts as a use of the family, and so of its members. This is the rule [`get_asset_usage`](#get_asset_usage) follows.

Only names of existing object types and families are matched. Not detected: project script files, dynamic lookups (`runtime.objects[name]`, destructuring) and objects created by a name built at runtime (*Create object (by name)* with an expression such as `"Enemy" & Level`; [`get_asset_usage`](#get_asset_usage) reports the images of unused objects as `not-analysed` then). `validate_project`, `get_object_dependencies`, `analyze_performance` and the `delete_object` reference check use the same index: every object `delete_object` refuses because of a use is not an orphan, and every orphan is deleted without `force`, except an orphan that is a member of a family no event uses. Such orphans list that family in `families`; `delete_object` refuses them until they leave the family (`update_family` with `removeMembers`). Orphans that a container lists carry `containers`. Container membership is not a use: such an object is an orphan when nothing else uses it, and `delete_object` takes it out of its containers.

Files the index could not parse (see [Files the server could not parse](#mutation-tools)): registered event sheets, layouts and families over the size limit (10MB by default) or with invalid JSON are searched as text for the names of the objects without a use (and, in layouts, their SIDs). Such an object is listed in `possiblyUsed` (`{ name, pluginId, isGlobal, files }`) instead of `orphanedObjects`, as is every object without a use while such a file cannot be read at all; `delete_object` refuses these objects without `force` too. `count` counts `orphanedObjects` only. `unscannedFiles` lists such files as for [`get_object_dependencies`](#get_object_dependencies) project-wide (`not-searched` when no object is without a use). Both fields are absent while every file could be parsed.

An object type whose **own** file could not be parsed (over the size limit (10MB by default), not valid JSON, unreadable) has an unknown SID, so uses by its SID (object properties of other instances) cannot be looked up. When the index finds no other use of it, it is listed in `unanalysedObjects` (`{ name, file, reason, unchecked, files? }`: `file` is `objectTypes/<name>`, `unchecked` says what could not be checked, `files` the files above that possibly use it) instead of `orphanedObjects` or `possiblyUsed`: whether it is used cannot be told. `delete_object` refuses such an object without `force` for the same reason. `unanalysedObjects` is absent while every object type file could be parsed. `validate_project` (`orphaned-object`) and `analyze_performance` follow the same rules.

### `get_asset_usage`

Track asset usage across the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"sound"` \| `"music"` \| `"image"` \| `"font"` \| `"video"` \| `"icon"` \| `"general"` \| `"all"` | No | Filter by asset type (default: all) |
| `detail` | string | No | Detail level |

Returns `{ summary, assets, notes }`. `summary` has `totalAssets`, `byType`, `usedCount`, `unusedCount`, `notAnalysedCount` and `mostReferenced`. Each asset has `name`, `type`, `status` (`used`, `unused` or `not-analysed`), `referencedIn` (`eventSheets`, `layouts`, and when found `objectTypes`, `scripts`, `flowcharts`, `timelines`, `projectFiles`), `via` (how it is referenced) and, when not used, a `reason`. `standard` detail lists 50 assets, unused and not-analysed first; `full` lists all.

- **Images** are object types with animations (sprites) or a single image (Tiled Background, 9-patch, Particles, Sprite font and other plugins that save an `image`), one entry per object type. A sprite has its `animations` and `frames` counts; a single-image object type has `frames: 1` and no `animations`. Animations are read as the editor saves them (`animations.items`, and the animations in `animations.subfolders`). An image is used when its object type is used by the rule of [`find_orphaned_objects`](#find_orphaned_objects): used in an event, directly or through one of its families (System "Create object (by name)" with a literal name included); an instance in a layout, sub-layers and non-world instances included; or named by an object property of another instance.
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

The every-tick check (`info`, per event sheet) counts the event blocks that run every tick: blocks at the top level of the sheet or in groups whose conditions hold no trigger (a condition whose id starts with `on-`, as in the trigger placement rule of [`validate_project`](#validate_project)), so a block without conditions and one with only *Every tick* or a comparison both count. Not counted: sub-events (they run with their parent, and under a trigger, function or custom action only when it runs), else blocks (part of the block before them), disabled blocks, and blocks in a disabled group or a group that is not active on start. A third-party trigger whose id does not start with `on-` is counted as running every tick.

The cleanup checks count unused objects by the rule of [`find_orphaned_objects`](#find_orphaned_objects): objects possibly used in files that could not be parsed are named apart, and objects whose own object type file could not be parsed get an issue of their own instead of counting as unused. An addon is reported as unused when no object type uses its plugin; while object type files could not be parsed, their text is searched for `"plugin-id": "<id>"`, and an addon found there (or every candidate, when such a file cannot be read at all) is named as possibly used instead, in an issue of its own whose suggestion is to repair those files rather than remove the addon.

### `validate_project`

Run integrity checks over the whole project. No parameters.

Returns `{ valid, complete, summary, errors, warnings, info, unscannedFiles }`; each issue has `check`, `entity`, `message` and an optional `suggestion`.

| Field | Description |
|-------|-------------|
| `valid` | No errors **and** every registered file was checked (`complete`). A project with a file that could not be checked is never `valid`: `summary.errors === 0` with `complete: false` means "no errors in the checked files, the rest unknown" |
| `complete` | Every object type, family, event sheet and layout file that is registered in `project.c3proj` and exists on disk was read and checked. `false` when one of them was not; `valid` is then `false` too |
| `unscannedFiles` | The files (`category/name`) that exist but were not checked. No check covered their contents, so duplicate UIDs and SIDs, broken references and load-time errors in them are not reported |
| `summary` | `{ errors, warnings, info, checksRun, entitiesScanned, unscanned }`; `entitiesScanned` is the number of registered object types, event sheets and layouts (families not counted), unchecked ones included; `unscanned` is the number of `unscannedFiles` |

A file over the reader's size limit (10MB by default) is an `unscanned-file` warning: nothing in it was checked, but it is not known to be broken. A file that exists but cannot be read or parsed (invalid JSON, a folder in its place, no access) is a `file-existence` error with the reason, without the absolute project path, and is listed in `unscannedFiles` too. A registered name without a file is a `file-existence` error naming the path it is read from (`no file exists at layouts/Levels/Title.json`); it leaves `complete` true, since nothing on disk was missed.

- **Errors:** registered object types, families, event sheets and layouts whose file is missing, cannot be read or is not valid JSON (`file-existence`), missing required fields in objects, sheets and layouts, internal `name` differing from the registered name, malformed subfolder entries (a subfolder without a name or `items`; the first unnamed subfolder directly under `timelines` is the editor's Transitions folder, see [`list_timelines`](#list_timelines), and is accepted), conditions/actions that name their behavior only under the legacy `"behavior-type"` key (`legacy-behavior-key`, see [`fix_legacy_behavior_keys`](#fix_legacy_behavior_keys)), a container member in `project.c3proj` that is not an object type of the project (`container-member`; Construct 3 does not open such a project), a container with fewer than two members that are object types (`container-member`; a name listed twice counts once, and whether Construct 3 counts it that way was not checked live), and the editor load-time rules below
- **Warnings:** registered files over the reader's size limit (10MB by default; `unscanned-file`, see above), duplicate SIDs and UIDs (except the SID duplicates listed below as errors), broken object references (conditions/actions on a class that is no object type, family, `System` or the built-in Functions object, which is named by `functionsName` in `project.c3proj`, `"Functions"` by default), behaviors and instance variables that events use but their object type or family does not have (`missing-behavior-or-variable`), layer names repeated within a layout (`duplicate-layer-name`), layouts bound to missing event sheets, broken includes, plugins or behaviors missing from `usedAddons`, leftover `"behavior-type"` keys next to a valid `"behaviorType"`, event shapes that differ from what the current editor saves (`legacy-event-shape`, see [`fix_legacy_event_shapes`](#fix_legacy_event_shapes): block-level `isElse`, per-condition `isOr` and function calls with `id`/`objectClass` or keyed parameters, which older versions of this server wrote and Construct 3 never writes, and scripts stored as one string or without `language`, the shape older Construct 3 releases saved, which is harmless to convert), entity files whose name differs from the registered name only in letter case (`file-name-case-mismatch`), layout instances without an entry for a behavior of their object type or its families (`missing-behavior-entry`, one warning per layout and object type with the instance UIDs; the editor saves an entry for every behavior, see [`add_instance_to_layout`](#add_instance_to_layout), and older versions of these tools placed instances without them), hierarchy links that point at no instance of the layout or whose other side does not name the instance (`hierarchy-link`, below), Sprite animation frames without their image file (`frame-image`, below), function blocks whose names match ignoring case (`duplicate-function-name`, below), a container member that differs from an object type only in letter case (`container-member`), and the partly verified load-time rules below
- **Info:** JSON files in `objectTypes`, `eventSheets` and `layouts` (subfolders included) not registered in `project.c3proj`, leftover `.bak` files in `objectTypes`, `eventSheets`, `layouts`, `families`, `timelines` (subfolders included), directly in `images/` (where [`add_frame_to_animation`](#add_frame_to_animation) and [`delete_frame_from_animation`](#delete_frame_from_animation) keep images) and next to `project.c3proj`, orphaned objects (see [`find_orphaned_objects`](#find_orphaned_objects)), image files named like frames past an animation's last frame that no frame uses (`frame-image`, below), and image files named after no object type (`orphaned-image`, below)

`frame-image`: the editor loads a frame's image from `images/<object>-<animation>-NNN.<ext>`, all lowercase, NNN being the frame's index (3 digits) and ext `jpg` for a JPEG frame (`fileType` `"image/jpeg"`), `png` otherwise; for another `fileType`, any file with that name and a single extension counts (shown as `…-003.*`). `images/` is read once and names are compared ignoring case and Unicode normalization. A warning per animation (in any animation folder) lists the frames whose file is missing, with the name each one needs. Older versions of `add_frame_to_animation` left the frames after an insert index without their image; what Construct 3 does when a frame's image file is missing is not verified, so this is a warning. An info entry per animation lists files named like frames past its last frame that no frame of any animation uses, such as the file older versions of `delete_frame_from_animation` left behind (`.bak` files are listed as `backup-file` instead). The check is skipped when the project has no `images/` folder. Since names are compared ignoring case, a frame whose file exists only under another case (e.g. `Hero-Walk-000.PNG`) counts as having its image; that is right on Windows and macOS, but on a case-sensitive file system (Linux) the editor may not find the file, and the check does not report it.

Entity files are checked against the path each registered entity is read from: `<category>/<project-bar folders>/<name>.json`, since Construct 3 mirrors its project-bar folders on disk. `file-name-case-mismatch`: a file whose path differs from that path only in letter case, such as `layouts/Layout1.json` for a layout `layout1` at the root, is the entity's file on case-insensitive file systems (Windows, macOS by default), where it loads, but may not be found on case-sensitive ones (Linux). The suggestion is to rename it to the expected path; it is never reported as orphaned. Any other file is `orphaned-file`, including a copy named like a registered entity in another folder; its message names the path that entity is read from. The editor's `*.uistate.json` view-state files are not entity files and are skipped.

`orphaned-image`: files directly in `images/` whose name does not start with the name of an object type of the project followed by `-` (frames, `<object>-<animation>-NNN.<ext>`) or `.` (a single image, `<object>.<ext>`), compared ignoring case; registered object types whose file could not be parsed count. Such a file belongs to no object, for example an image of an object type that an older version of `delete_object` deleted (it left the images in place; it now keeps them as `.bak`). One info entry per name before the first `-` or `.`, listing the files. `.bak` files are `backup-file` entries instead, and files named after an existing object type (e.g. images of a deleted animation) are not reported. Whether anything else loads such a file by path is not checked, so check before deleting it. Skipped when the project has no `images/` folder.

`duplicate-uid`: instance UIDs (instances on layers and sub-layers, non-world instances, single-global instances) must be unique across the project; locations of sub-layer instances name the layer path (`layouts/Layout1/layer:Main/layer:HUD/inst:Sprite`). According to Scirra ([Construct-bugs #8725](https://github.com/Scirra/Construct-bugs/issues/8725)), Construct 3 tries to cope by reassigning duplicated UIDs, which can still break hierarchies, timelines and events that refer to a specific UID, so re-saving is no fix: give the duplicates new unused UIDs by hand. Duplicates usually come from merging branches; projects edited on several branches should set the "UID numbering" project property to Random.

`hierarchy-link`: the editor stores both sides of a hierarchy (scene graph) link on the world instances of a layout: the child's `sceneGraphData["parent-uid"]` and a `{ uid, flags }` entry in the parent's `sceneGraphData.children` (children can sit on another layer than their parent). Reported, one warning per link and from the side that has it, are a `"parent-uid"` or `children` entry that names no instance of the layout, a parent that does not list the child, and a child that names another parent or none. UIDs that several instances of the layout have are skipped, as instances and as link targets (which instance a link means cannot be told; `duplicate-uid` reports them). Older versions of `delete_instance_from_layout` and `delete_layer` left links to the deleted instances behind, and since a new instance can get the UID of a deleted one, such a link can point at an unrelated instance. What the editor does with these links when it opens the project is not verified, so they are warnings.

**Editor load-time rules.** The Construct 3 editor enforces these only when it opens a project, and breaking one can make the whole project fail to open. The rules come from [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT) and were checked against the Construct 3 manual, real editor-saved projects, and the error messages of the editor's project loader (release r495.2). The exception is the `container-member` row, whose two refusals were seen in a live check of release r506-2 in a guest session of the editor. Where only part of a rule could be verified, it is reported as a warning.

| Check | Severity | Rule |
|-------|----------|------|
| `expression-syntax` | error | A backslash outside a string literal, or an unterminated string literal, in any condition/action parameter (function and custom action call arguments included). C3 expressions have no escape sequences: a quote inside a string is written as two quotes (`"He said ""hi"""`), so `"{\"a\":1}"` fails with *Syntax error: Unknown character*. A backslash inside a string literal is fine. |
| `empty-expression` | error | A parameter whose value is `""` fails with *Empty expression: You must enter an expression*. Write an empty string literal as `"\"\""`. |
| `trigger-placement` | error / warning | Only one trigger per event, unless it is an OR block (`"isOrBlock": true` on the event), which may hold several. A branch holds one trigger: no trigger in a sub-event of a triggered event, of a function block or of a custom action block. Both fail with *cannot add another trigger to event branch*. Groups are transparent. A function block or custom action block standing in the branch of a trigger, of a function block or of a custom action block is the same error (it is reported on the function or custom action block), so adding a trigger condition to a block that holds one, at any depth, is refused by the tools that run the load-time gate. A trigger that is not the first condition of its event is a warning: the editor moves it to the top when it opens the project. Triggers are conditions whose id starts with `on-`; the editor counts fake triggers (*On collision*, Timer *On timer*, Gamepad buttons) as triggers too. Problems involving third-party addon triggers are warnings, since those addons do not always follow the `on-` convention. |
| `else-placement` | warning | An else block (System `else` first condition) must come after a block without a trigger, with at most comments between them, and must not hold a trigger itself. The manual: *Else can only follow normal (non-triggered) events*; every else block in editor-saved projects follows such a block, directly or after comments. A trigger after `else` would be moved before it when the editor opens the project (see `trigger-placement`), so for else blocks this rule reports it instead. Whether the editor refuses to open a project that breaks the rule is not verified. |
| `duplicate-object-name` | error | Object types and families share one name namespace that ignores case. A name listed twice in the `project.c3proj` objectTypes or families tree, two names that differ only in case, and a family named like an object type all fail with *object class name 'X' already used*. The editor also creates the built-in System object and the built-in Functions object (named by `functionsName` in `project.c3proj`, `"Functions"` without it) in the same namespace for every project, so an object type or family named like either, ignoring case, fails the same way. |
| `family-plugin-mismatch` | error / warning | Every member of a family must use the same plugin; a mixed family fails with *wrong plugin* (error). Members that agree with each other but not with the family's `plugin-id` are a warning. |
| `container-member` | error / warning | A container member in `project.c3proj` must name an existing object type: a name that is not one fails with *cannot find object type name* (error). A name that differs from an object type only in letter case is a warning, since whether the editor matches it that way was not checked. The editor refused a container with fewer than two types (*need at least 2 types in container*) on r506-2, so this server reports a container with fewer than two distinct object types as an error. Counting a name listed twice once is this server's rule; the editor's handling of a duplicate was not checked. |
| `duplicate-sid` | error / warning | Two object types or families sharing a SID fail with *object class sid already in use* (error). A SID shared by behaviors or instance variables of object type or family files is a warning: SIDs should be unique, but no load failure is on record for this clash, and the editor's loader checks only object type and family SIDs. Animation and frame SIDs repeated across object types are warnings: a Scirra example project does this and opens. SIDs shared by events, conditions, actions or layout instances are warnings: editor-saved projects contain such duplicates and open, and the editor keeps them when it saves, so re-saving does not fix them. A clash involving a function or custom action parameter is a warning that may break loading, since the loader checks function parameter SIDs. Event sheet locations name the event path and the condition/action index (e.g. `eventSheets/Sheet1 > block (sid 12) > action 0 "wait" (System)`), and an event's own location ends with its JSON path (`eventSheets/Sheet1 > block (sid 12) at events[0].children[1]`), so events sharing a SID under the same parent can be told apart. When events in one sheet share a SID, whatever else also uses it, the suggestion adds that the SID-based event tools refuse it there unless `eventPath` names one of them (see [Events that share a SID](#mutation-tools)); a SID used more than five times lists the first five locations and a count per file, and the paths of the others come from the refused tool call or [`locate_event`](#locate_event). Layout `instanceFolderItem` SIDs legitimately repeat the instance SID and are not checked. |

`broken-object-reference`: what `delete_object` and `delete_family` with `force: true` leave behind. Reported are a name that is no object type, family, `System` or the built-in Functions object, used as the object of a condition or action or as the whole value of an object parameter (`"object"`, `"object-to-create"`, `"pin-to"`, `"child"`); layout instances (on any layer or sub-layer, or non-world) of an object type that does not exist, one warning per layout and type with the instance UIDs; family members that are no object type (one warning per family); and object properties that hold the SID of no object type or family. The only object property known to hold a SID is the Particles `"object"` property (`-1` when no object is set), so only that one is checked. Not reported: uses of a deleted object or family in expressions and scripts, which are only recognised by the names of existing objects; the `force` warnings of `delete_object` and `delete_family` list them. Uses of a deleted family's instance variables and behaviors through its members are `missing-behavior-or-variable` (below). What Construct 3 does with these leftovers when it opens the project is not verified, so they are warnings.

`missing-behavior-or-variable`: what `update_object_properties`, `update_family` and `delete_family` with `force: true` leave behind. Reported are conditions and actions whose `"instance-variable"` parameter or `behaviorType` names an instance variable or behavior their object type does not have, neither itself nor through one of its families, an `"instance-variable"` parameter of the form `{ name, objectClass }` (System actions such as *Sort Z order*) whose object type does not have the variable, and `Object.Behavior.Expression` or `Self.Behavior.Expression` in parameter expressions whose middle part names no behavior of that object type or its families. A family's conditions, actions and expressions reach only the family's own instance variables and behaviors, so for a family the family itself is checked. One warning per event sheet, object and name, with the locations (`block > action:0 at events[3]`: the event path, which sibling events share, and the JSON path of the event) and the names the object has. Names are compared ignoring case. Not reported: `Object.name` or `Self.name` whose name is neither an instance variable nor a behavior, since it can be one of the plugin's expressions (`Sprite.X`), conditions and actions on an object that does not exist (`broken-object-reference`), the legacy `"behavior-type"` key (`legacy-behavior-key`), scripts and timeline tracks. What Construct 3 does with such a use when it opens the project is not verified, so these are warnings. None of the editor-saved projects checked has one.

`duplicate-function-name`: two or more function blocks anywhere in the project whose names are the same ignoring case, one warning per name with each block's sheet, JSON path and SID. The editor's Function dialog refuses such a name and renames a pasted function block, and calls resolve function names ignoring case, so a call to the name is ambiguous. The editor's loader reads function names without checking them, so this is a warning. Older versions of `add_event_to_sheet` and copies with `move_events_between_sheets` could create such duplicates; keep one and delete or rename the others.

`duplicate-layer-name`: two or more layers of one layout, sub-layers included, whose names are the same ignoring case, one warning per layout and name with the layer paths. The editor's project loader (release r495.2) looks layer names up ignoring case over all layers of a layout and cannot load such a layout; this was not reproduced in the editor, so it is a warning. [`update_layer`](#update_layer) can rename one of them: it finds a sub-layer by its path, such as `"Main > HUD"`.

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

---

## Mutation Tools

Mutation tools that write entity files through the project writer (objects, families, event sheets, layouts, animations, project metadata, addon auto-registration) follow the safety pipeline: validate -> backup -> write -> verify -> invalidate caches. The other project-file writes go through the writer's `replaceFile`, `deleteFile`, `restoreForCall` and `updateProject` methods, under the file's one lock. `replaceFile`, `deleteFile` and `updateProject` back the file up once per call; `restoreForCall` takes no backup, since it puts back what the call wrote. A write goes through a temp file, and `replaceFile`, `restoreForCall` and `updateProject` read it back and compare the bytes; `deleteFile` does no read-back (it records the file as absent). Renaming image files makes no backup; every rename of image files runs under the animation lock, and each one also takes the lock of its target file (never two at once) and checks there that no other file has the name, so a write of that name through the writer that took the lock first is never renamed over. The JSON check (`validateJsonData`) and the re-parse run only for entity files and for `project.c3proj` updates made through `updateProject`. The differences: `register_addon` / `unregister_addon` back up `project.c3proj` once per call and merge a change the editor saved during the call; the timeline and flowchart tools back up their files once per call, and the flowchart tools refuse a flowchart file that changed on disk after the call read it; the runtime tools refuse a write step whose file changed since the tool read it (the delete of the bridge script by [`remove_runtime_bridge`](#remove_runtime_bridge) takes no such check); PNG images are backed up once per call under the first free `.bak` name (image backups therefore accumulate, one more for each call that writes the image, and nothing removes them). Mutation tools return a `WriteResult` object on success.

**Text style.** An overwritten file keeps its line endings (LF or CRLF), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style: tab-indented JSON with LF line endings, no trailing newline and no BOM. Only files already in that tab layout get line-level diffs; files indented another way are re-indented in full.

**Parallel calls.** The animation tools, from [`add_animation_to_sprite`](#add_animation_to_sprite) to [`replace_sprite_image`](#replace_sprite_image), and [`replace_object_image`](#replace_object_image), run one at a time: a call waits until the one before it has finished and reads the object only then. They write an object file back (a Sprite's, or for `replace_object_image` that of the object type), and several rename or write its image files (for a Sprite the frame image files, whose names hold the frame index), so two of them in parallel could otherwise move each other's images or write the object without the other's frames. `delete_object`, which renames the object's frame images, takes the same lock around its renames, its delete and its rollback, and [`rename_object_type`](#rename_object_type), which renames them too, takes it around the whole call (`rename_family` renames no image and does not wait). Other tools that write an object file (e.g. `update_object_properties`) do not wait for them: run such a call on the same Sprite in parallel with an animation tool and one can overwrite the other's change, as for any two calls that change the same file. When [`add_frame_to_animation`](#add_frame_to_animation), [`delete_frame_from_animation`](#delete_frame_from_animation), [`reorder_frames`](#reorder_frames), [`reverse_frames`](#reverse_frames) or [`duplicate_frame`](#duplicate_frame) finds that another write replaced the object file during its own, it keeps the frames and image files together (see there). `replace_object_image` keeps its image and the object file together in the same way: if the other write kept the new image record, the new image stays and the call succeeds with a warning; if it did not, the image is put back (or removed) when the record is the one from before the call; otherwise the image stays and the error says recovery is unresolved (see there).

**Names and file names.** Entity files are named after the entity (`<category>/<folders>/<name>.json`, folders mirroring the project bar), and on Windows and macOS names that differ only in case name the same file. Create and rename tools therefore compare names the way the Construct 3 editor does: event sheet and layout names project-wide ignoring case, object type and family names in one namespace ignoring case, layer names per layout ignoring case (sub-layers included; the editor cannot load a layout with two such layers), animation names per sprite ignoring case (in any animation folder), event variable names ignoring case within the variable's scope (see [Event variable names](#event-variable-names)), and sibling project-bar folders (`subfolder` segments) ignoring case; a case-only clash is refused with an error naming the existing entity or folder. Create tools also refuse to write an entity JSON file, a timeline file or a flowchart file where one already exists, including one whose name differs only in case; nothing is backed up or replaced, and the error says to choose another name or, for a leftover of a deleted entity, to check and remove the file first. Placeholder PNGs are not refused: `create_object` and `add_animation_to_sprite` write them over an image file of the same name in `images/`, e.g. one a deleted animation left behind, but first keep that image as `<file>.bak` (`<file>.1.bak`, ... when taken), so nothing is replaced without a backup (`delete_object` keeps the images of the object it deletes the same way; `add_frame_to_animation` renames such a file first). Rewrites of an existing file keep its name on disk exactly, including case, and the `.bak` backup takes that name. The event sheet tools that check a sheet together with the other event sheets (`add_event_to_sheet`, `delete_event_sheet`, `delete_event_from_sheet`, `update_event_variable`, `move_events_between_sheets`, `update_function`, `rename_event_sheet`) take a sheet name only as the project registers it: a name that differs only in letter case is refused as not found, with the registered name in the error, also on Windows and macOS, where the file would open (`rename_event_sheet` words it *is named "X" in the project. Use name "X".*). Their checks know the other sheets by their registered names, so they would see that sheet twice, once as saved; a move whose target was its source spelled in another case lost the moved events.

**Editor reload note.** Every response that reports a completed write includes `editorNote`: *"If this project is open in Construct 3, close and reopen it there before saving, or the editor can overwrite these changes."* The editor keeps an open project in memory, so saving from a session opened before the edit can overwrite it; its Project Bar reload (F9) re-reads script files only. A `WriteResult` with `success: true` counts as a write unless it is a dry run. Tools whose success does not imply a write carry no note: the `already_registered` no-op of `register_addon`, `fix_legacy_behavior_keys` with `dryRun: false` when it found nothing to rename, `fix_legacy_event_shapes` with `dryRun: false` when it found nothing to convert, `clone_project`, and `export_for_preview` / `pack_project` with `injectBridge: false`. Error responses never carry the note, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

**Files the server could not parse.** The reference checks work from the cross-reference index, which holds only the files the reader could parse. A registered layout, event sheet or family file over the size limit (10MB by default), not valid JSON or unreadable is left out (`validate_project` lists it in `unscannedFiles`). The checks of `delete_object`, `delete_family`, `delete_layout`, `delete_event_sheet`, `delete_event_from_sheet`, `move_events_between_sheets`, `update_event_variable` (for a rename), `update_object_properties`, `update_family`, `update_function`, `rename_object_type`, `rename_family`, `rename_event_sheet` and `rename_layout` therefore search such files as text for the names they look for (the tool sections say which): whole words ignoring case (`Enemy` matches `"Enemy"`, `Enemy.X`, `enemy(0)` and `runtime.objects.Enemy`, not `EnemyBullet`), as JSON writes them inside a string, and whole numbers for SIDs. Names outside ASCII are also searched as `\u` escapes (Python's `json.dump` writes them so), a `\uXXXX` escape next to a name counts as the character it stands for, and a file with a UTF-16LE byte order mark is read as UTF-16LE; a file in another encoding (UTF-16BE, NUL characters) cannot be searched. The file is streamed without a size limit (about 0.1 seconds for 50MB while the names are rare in the text, up to about 0.3 seconds when a name is common inside other words, and about 2 seconds in a constructed worst case of 200 very common short names) and only while there are such files. Each searched file is listed in `unscannedFiles` as `{ file, reason, textSearch, names?, searchedFor?, unchecked? }`: `file` is `category/name` as in `validate_project`, `reason` is `over the 10MB size limit` (the megabytes of the setting in effect), `not valid JSON` or `could not be read`, and `textSearch` is:
- `possible-use`: the text holds what the check looks for (`names` lists what it found). This is a possible use, not a confirmed one: the search cannot tell a use from the same name in another string (a comment, a text property). It refuses like a use (`delete_blocked` / `move_blocked` / `update_blocked` / `rename_blocked`, message *There are possible uses in files that could not be parsed: ...*); with `force=true` the tool goes ahead and names the files in a warning, without changing them;
- `unreadable`: the file exists but cannot be read even as text (a folder in its place, no read access). It refuses the same way, since uses in it cannot be ruled out;
- `no-match`: nothing found. The tool goes ahead as before and warns that the file was only searched as text, and for what (`searchedFor`);
- `not-searched`: the file was not searched. With `unchecked`, it is the own file of what `delete_object`, `delete_family` or `delete_event_sheet` deletes: its SID (and a family's members, instance variables and behaviors) or, for an event sheet, the functions and global variables it defines are unknown, so `unchecked` says what could not be checked, and it refuses the same way (message *Its own file could not be parsed: ...*). In `get_object_dependencies` and `find_orphaned_objects` it means that no object was left to search the file for.
A registered name whose file does not exist (also one deleted since the index was built) holds no uses: it is not listed and does not block. Names built at runtime, and ASCII letters a file writes with `\u` escapes, are not found.

An object type whose own file could not be parsed still counts as a member of its families: `delete_family` and `update_family` find uses of the family's instance variables and behaviors through it in parsed event sheets (its own names are unknown, and `validate_project` does not report uses of them as missing). `update_object_properties`, `update_family` and `delete_family` update the behavior entries of instances in the layouts they can parse; layouts they could not parse are searched for the object types concerned, and a warning names those that possibly hold such instances (left unchanged) or cannot be read (listed in `unscannedFiles`), as well as a member whose object type file could not be parsed.

**Events that share a SID.** Event SIDs are not guaranteed to be unique: editor-saved sheets can contain two events with the same SID, and they open in the editor. The tools that find an event by SID (`delete_event_from_sheet`, `update_event_block`, `update_event_block_action`, `update_event_variable`, `update_function`, and `move_events_between_sheets` for top-level events) refuse a SID that matches more than one event in the sheet, dry runs included, and write nothing. The error lists the matches in document order (the first 20, then a count of the rest): each one's JSON path (e.g. `events[3].children[1]`, the format [`locate_event`](#locate_event) returns), editor event number, enclosing group and function or parent event, and a one-line summary. Pass the path of the event you mean as `eventPath` (`eventPaths` for `move_events_between_sheets`) to act on it; the path must point at an event with that SID, or the call is refused. A unique SID works without `eventPath`, as before. The results of the single-event tools, apart from `update_function`, include the `eventPath` of the event they acted on. [`validate_project`](#validate_project) reports such SIDs as `duplicate-sid` warnings that name the same paths.

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
3. Generates SID (+ UID for global plugins, + animation SID for Sprite). The UID follows the same rules as in [`add_instance_to_layout`](#add_instance_to_layout): files over the size limit (10MB by default) count, and a layout or object type that exists but cannot be read refuses the global plugin. The UID is generated before step 2, so such a refusal writes nothing, `usedAddons` included
4. Builds from plugin-specific template
5. Writes `objectTypes/<name>.json`
6. Adds name to `project.c3proj` objectTypes container

### `update_object_properties`

Update an existing object's instance variables and behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Existing object name, as registered: a name that differs only in letter case is refused as not found, naming the registered one |
| `isGlobal` | boolean | No | Change global status |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |
| `force` | boolean | No | Remove instance variables and behaviors even if events use them (default: false) |

**Removing what events use:** before anything is changed, the instance variables and behaviors to remove are checked against the events. A use is the `"instance-variable"` parameter or the `behaviorType` of a condition or action on the object, an `"instance-variable"` parameter that names the object itself as `{ "name": "hp", "objectClass": "Sprite" }` (the shape editor-saved System actions such as *Sort Z order* use, next to `"object": "Sprite"`), `Object.name`, `Object(0).name` or `Object.Behavior.Expression` in any parameter expression (function call arguments included), and `Self.name` or `Self.Behavior.Expression` in a parameter expression of a condition or action on the object. All these names are matched ignoring case: editor-saved projects spell object, instance variable and expression names in expressions in other case and open, and the `"instance-variable"` parameter and `behaviorType` are compared the same way, so a use that differs from the name only in letter case blocks the removal too (and `validate_project` does not report it). `Object.name` counts only when `name` is an instance variable or behavior of the object, since anything else there is one of the plugin's expressions (`Sprite.X`). A use that a family of the object still resolves after the removal (a family instance variable or behavior of the same name) does not count.
- If used and `force=false`: nothing is changed (`success: false`, `action: "update_blocked"`), also none of the other changes the call asks for. `message` sums up the uses; `references` holds `eventSheets` (names) and `uses` (`{ eventSheet, path, eventPath, sid, objectClass, kind, name, context, form }`), capped at 50 entries with `usesNotListed` counting the rest. `path` is the event path with the condition or action index (`block > action:0`), which sibling events share; `eventPath` is the JSON path of the event (`events[3].children[1]`), as [`locate_event`](#locate_event) returns it and the SID-based event tools take it; `sid` is the condition's or action's SID, when it has one. `kind` is `instance variable` or `behavior`, `context` is `condition`, `action` or `expression`, `form` is `instance-variable`, `behaviorType`, `legacy-behavior-type`, `behavior-expression` or `member-expression`
- If used and `force=true`: removes them with a warning that names the uses (they are NOT changed). [`validate_project`](#validate_project) then reports them as `missing-behavior-or-variable` (a behavior named under the legacy `"behavior-type"` key as `legacy-behavior-key`), except the uses written as `Object.name` or `Self.name` in expressions (form `member-expression`), which it cannot tell apart from the plugin's own expressions: a second warning lists those (`"Sheet1" block > action:0 at events[3]`)
- Event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched for each removed name together with the object's name: a sheet whose text holds both, or that cannot be read at all, refuses without `force` as well (`unscannedFiles`)
- Scripts (script actions, script blocks and project script files) are not checked, since which object's instances they read cannot be told, and never block a removal. When a script reads a removed instance variable or behavior by name (`instVars.hp`, `instVars["hp"]`, `behaviors.Fade`, compared with their letter case, as in JavaScript) and the object no longer has one of that name, the result warns and says where, so the scripts can be reviewed
- Not checked: timeline tracks

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)
- Updates the object's layout instances (all layers, sub-layers and `nonworld-instances`): each gets a default entry for an added behavior (see [`add_instance_to_layout`](#add_instance_to_layout)) and loses the entry of a removed one; existing entries keep their values and their order (a new entry goes next to the entries it follows in the editor's order)
- Keeps the instances' instance variable values in step, as the editor saves them: each instance gets the default value of an added variable (`0`, `""` or `false` by its type) and loses the value of a removed one, unless a family of the object still has a variable of that name; existing values keep their value and order. A warning names the removed values other than the default and the removed effect entries (layout, UID, name and value, the first ten), since only the layout's `.bak` keeps them, until the layout is written again.
- On any behavior or instance variable change, an instance that has no entry for another behavior of the object or its families, or no value for another of their instance variables (older versions of these tools placed instances without them), gets a default entry or value too, and a warning names them and counts the instances

### `delete_object`

Delete an object type from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references in event sheets, layouts, and families (what counts as a reference: see [`find_orphaned_objects`](#find_orphaned_objects); project script files are not scanned): uses in events, instances on any layer or sub-layer and non-world instances, object properties of other instances that hold its SID, and membership in any family
- If referenced and `force=false`: blocks (`action: "delete_blocked"`) and lists where the object is used. `message` sums it up; `references` holds `eventSheets`, `layouts` and `families` (names), `events` (`{ eventSheet, path, context }` with `context` `condition`, `action`, `parameter`, `expression`, `script`, `custom-action` or `create-by-name`), `instances` (`{ layout, layer, instances }` per layout and layer, `layer` being a path such as `"Main > HUD"` for a sub-layer and absent for non-world instances) and `instanceProperties` (`{ layout, layer, objectType, uid, property }`). Each list is capped at 50 entries; `eventsNotListed`, `instancesNotListed` and `instancePropertiesNotListed` count the rest
- If referenced and `force=true`: deletes with a warning that names the remaining uses (references NOT cleaned up). [`validate_project`](#validate_project) then reports the dangling instances, object parameters, family memberships and Particles object properties as `broken-object-reference`, but not the uses in expressions, scripts and *Create object (by name)*: a second warning lists those
- Event sheets, layouts and families that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched for the object's name, and layouts also for its SID (object properties): a match, or such a file that cannot be read at all, blocks as well, with `unscannedFiles` next to `references`
- Refuses when the JSON file changed on disk since it was read; then removes the name from `project.c3proj` and deletes the file (kept as `.bak`). When either step fails, the call is undone; when `project.c3proj` was saved again meanwhile and cannot be put back, the error says what is on disk: if it no longer lists the name, the file is left on disk unregistered. If `project.c3proj` lists the name again after the file was deleted, the call is an error
- `delete_object` also takes the object type out of every container in `project.c3proj` that lists it (ignoring case), in the same update of `project.c3proj` that removes its registration. Construct 3 does not open a project whose container lists a missing object type. The update is built from the file as it is right before the write, so a save in the editor during the call is merged, not lost. The result lists the changed containers in `containersUpdated` (`{ index, members }`, members after the change; `index` is the position before the call). A container left with fewer than two members is removed and listed in `containersRemoved` (members before the change). A failure of the update rolls the call back (#ISSUE).
- Keeps the object's image files as `<file>.bak` (`<file>.1.bak`, … when that name is taken), as `delete_frame_from_animation` keeps the image of a deleted frame: every frame image of every animation (animation folders included), `images/<object>-<animation>-NNN.<ext>` with the extension of the frame's `fileType`, or the single image `images/<object>.<ext>` of a Tiled Background, 9-patch and other plugins that save one `image`; names are compared ignoring case and Unicode normalization. A warning names them. A file that another object type's frames also use (the same name) is left in place, as is one named after an object type whose file could not be parsed. The image files are renamed first; if `project.c3proj` cannot be updated or the object file cannot be deleted, the call is undone and the images are renamed back, but only when the undo left `project.c3proj` listing the object and its file on disk. When the object is gone from `project.c3proj` but its file is still on disk, or the object file was deleted and `project.c3proj` lists the name again, the images stay as `.bak` and the error names them, since images under their live names with no object would be overwritten without a backup by a later `create_object` or `add_animation_to_sprite` (the error names any file that could not be put back; an object file or `project.c3proj` saved again in the editor meanwhile is left as it is, see [Error Response](#error-response)). When the object's own file could not be parsed (deleted with `force`), its images are unknown and left as they are, with a warning

### `rename_object_type`

Rename an object type and update what names it (#ISSUE).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current object type name, as registered (letter case included) |
| `newName` | string | Yes | New object type name: letters, digits and underscores, starting with a letter or underscore, with no space (expressions name the object as `Name.X`); not a name an object type or family has (ignoring case), `System` or the name of the built-in Functions object |
| `dryRun` | boolean | No | Report the references and files the rename would change, and write nothing (default: false) |
| `force` | boolean | No | Rename even when event sheets, layouts or families that could not be parsed possibly name the object type, or a timeline could not be read (whatever it names; they are NOT updated). Default: false |

The rename updates what names the object type, matching names ignoring case as the editor compares object type names (in Construct 3 r506-2, Free edition, renaming an object type in the Project Bar changed the condition and action objects, the object parameters, the object of an instance variable parameter, the expressions, the family members, the container entry and the layout instances, also on a sub-layer, together with its image file names, and left the strings and script lines that held the name):
- **Event sheets**: the object of conditions and actions (`objectClass`); the owner of custom action blocks; a parameter whose whole value is the name exactly as registered, where the reference index counts it as the object (the `object`, `object-to-create`, `pin-to` and `child` parameters always; `layout`, `audio-file`, `instance-variable` and `variable` never; any other parameter and the arguments of a call unless an event variable or function parameter has the name, in which case it is listed); the `objectClass` of an object-valued `instance-variable` parameter (`{ name, objectClass }`, as System *Sort Z order* saves it); and expressions that use it as an object (`Name.X`, `Name(0).X`) under every parameter, `layout`, `audio-file`, `instance-variable` and `variable` included: a layout, sound, event variable or instance variable name cannot hold a dot, so `Name.X` there is an expression (in r506-2 the editor rewrote `Alpha.X & ""` in the layout parameter of System *Go to layout (by name)*, and a project that still named the old object type there did not open). A name that starts with a digit is found in expressions too; a name made only of digits is not matched in expressions, since `12.5` is a number, and `12.x`, `12(0).x` and a whole value equal to it are listed. Where the editor's own rename changes the `child`, `parent`, `obstacle` and `array` parameters was not observed; they are found in editor-saved projects and rewritten by the rule above.
- **Layouts**: the `type` of its instances on every layer and sub-layer and among the non-world instances (where the editor's own rename changes the non-world instances was not observed).
- **Its own file**: the `type` of its single-global instance, when that names it (not observed in the editor).
- **Families** that list it as a member.
- **`project.c3proj`**: its entry in the project bar gets the new name and keeps its folder and its position. The containers that list it (ignoring case) get the new name in the same write of `project.c3proj` as its entry.
- **Timelines**: no editor save checked holds a timeline track, so where a track names its object type has not been checked against the editor. A timeline that holds the name as a value is listed in `possibleReferences` (`kind` `timeline track`, `in` the timeline file) and named in a warning, and is never changed. The tracks of the other timelines are searched only for such a value, and a warning names those timelines, since a track of this object type may be missed.
- **Images**: its frame image files (`<name>-<animation>-NNN.<ext>`, or `<name>.<ext>` for a single image, in lower case as the editor names them) are renamed with it (`imageRenames`); the editor renamed them the same way. The rename is refused, changing nothing, when one of these files is also another object type's file, when one is named after an object type whose file could not be parsed (that object type may use it), or when a file at a new name exists.
- **Tilemap brush**: a brush file named after the object type (`tilemapBrushes/objectTypes/<folders>/<name>.brush.json`) is moved with it to `<new name>.brush.json` in the folder it is in (`brushMoved`). It is found by name anywhere below `tilemapBrushes/`, the object type's own folder first; the search goes at most 8 folders deep and reads at most 20,000 entries, and a warning says so when it stops at either limit, since a brush file may have been missed. The rename is refused when two folders hold one, when a brush file at the new name exists with other content, or when one exists and the object type has none of its own; a Tilemap object type with no brush file gets `brushFileFound: false` and a warning. In the editor-saved projects checked (an r495.2 editor-saved project and three editor-saved archives), 3 brush files are named after an object type, all of them Tilemap object types; whether the editor renames a brush file with its object type was not observed.
- **The file** is written as `<new name>.json` in the same folder, with its `"name"` changed and its SID kept; the old file is deleted and kept as `.bak` (`backupFile`).
- **The editor's view state**: the entry of the object type in `objecttypes.uistate.json`, when the file has one, gets the new name in the file's own text style (`viewStateMoved`). In Construct 3 r506-2, Free edition, the file held no entry for the object type, so what the editor does with an entry was not observed. It holds view settings only, so it is changed last and a failure is a warning: a file that names the object type but cannot be read as a list of entries is left as it is.

Other places may name the object type or something else of that name, so they are never changed. A warning lists them and `possibleReferences` holds each one: a string literal (System *Create object (by name)*; `kind` `string literal`), a script line of an event (`script`), a line of a project script file that reads it as `runtime.objects.Name` (`script`, `in` the script's path; a script file that cannot be read is named in a warning), a bare name or `Name(...)` without a member in an expression, a parameter whose key is the name, a whole parameter value that differs from the name only in letter case, and for a name made only of digits its `Name.x` and `Name(...).x` uses and a whole value equal to it (`possible expression`), the initial value of an event variable or function parameter that is the name (`variable value`), the `c` value of a flowchart node that is the name (`flowchart node`; a flowchart file that cannot be read or parsed is named in a warning), and the timelines above.

Refused, changing nothing (the message ends "Nothing was changed."): an object type that is not registered or is given in another letter case than registered (the error gives the registered name); an object type whose own file does not exist or could not be parsed (in the second case, rename it in the Construct 3 editor); a `newName` that is not a valid name, has a space or starts or ends with one, is the object type's own name, differs from it only in letter case (on Windows and macOS both names are the same file: rename it to another name first), is the name of another object type or of a family ignoring case, is `System` or is the name of the built-in Functions object; a file for the new name that exists in the object type's folder and is not one a stopped rename of this object type left (below); and the image and brush cases above. The editor does not refuse a name with a space or with `.`, `-` or `$` typed in the Project Bar: in Construct 3 r506-2, Free edition, it removed those characters, so the tool refuses such a name and its message gives the form the editor would produce.

Event sheets, layouts and families that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched as text for the object type's name: a match, or such a file that cannot be read at all, refuses the rename (`"success": false`, `"action": "rename_blocked"`, `message`, `references` and `unscannedFiles`; nothing changed). So does any timeline file that cannot be read or parsed, or that holds more than 200,000 values (it is not searched to the end), whatever it names: the call cannot tell what such a file holds. With `force: true` it goes ahead, and a warning names those files, which are NOT updated.

The event sheets, layouts and families that name the object type are written first, then the object type under its new name, then `project.c3proj` (its entry and the containers in one write), then the image files are renamed, then the brush file is moved, then the old file is deleted (the last write the rollback covers), then the view state is changed. When a write fails, what the call wrote is put back (the image files are renamed back and the brush file is restored); a file another write changed after the call wrote it (a save in the editor) is left as it is and named with its `.bak`, and a new file whose own write could not be confirmed is left and named. When a file the call is about to write changed on disk during the call, the write is refused, the file keeps that change, and what the call wrote before is put back. Messages name every file by its path in the project. The call runs one at a time with the animation tools (`rename_animation`, `add_frame_to_animation`, ...), since it renames frame image files.

Running the same call again finishes a rename that stopped midway (the server process ended): a file for the new name that holds the object type's SID and the new name, and is not registered, is written over; and when the project registers the new name already while the old file itself is still there with the same SID, the call does what is left (renames the image files and moves the brush file that still have the old name, deletes the old file, changes the view state; when the brush file was moved already but the old one is still there, it deletes the old brush file and reports it as `brushFileDeleted`, leaving it out of `filesWritten`) and says so with `"stoppedRun": true` and a warning. The old file is deleted as the last write, so a finished rename leaves only its `.bak`: the same call after a finished rename answers that the object type is not found and changes nothing.

Returns `{ success, entity (the new name), category: "object", action: "renamed", previousName, references, possibleReferences?, imageRenames?, filesWritten, fileDeleted, backupFile?, brushMoved?, brushFileDeleted?, brushFileFound?, viewStateMoved?, stoppedRun?, warnings?, unscannedFiles? }`. `references` has one entry per place that was updated: `in` (the file, project-relative, e.g. `eventSheets/Menu.json`, `layouts/Level 1.json`, `project.c3proj`), `kind` (`objectClass`, `custom action owner`, `object parameter`, `instance-variable object`, `expression`, `instance type`, `family member`, `single-global instance type` or `container member`), `path` (the event's JSON path, or `containers[n]` for a container), `ace`, `parameter`, `uid` (a layout instance) and `value` (the name as saved); `imageRenames` and `brushMoved` list `{ from, to }`; `filesWritten` lists project-relative paths. `possibleReferences` has the same fields, with `kind` `possible expression`, `string literal`, `script`, `variable value`, `flowchart node` or `timeline track`. With `dryRun: true` nothing is written: `action: "would_rename"`, `newName`, `references`, `possibleReferences?`, `imageRenames?`, `filesToWrite`, `fileToDelete`, `brushFileToDelete?`, `stoppedRun?`, and the same warnings worded as what would happen.

### `rename_family`

Rename a family and update what names it (#ISSUE).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current family name, as registered (letter case included) |
| `newName` | string | Yes | New family name: letters, digits and underscores, starting with a letter or underscore, with no space (expressions name the family as `Name.X`); not a name an object type or family has (ignoring case), `System` or the name of the built-in Functions object |
| `dryRun` | boolean | No | Report the references and files the rename would change, and write nothing (default: false) |
| `force` | boolean | No | Rename even when event sheets that could not be parsed possibly name the family (they are NOT updated). Default: false |

The rename updates what names the family, matching names ignoring case as the editor compares family names (in Construct 3 r506-2, Free edition, renaming a family in the Project Bar changed the condition and action objects, the owner of a custom action block, the family of a custom action call and the expressions that held the name):
- **Event sheets**: the object of conditions and actions (`objectClass`); the owner of custom action blocks; the family of a custom action call (`customActionObjectClass`); a parameter whose whole value is the name exactly as registered, the `objectClass` of an object-valued `instance-variable` parameter and expressions that use it as an object (`Fam.X`, `Fam(0).X`), under the rules of [`rename_object_type`](#rename_object_type).
- **`project.c3proj`**: its entry in the project bar gets the new name and keeps its folder and its position.
- **The file** is written as `<new name>.json` in the same folder, with its `"name"` changed, its SID and its members kept; the old file is deleted and kept as `.bak` (`backupFile`).

No layout, container, object type file, image or view state file is changed (a family has no instances or images of its own). Strings, script lines, project script file lines, flowchart nodes, variable values and the other names that may name the family are listed in `possibleReferences` and in a warning, never changed, as for `rename_object_type`.

Refused, changing nothing (the message ends "Nothing was changed."): a family that is not registered or is given in another letter case than registered (the error gives the registered name); a family whose own file does not exist or could not be parsed (in the second case, rename it in the Construct 3 editor); a `newName` that is not a valid name, has a space or starts or ends with one, is the family's own name, differs from it only in letter case, is the name of another family or of an object type ignoring case, is `System` or is the name of the built-in Functions object; a file for the new name that exists in the family's folder and is not one a stopped rename of this family left.

Event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched as text for the family's name: a match, or such a sheet that cannot be read at all, refuses the rename (`"success": false`, `"action": "rename_blocked"`, `message`, `references` and `unscannedFiles`; nothing changed). With `force: true` it goes ahead, and a warning names those sheets, which are NOT updated. Layouts and families that could not be parsed do not refuse it, since neither names a family.

The event sheets that name the family are written first, then the family under its new name, then `project.c3proj`, then the old file is deleted (the last write the rollback covers). When a write fails, what the call wrote is put back; a file another write changed after the call wrote it (a save in the editor) is left as it is and named with its `.bak`, and a new file whose own write could not be confirmed is left and named. Messages name every file by its path in the project. Unlike `rename_object_type` it renames no image file, so it does not wait for the animation tools.

Running the same call again finishes a rename that stopped midway (the server process ended): a file for the new name that holds the family's SID and the new name, and is not registered, is written over; and when the project registers the new name already while the old file itself is still there with the same SID, the call deletes the old file and says so with `"stoppedRun": true` and a warning. The old file is deleted as the last write, so the same call after a finished rename answers that the family is not found and changes nothing.

Returns `{ success, entity (the new name), category: "family", action: "renamed", previousName, references, possibleReferences?, filesWritten, fileDeleted, backupFile?, stoppedRun?, warnings?, unscannedFiles? }`. `references` and `possibleReferences` are as for `rename_object_type`; the kinds of `references` are `objectClass`, `custom action owner`, `custom action family`, `object parameter`, `instance-variable object` and `expression`. With `dryRun: true` nothing is written: `action: "would_rename"`, `newName`, `references`, `possibleReferences?`, `filesToWrite`, `fileToDelete`, `stoppedRun?`, and the same warnings worded as what would happen.

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

Add or remove family members and shared instance variables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name, as registered: a name that differs only in letter case is refused as not found, naming the registered one |
| `addMembers` | string[] | No | Object names to add |
| `removeMembers` | string[] | No | Object names to remove |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `force` | boolean | No | Remove instance variables and members even if events use them (default: false) |

At least one parameter besides `name` must be provided. Duplicates and missing entries are skipped with a warning.

**Removing what events use:** before anything is changed, the removal is checked against the events, with the uses and matching rules of [`update_object_properties`](#update_object_properties). A family's conditions, actions and expressions (`Family.name`, `Self.name` on the family) reach only its own instance variables and behaviors; a member object type reaches its own and those of all its families.
- `removeVariables`: uses on the family itself, and uses through a member that gets the variable from this family only (not one it declares itself or also gets from another family)
- `removeMembers`: uses through a leaving member of the family's instance variables and behaviors that it gets from this family only, and of the family's effects (as for [`delete_family`](#delete_family); listed as `references.effectUses`, `{ eventSheet, eventPath, ace, sid, member, effect }`). Whether events that use the family itself rely on the member being in it (they no longer pick or affect its instances) cannot be checked: removing a member while events use the family succeeds with a warning that counts those uses
- If used and `force=false`: nothing is changed (`success: false`, `action: "update_blocked"`, `references` as for `update_object_properties`, where `objectClass` is the family or the member the use goes through). With `force=true` the change goes ahead with the same warnings as in `update_object_properties`
- Event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)): for `removeVariables`, a sheet whose text holds a removed name together with the family's or a member's name; for `removeMembers`, one whose text holds one of the family's instance variables or behaviors together with a leaving member's name. Such a sheet, or one that cannot be read at all, blocks as well (`unscannedFiles`)
- Scripts: as in `update_object_properties`, a warning when scripts read by name an instance variable or behavior that a member loses (a removed variable, or for a leaving member each of the family's instance variables and behaviors that it does not declare itself or get from another family)

The layout instances of the members follow the change: members that join get default entries for the family's behaviors and the default value of each of its instance variables; members that leave lose them and the entries for the family's effects, unless the member still has a behavior, variable or effect of that name itself or through another family; the other members get the default value of an added variable and lose the value of a removed one. Entries and values these instances lack for the other behaviors and instance variables of their object and its families are added too, as in [`update_object_properties`](#update_object_properties). Effect entries of a joining member are not added: the default parameter values of effects are not known (Construct 3 is expected to add them when it opens the project; not verified). A warning names the removed values other than the default and the removed effect entries (layout, UID, name and value, the first ten), since only the layout's `.bak` keeps them, until the layout is written again.

**Load-time check:** a member change that makes the family mix plugins is refused and nothing is written (`family-plugin-mismatch`, *wrong plugin*). A mix that was already there does not block other updates, and removing the odd member is allowed.

### `update_instance_variable`

Rename an instance variable of an object type or family, or change its type or description, and keep the values placed instances hold for it in step (#ISSUE). Give exactly one of `objectName` and `familyName`, as registered, and the variable's name with its letter case.

- **Rename** (`newName`): every placed instance of the object type, or of each member of the family, keeps its value under the new name, in the same place among its values. The new name must not match another instance variable those instances hold a value for (their own, or a family's), ignoring case, since events match these names ignoring case. A rename that events use is refused without `force`, with the uses listed, by the same rules as removing the variable with [`update_object_properties`](#update_object_properties) (the `"instance-variable"` parameter, `Object.name`, `Self.name`, ...), and event sheets that could not be parsed are searched as text for the old name and the object type, family or a member: a match, or a sheet that cannot be read at all, refuses too. Uses are never rewritten; with `force: true` they keep naming the old name (`validate_project` reports them as `missing-behavior-or-variable`, except `Name.member` in expressions). A rename that changes only the letter case breaks no event use (events match names ignoring case) and is not refused; scripts read instance variables by name with their case (`instVars.hp`), so a warning lists the scripts that read the old spelling. The check covers events and scripts only: timelines, flowcharts and files the server cannot list are not searched.
- **Type** (`newType`): a value that does not fit the new type gets the type's default (0, `""` or `false`); the values other than the default it replaced are listed in a warning ("Replaced ..."), and only the layouts' `.bak` files hold them. Events that use the variable are listed in a warning; whether they work with the new type is not checked.
- **Description** (`description`): saved as `desc`; no layout is written.

Layouts the server could not parse (over the 10MB read limit, not valid JSON) are not updated: `unscannedFiles` lists every layout the server could not parse when the call writes layouts, and a warning names those whose text holds the name of an object type updated here, and those that cannot be read at all, since their instances may still hold the old values.

A call that changes nothing (the same name, type and description) returns `action: "unchanged"` and writes nothing. Writes each layout with instances to update first, and the object type or family file last, so a call stopped between them leaves the definition under its old name and running it again finishes the values; when a write fails, the files the call wrote are put back, except one another write changed since, which is named with its `.bak`. This is a rollback of the failed call, not an undo a user can run later; a process that stops mid-call rolls nothing back: restore from their `.bak` only the layouts that already hold the new name, or run the call again. Returns `{ success, entity, category: "object" | "family", action: "updated", variable, previousName?, type, warnings?, backupFile, unscannedFiles? }`; a refusal for uses returns `{ success: false, action: "update_blocked", message, references, unscannedFiles? }`.

### `reorder_behaviors`

Put the behaviors of an object type or family in a new order (#ISSUE): `order` lists every behavior once, with its exact name; an owner whose behaviors share a name is refused. On placed instances (of the object type, or of each member of the family), the entries of these behaviors are put in the new order among the places they hold, since each owner's entries are saved in its behavior order (Scirra's example projects: 13,461 of 13,461 instances of objects with behaviors carry an entry for each one); entries of other families and for other names stay where they are, since how the editor orders several families' entries is not verified. An instance holds one entry per behavior name: when another owner has a behavior of the same name (the object's own and a family's, say), that one entry moves with this owner's order. The layouts are written first and the owner file last; a failure rolls back what the call wrote, and a process that stops mid-call rolls nothing back (run the call again). Returns `{ success, entity, category, action: "updated", order, backupFile, warnings?, unscannedFiles? }`; the order it has already returns `action: "unchanged"` and writes nothing.

### `delete_family`

Delete a family. The member object types are kept. The layout instances of its members lose the entries for the family's behaviors and effects and the values of its instance variables (unless the member still has one of that name itself or through another family), and get the entries and values they lack for their other behaviors and instance variables (see [`update_object_properties`](#update_object_properties)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references first. Uses of the family's name count as for [`delete_object`](#delete_object): the family as the object of a condition or action or of a custom action, in object parameters, expressions and script actions (`runtime.objects.Family`), and object properties of instances that hold its SID. Uses through a member count too: the `"instance-variable"` parameter or the `behaviorType` of a condition or action whose object is a member, an `"instance-variable"` parameter `{ name, objectClass }` that names a member (System *Sort Z order*), `Member.name`, `Member(0).name` or `Member.Behavior.Expression` in a parameter expression, and `Self.name` or `Self.Behavior.Expression` in a parameter expression of a condition or action whose object is a member, where `name` is an instance variable or behavior the member gets from this family only (not one it declares itself or also gets from another family). Names are matched ignoring case, as in [`update_object_properties`](#update_object_properties). A family's effects count as used through a member when a condition or action on the member names one in its `"effect"` parameter (Set effect enabled, Set effect parameter), which the editor saves as a quoted name (`"effect": "\"AdjustHSL\""`, checked on Scirra's example projects, where actions on a member name its family's effect this way), matched ignoring case, and the member has no effect of that name itself or through another family. System conditions and actions name layer and layout effects and do not count. An effect parameter that is another expression than a quoted name cannot be checked and gets a warning. Not detected: project script files and script access to instance variables and behaviors of member instances (`instVars`, `behaviors`)
- If referenced and `force=false`: blocks (`action: "delete_blocked"`) and lists where the family is used. `message` sums it up; `references` holds `eventSheets` and `layouts` (names), `events` and `instanceProperties` (as for `delete_object`), `effectUses` (`{ eventSheet, eventPath, ace, sid, member, effect }`, only when there are any) and `memberUses` (`{ eventSheet, path, eventPath, sid, member, kind, name, context }`, `eventPath` and `sid` as for the `uses` of [`update_object_properties`](#update_object_properties), `kind` being `instance variable` or `behavior` and `context` `condition`, `action` or `expression`). Each list is capped at 50 entries; `eventsNotListed`, `instancePropertiesNotListed` and `memberUsesNotListed` count the rest
- If referenced and `force=true`: deletes with a warning that names the remaining uses (references NOT cleaned up). [`validate_project`](#validate_project) then reports the conditions, actions and object parameters that name the family and the Particles object properties that hold its SID as `broken-object-reference`, and the uses through members as `missing-behavior-or-variable`, but not the uses of the family's name in expressions and scripts, nor the uses through members written as `Member.name` or `Self.name` in expressions: a second warning lists those
- Event sheets and layouts that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched for the family's name, layouts also for its SID, and event sheets for its instance variables, behaviors and effects together with a member's name: a match, or such a file that cannot be read at all, blocks as well (`unscannedFiles`)
- Member instances in layouts lose the values of the family's instance variables and the entries for its behaviors and effects; entries and values they lack for their other behaviors and instance variables are added. A warning names the removed values other than the default and the removed effect entries (layout, UID, name and value, the first ten), since only the layout's `.bak` keeps them, until the layout is written again.
- Refuses when the JSON file changed on disk since it was read; then removes the name from `project.c3proj` and deletes the file (kept as `.bak`). When either step fails, the call is undone; when `project.c3proj` was saved again meanwhile and cannot be put back, the error says what is on disk: if it no longer lists the name, the file is left on disk unregistered. If `project.c3proj` lists the name again after the file was deleted, the call is an error

### `list_containers`

List the containers of `project.c3proj`, in the order of their `containers` list. A container makes object types be created, picked and destroyed together. It has no name, so each container is identified by its `index` (its position in the list) and its `members`. Read-only.

**Returns:** `{ containers: [{ index, members, notObjectTypes? }], count }`. `notObjectTypes` is listed when a member is no object type of the project: Construct 3 r506-2 does not open a project with such a member. A member that differs from an object type only in letter case is listed too, because the tools refuse it; whether Construct 3 accepts it was not checked. [`validate_project`](#validate_project) reports both (the `container-member` row of its load-time rules).

### `create_container`

Create a container of two or more object types in `project.c3proj`, appended to its `containers` list, so the object types are created, picked and destroyed together. The object types themselves are not changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `members` | string[] | Yes | Object type names to group, 2 to 100, spelled as registered and listed once (e.g. `["Player", "PlayerHitbox"]`) |

**Behavior:**
- Every member must be an object type of the project. Refused, and nothing is written: a name that is no object type; a name that differs from an object type only in letter case (names are matched with their letter case, so the registered spelling is named); a name listed twice (ignoring letter case); and a family (a container holds object types).
- The container needs two or more distinct object types. Construct 3 r506-2 refuses to open a project with a container of fewer than two object types, or one that names a missing object type; these are the `container-member` rules of [`validate_project`](#validate_project).
- A member that another container already lists is refused, naming that container's index and members. Construct 3 r506-2 refuses to open a project in which an object type is in two containers (it reports "already in a container"), so the tools keep each object type in one container. A hand edit can still put one there; the update tools then refuse it (see [`update_container`](#update_container)).
- A refusal says "Nothing was changed." and leaves `project.c3proj` as it was. The checks run before the write, and again on the file as it is just before the write; a refusal found in that second check, after a save made during the call, can leave a `project.c3proj.bak` from an earlier round of the same call behind (see [`update_container`](#update_container)).
- Backs up `project.c3proj` to `project.c3proj.bak`. When the write fails, the error says what is on disk: `project.c3proj` is put back unless another write changed it since, and the error then names it with its `.bak`.

**Returns:** `{ success, entity: "containers/<index>", category: "container", action: "created", index, members, backupFile }`.

### `update_container`

Add object types to a container, or take some out. The container is found by one of its members (ignoring letter case). Give `index` when the member is in several containers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `member` | string | Yes | An object type in the container to change |
| `index` | integer | No | Index of the container (from [`list_containers`](#list_containers)); needed when `member` is in several containers |
| `addMembers` | string[] | No | Object type names to add (up to 100) |
| `removeMembers` | string[] | No | Object type names to take out (up to 100) |

**Behavior:**
- A `member` that several containers list is refused, and the error names each container's index and members ("give index to pick one"). With `index`, the container at that position must list `member`, else the call is refused: the containers may have changed during the call. Each update round looks the container up again in the file it reads, so an editor save that reorders the containers during the call never edits another one.
- A name in both `addMembers` and `removeMembers` is refused.
- A name already in the container (to add) or not in it (to remove) gives a warning in `warnings` and is skipped.
- The result is checked with the rules of [`create_container`](#create_container), except that the container itself is not counted as "another container" for the one-container rule: every member is an object type spelled as registered, listed once, not a family, and no other container lists it. Added members are appended after the existing ones; the others keep their order.
- A container left with fewer than two object types is refused, and the error names [`delete_container`](#delete_container).
- When nothing changes, the result is `action: "unchanged"`, nothing is written, and there is no `backupFile`. This also happens when a save of `project.c3proj` in the editor during the call already holds the change: `project.c3proj` stays as saved, and a `project.c3proj.bak` from an earlier round of the same call can remain.
- A save of `project.c3proj` in the editor during the call is merged, not replaced: the update runs again on the saved file. A save that makes the change invalid (for example one that puts the object type in another container) is refused inside the update, before the write, and says "Nothing was changed." A `project.c3proj.bak` from an earlier round of the same call can remain in that case; `project.c3proj` itself is unchanged.
- Backs up `project.c3proj` to `project.c3proj.bak` when it changes. When the write fails, the error says what is on disk, as for [`create_container`](#create_container).

**Returns:** `{ success, entity: "containers/<index>", category: "container", action: "updated" | "unchanged", index, members, warnings?, backupFile? }`. `index` is the container's position in the file the update wrote, which can differ from the one given when an editor save inserted a container before it during the call.

### `delete_container`

Delete the container that lists a member (found ignoring letter case). Give `index` when the member is in several containers, as for [`update_container`](#update_container). The object types stay. When the last container is deleted, `containers` stays as `[]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `member` | string | Yes | An object type in the container to delete |
| `index` | integer | No | Index of the container (from [`list_containers`](#list_containers)); needed when `member` is in several containers |

**Behavior:**
- A `member` that no container lists is refused ("Use list_containers to see the containers"); several containers listing it are refused unless `index` picks one, as for `update_container`. Nothing is written in either case. A refusal found in a later round of the update, after a save of `project.c3proj` during the call, leaves a `project.c3proj.bak` from the earlier round, and `project.c3proj` is unchanged.
- Backs up `project.c3proj` to `project.c3proj.bak`. When the write fails, the error says what is on disk, as for `create_container`.

**Returns:** `{ success, entity: "containers/<index>", category: "container", action: "deleted", index, members, backupFile }`, where `members` are the container's members before the deletion.

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
| `sheetName` | string | Yes | Target event sheet, as registered (letter case included) |
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` \| `"script"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name (checked, see [Function names](#function-names)) |
| `functionParams` | array | For functions | `[{ name, type }]` (names checked, see below) |
| `functionReturnType` | enum | No | For functions: `"none"` \| `"number"` \| `"string"` \| `"any"`, the editor's *Return type* (default: `"none"`). The function sets its value with the Functions *Set return value* action |
| `functionIsAsync` | boolean | No | For functions: the editor's *Asynchronous* option, so a call can be waited for with *Wait for previous actions to complete* (default: false) |
| `functionCopyPicked` | boolean | No | For functions: the editor's *Copy picked* option, which passes the instances picked where the function is called into the function (default: false) |
| `variableName` | string | For variables | Variable name (checked, see below) |
| `variableType` | enum | For variables | `"number"` \| `"string"` \| `"boolean"` |
| `initialValue` | string | For variables | Initial value |
| `variableComment`, `variableIsStatic`, `variableIsConstant` | string, boolean, boolean | No | For variables: the declaration comment and the editor's *Static* and *Constant* options |
| `includeSheet` | string | For includes | Sheet to include (validated) |
| `commentText` | string | For comments | Comment text |
| `commentTextColor` | number[] | No | For comments: the text colour, written as `"text-color"`: `[red, green, blue, alpha]`, each 0-1, as the editor saves it |
| `commentBackgroundColor` | number[] | No | For comments: the background colour, written as `"background-color"` in the same form |
| `script` | string \| string[] | For scripts | JavaScript, split into lines |
| `groupPath` | string | No | Into a group by title path |
| `parentSid` / `parentEventPath` | number / string | No | Among the sub-events of this group, block or function block; the path picks one of several events that share the SID |
| `siblingSid` / `siblingEventPath` | number / string | No | Beside this event; needs `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` (default) \| `"before"` \| `"after"` |

Runs the same load-time gate as `add_event_block` before writing. Unknown top-level arguments are refused and nothing is written. A top-level `sid` is refused here, unlike `add_event_block`, which ignores it. Keys inside a `functionParams` entry other than `name` and `type` (such as the `sid` of an entry copied from a sheet) are still dropped, as before. A step that fails after the event is placed in memory and before anything is written is refused with a message that begins "The change was stopped before anything was written" and ends "Nothing was changed."; a failed write keeps its own message.

Returns `generatedSid` (the SID of a new group, function or variable; includes and comments have none), `functionParameterSids` (for a function with parameters: `[{ name, sid }]` in parameter order), `eventPath` (the new event's path, e.g. `"events[3]"`, which the SID-based tools accept as `eventPath`) and `backupFile`.

**Where events go:** the destination arguments place an event at the top level, in a group (`groupPath`), among the sub-events of an event (`parentSid`) or beside one (`siblingSid`). Each kind of event is placed only where this table says. Editor-backed cells are listed with their evidence below the table.

| Kind | Top level | Group | Block | Function block | Custom action block |
|------|-----------|-------|-------|----------------|---------------------|
| Block | yes | yes | yes | yes | no |
| Comment | yes | yes | yes | no | no |
| Script | yes | yes | yes | yes | no |
| Variable | yes | yes | yes | yes | no |
| Group | yes | yes | yes | no | no |
| Function block | yes | yes | yes (not under a block with a trigger) | no | no |
| Custom action block | yes | yes (only with groups above it) | no | no | no |
| Include | yes | no | no | no | no |

- A custom action block is not a destination: its sub-events accept no kind of event, so the last column is all no, and a parent given as a custom action block is refused.
- A function block in a group: Construct 3 r506-2 (Free edition) opened and kept one.
- A function block in a block with no trigger: r506-2 opened and kept one under an ordinary block. A function block under a block with a trigger is refused, as below.
- A variable in a group: an r495.2 editor-saved project has 2 such variables.
- A variable in a block: an r495.2 editor-saved project has 1, and r506-2 opened and kept one under a block with a trigger and one under a block without.
- A variable in a function block: r506-2 opened and kept one.
- A group in a block: r506-2 opened and kept one under a block with a trigger and one under a block without.
- A group in a group: r506-2 opened and kept a group nested in another group.
- A script at the top level, in a group and in a function block: r506-2 opened and kept each.
- A comment in a group: an r495.2 editor-saved project has 16.
- A custom action block at the top level and in a top-level group: r506-2 opened and kept each. A group below a block, a function block or a custom action block was not tried: the tools refuse a custom action block (and a group or block that holds one) unless only groups stand above it, which is their own rule, since the load-time check treats a custom action block as a trigger root.
- A block in a function block: no editor-saved project on record and no editor case covers it; it is not verified in the editor.
- A function block under a block with a trigger (for example an *On start* block) is refused: Construct 3 r506-2 (Free edition) refused to open a project with a function block there: the editor showed "Failed to open project" and logged "cannot add another trigger to event branch". The other arrangements of a function block under a trigger, a function block or a custom action block follow upstream's load-time check, which counts a function block and a custom action block as a trigger; they were not tried in the editor.
- The other "no" cells have no editor case on record; the table refuses them, and they were not tried in the editor.

Everything else is refused, with the places that kind of event can go. Includes are placed only at the top level.

A global variable's *Static* option (`variableIsStatic`) is written as given: r506-2 opened and kept `isStatic: true` on a global variable.

#### Event variable names

A variable added at the top level of a sheet is a global variable; in a group, a block or a function block it is a local variable. The variable's name, the names in `functionParams` and a new name given to `update_event_variable` are refused where the Construct 3 editor's event variable and function parameter dialogs refuse them (checked against the editor code of releases r449 and r495.2, which agree; both dialogs run the same checks):

- **In use in the scope, ignoring case.** A global variable's name must differ from every event variable (global, local, static) and function parameter in every event sheet of the project. A local variable's name must differ from every global variable, from the variables and parameters of each event enclosing it, and from every variable and parameter below its parent event; locals in other branches or other sheets do not count. A function parameter has the scope of a local variable declared directly in its function: for a new function, its name must differ from every global variable and from the function's other parameters, while parameters of other functions and locals elsewhere do not count. Changing only the case of a variable's own name is allowed.
- **A System expression name, ignoring case** — e.g. `time`, `dt`, `random`, `max`, `LayoutName` (all 136 System expressions of r495.2, deprecated ones included). Five of them (`ColorToHexString`, `distance3d`, `HexColor`, `ProjectFileCount`, `ProjectFileNameAt`) are not in r449, whose editor accepts these names; they are refused anyway, since the r495.2 editor refuses them, and the error says so.
- **Characters the editor removes** — whitespace, the characters `. , " ( ) ? : \ / ; * | ' - ! ¬ £ $ % ^ & + = < > { } [ ] @ # ~`, the backtick, the soft hyphen, the ideographic full stop `。`, the full-width forms `， （ ） ？ ：` of `, ( ) ? :` and the typographic double quotes `“ ”`, a leading underscore, or a name of digits only. Other full-width forms, such as `．` and `／`, are accepted, as in the editor.

Names of object types and families are not compared: the editor accepts an event variable named like an object. Event sheet files that are not registered in `project.c3proj` are not read, as the editor does not load them. The other sheets are read from disk for each check, so sheets saved outside the server count as well.

`move_events_between_sheets` applies the scope rule to the variables and parameters it copies or moves, in their new place: see [`move_events_between_sheets`](#move_events_between_sheets).

#### Function names

`functionName` is refused where the editor's Function dialog refuses it (editor code of releases r449 and r495.2, which agree):

- **In use, ignoring case.** A function name must differ from the name of every other function block in the project, in any sheet and group: `DoIt` next to `DoIt` or `doit` is refused. The editor looks functions up ignoring case, so a call could not tell them apart.
- **A System expression name, ignoring case** — e.g. `random`, `max`, `lerp`. The editor reserves the System expressions it treats as built-in functions; its code names them by a set of ids that could not be read out, so this check refuses every System expression name (the list of [Event variable names](#event-variable-names)), which may be more than the editor refuses.
- **Characters, with a return type only.** A function with a return type (`number`, `string`, `any`) is used in expressions (`Functions.Name(...)`), so its name follows the character rules of event variable names (no whitespace, no punctuation such as `-` `.` `:`, no leading underscore, not only digits). A function without one (`none`, the default) may have such a name, as in the editor: `Do It` and `a.b` are accepted.

Names of object types and families are not compared (the editor accepts a function named like an object). The editor renames a pasted function block whose name is in use; `move_events_between_sheets` refuses to copy a function block instead (see there). Event sheets that could not be parsed are not searched for function names. `validate_project` reports function blocks that share a name (`duplicate-function-name`).

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events (blocks, comments and scripts), events without conditions, else and else-if blocks, OR blocks, function calls, script actions, comment rows, and disabling single conditions and actions. Everything is written in the shapes the Construct 3 editor saves (see **Written shapes** below). Arguments and keys the tool does not know are refused, never dropped (see **Unknown keys** below).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | `"block"` | No | Optional; only `"block"` is accepted. Any other value (e.g. `"comment"`) is refused: comments, groups, variables, functions and includes are added with `add_event_to_sheet`, and a comment or script can also be a sub-event in `children`. |
| `sid` | number | No | Ignored: a block copied from `get_eventsheet_details` may carry its SID, but the new block always gets a new one. |
| `conditions` | array | No | Conditions (default: `[]`). Each: `{ id, objectClass, behaviorType?, parameters?, isInverted?, disabled? }`. AND-combined, or OR-combined in an OR block. `[]` makes an event without conditions: at the top level (or in a group) it runs every tick, as a sub-event whenever its parent runs. |
| `actions` | array | No | Actions (default: `[]`). Plugin/behavior/System action: `{ id, objectClass, behaviorType?, parameters?, disabled?, breakpoint? }`. Function call: `{ callFunction, parameters?: [...], disabled? }`. Script: `{ type: "script", script, language?, disabled? }`. Comment row: `{ type: "comment", text, "text-color"?, "background-color"? }`. Custom action call: `{ customAction, objectClass, customActionObjectClass?, parameters?: [...], disabled? }` (see **Calling a custom action** under [`add_custom_action`](#add_custom_action)) |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`). Segments are split at `>`. A segment first matches a group title exactly as typed, one space on each side of `>` counting as part of the separator (`"HUD "` and `"Parent > HUD "` name the title `"HUD "`, `"HUD"` and `"Parent > HUD"` the title `"HUD"`), so each of two sibling groups titled `"HUD"` and `"HUD "` can be reached. The editor also saves titles with leading or trailing whitespace, so a segment without such a match then matches the one group whose trimmed title equals the trimmed segment (`"HUD"` finds a lone `"HUD "`). When several do (e.g. `"HUD"` next to `"HUD "` and `" HUD"`), the call is refused with the candidate titles. |
| `parentSid` / `parentEventPath` | number / string | No | Among the sub-events of this group, block or function block; the path picks one of several events that share the SID |
| `siblingSid` / `siblingEventPath` | number / string | No | Beside this event; needs `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` (default) \| `"before"` \| `"after"` |
| `disabled` | boolean | No | Create the block disabled (default: false) |
| `isElse` | boolean | No | Make it an else block (default: false): a System `else` condition is written first. Conditions given in `conditions` follow it and make an else-if. |
| `isOrBlock` | boolean | No | Make it an OR block: the event runs when any of its conditions is true (Construct 3 *Make 'Or' block*). An OR block may hold several triggers. |
| `children` | array | No | Sub-events nested inside this block (recursive), each one of: a block `{ eventType?: "block", conditions?, actions?, disabled?, isElse?, isOrBlock?, children? }`, a comment `{ eventType: "comment", text, "text-color"?, "background-color"? }` or a script `{ eventType: "script", script, language?, disabled? }`. Other event types are refused (see **Sub-events** below). |

A block goes where the placement rules of `add_event_to_sheet` allow a block (see **Where events go** there); the warning for `Set return value` (`set-function-return-value`) outside a function block is checked against its destination (inside a function block, at any depth, it gives none).

Returns `generatedSid` (the SID of the new block), `eventPath` (its path, e.g. `"events[3].children[1]"`, which the SID-based tools accept as `eventPath`), `warnings` when there are any, and `backupFile`. A step that fails after the block is placed in memory and before anything is written is refused with a message that begins "The change was stopped before anything was written" and ends "Nothing was changed."; a failed write keeps its own message.

**Condition fields:**
- `behaviorType` — For behavior conditions/actions: the behavior's *name* as defined on the object type or one of its families (e.g. `"Platform"`, `"8Direction"` — not the behaviorId `"EightDir"`). Omit for plugin and System ACEs. Written to the event sheet as `"behaviorType"`, the key Construct 3 reads.
- `"behavior-type"` — **Deprecated** alias for `behaviorType`, still accepted and written as `behaviorType` (with a warning). Passing both with different values is an error.
- `isInverted` — Negate the condition.
- `disabled` — Disable an individual condition.
- `isOr` — **Deprecated**, never written: Construct 3 ORs a whole event, never single conditions. When every condition after the first carries `isOr: true`, the block is written as an OR block (`isOrBlock`), with a warning. `isOr` on the first condition only has no effect and is dropped. `isOr` on only some of the later conditions is refused, since one event cannot express it: use `isOrBlock`, or move the alternatives into sub-events.

**Action fields:**
- `behaviorType` / deprecated `"behavior-type"` — same as for conditions.
- `disabled` — Disable an individual action (the action exists but won't run).
- `breakpoint` — A debugger breakpoint on a plugin/behavior/System action, as the editor saves it; written only when `true`.
- Comment rows — `text`, plus the optional colours `"text-color"` and `"background-color"`, each `[red, green, blue, alpha]` with values from 0 to 1 as the editor saves them. Other colour forms (e.g. `"#ffcc00"`) are refused.
- Function calls — `callFunction` names an event function, `parameters` is the argument list in the order of the function's parameters: expressions as strings (`"1"`, `"\"text\""`, `"Player.X"`; numbers are written as strings), `true`/`false` for boolean parameters. The older form `{ id, objectClass, callFunction, parameters: { ... } }` is still accepted: its `id`, `objectClass`, `behaviorType` and `"behavior-type"` are dropped with a warning, also next to positional parameters, and parameters keyed `"0"`, `"1"`, … or by the function's parameter names become the positional array (with a warning); other keys are refused. A `breakpoint` on a function call is refused in either form, since no editor-saved function call on record has one. A call to a function that no event sheet defines, a different number of arguments than the function has parameters, and a boolean parameter given an expression (or the reverse) are warnings. A name that differs from the function's only in case is written with the function's spelling, as editor saves always spell calls, with a warning.
- Script actions — `script` is an array of lines, as the editor saves it, or one string that is split into lines. `language` is `"javascript"` (the default and only value).
- The built-in Functions object: the editor saves *Set return value* and the function map actions on it, not on System: `{ "id": "set-function-return-value", "objectClass": "Functions", "parameters": { "value": "..." } }`, and likewise `map-function`, `map-function-default` and `call-mapped-function`. Its name is `functionsName` in `project.c3proj` (`"Functions"` in every project on record). Conditions, other action ids and `behaviorType` on it, and these actions given on `System`, are written with a warning, since no editor save on record has them. *Set return value* outside a function block gets a warning too: it sets the return value of the function its event runs in, so the check looks at where the block is placed (see the paragraph after the parameter table of `add_event_block`). The `function` parameter of `map-function` / `map-function-default` names an event function: a name that differs from the function's only in case is written with the function's spelling (editor saves pick it from a list), with a warning, and a name no function block has gets a warning, since the editor's loader throws *cannot find function* for it. The same applies when `update_event_block` or `update_event_block_action` changes the parameters of a function map.

**Sub-events (`children`):**
- A child is a block, a comment or a script — the kinds of sub-events editor-saved sheets hold under blocks — told apart by `eventType`. A block may leave `eventType` out.
- A block child is a full block event with its own conditions, actions, and children.
- A comment child `{ eventType: "comment", text, "text-color"?, "background-color"? }` and a script child `{ eventType: "script", script, language?, disabled? }` are written as the editor saves them (see **Written shapes**). Like script actions, `script` is an array of lines or one string that is split into lines, and `language` is `"javascript"`.
- Other event types are refused with an error that names the sub-event's path, and nothing is written: event variables, groups, function blocks and includes cannot be added as sub-events with this tool, and an unknown `eventType` is refused too. Groups, functions and includes are added with `add_event_to_sheet`. An event variable inside an event is a local variable, which this tool does not add; `add_event_to_sheet` adds one at the top level (a global variable) or, with its destination arguments, in a group, a block or a function block (a local variable).
- Children without conditions are normal sub-events: they run whenever their parent runs.
- Children with `isElse: true` are else (or else-if) branches of the sub-event before them. An else block needs a block without a trigger before it, with at most comments between (manual: *Else can only follow normal (non-triggered) events*), so an else block that is the first sub-event (comments aside), is inserted with no block before it, follows a triggered block or holds a trigger itself gets an `else-placement` warning from the load-time gate. To branch inside a trigger, put a block with the condition and then the else block as sub-events of the triggered event.
- With `isElse: true` (or a System `else` first condition), a further System `else` condition in `conditions` is a duplicate and is dropped, with a warning.
- Max nesting depth: 10 levels. Max total events (parent + all descendants, comments and scripts included): 200.

**Unknown keys.** Conditions, actions and sub-events accept only the keys listed here (and the entries of `update_event_block` only theirs). Any other key is refused with an error that names it and its path, and nothing is written — it would otherwise be dropped with its content (a mistyped `params`, a comment's `text` on a child without `eventType: "comment"`). The one exception is `sid`, which conditions, actions and sub-events copied from `get_eventsheet_details` carry: it is ignored, since everything written gets a new SID. The arguments of `add_event_block` and `update_event_block` are checked the same way: an argument the tool does not take (a mistyped `actons`, `subEvents` for `children`, `children` on `update_event_block`) is refused, and nothing is written. `add_event_block` ignores a `sid` argument, as on a block copied from `get_eventsheet_details`, and refuses an `eventType` other than `"block"`.

**Written shapes.** These match editor-saved projects (Construct 3 r449):
- Blocks: `eventType, conditions, actions, sid, disabled?, children?, isOrBlock?`. `children` is left out when there are none, and false flags are not written.
- Else: the System condition `{ "id": "else", "objectClass": "System", "sid" }` at index 0. There is no block-level `isElse` key.
- Conditions: `id, objectClass, sid, disabled?, behaviorType?, parameters?, isInverted?`; `isInverted` comes last, after `parameters`, in every inverted condition the editor wrote in the projects on record. Actions: `id, objectClass, sid, disabled?, breakpoint?, behaviorType?, parameters?`.
- Function calls: `{ "callFunction", "sid", "disabled"?, "parameters"?: [...] }` without `id`/`objectClass`.
- Script actions: `{ "type": "script", "language": "javascript", "script": [lines], "disabled"? }`. Comment rows: `{ "type": "comment", "text", "text-color"?, "background-color"? }`. Neither has a SID.
- Comment sub-events: `{ "eventType": "comment", "text", "text-color"?, "background-color"? }`. Script sub-events: `{ "eventType": "script", "language": "javascript", "script": [lines], "disabled"? }`. Neither has a SID.

**Validation:**
- `objectClass` is hard-validated against project objects, families, `"System"` and the built-in Functions object — across the entire tree (parent + all descendants)
- `behaviorType` is soft-validated (warning only, never blocks the write): it must name a behavior on the object type or on a family the object belongs to (for a family `objectClass`: on the family). The warning lists the available behavior names and hints when a behaviorId was passed instead of the name. When the object type or a family file cannot be read, the warning says the behavior could not be verified instead.
- `id` (ACE identifier) is **not** validated — Claude knows the hundreds of C3 ACE IDs
- Script actions, comment rows, function calls and comment/script sub-events skip objectClass validation; script actions, comment rows and comment/script sub-events get no SID

**Load-time gate:** before writing, the sheet is checked against the editor load-time rules `expression-syntax`, `empty-expression`, `trigger-placement` and `else-placement` (see [`validate_project`](#validate_project)). The check covers the whole sheet, so the new block's position counts, and it compares the sheet before and after the change. A new error blocks the write with an explanation and nothing is written. New warnings are returned in `warnings`. Problems that were already in the sheet do not block the write, unless the change makes one of them worse (a warning that becomes an error); fixing part of an existing problem is allowed. The same gate runs in `add_event_to_sheet`, `update_event_block` and `update_event_block_action`. `move_events_between_sheets` runs it over the source and target sheets together: moving an event that already breaks a rule (`deleteSource: true`) is allowed, while copying it is refused, since the copy adds the problem to a second sheet.

Two triggers in one AND block are rejected. For "Space OR Up pressed", make it an OR block (`isOrBlock: true`) or add one event per trigger.

**What it does:**
1. Reads the target event sheet
2. Validates all `objectClass` references across the entire event tree
3. Recursively generates SIDs for each block, condition, action and function call
4. Builds conditions and actions in the editor's shapes and key order (see **Written shapes**)
5. Recursively builds child sub-events (blocks, comments, scripts), else branches and OR blocks
6. If `groupPath`: resolves nested group path (error with the groups at the level that did not match, titles quoted so outer whitespace shows)
7. Inserts at position (`start`/`end`)
8. Runs the load-time gate (blocks on new errors)
9. Writes sheet back with backup

### `delete_event_sheet`

Delete an event sheet from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references: sheets that include this one, layouts bound to it, and uses in other event sheets of the functions and global variables the sheet defines (its function blocks, also in groups, and the variables at its top level). The uses are those [`delete_event_from_sheet`](#delete_event_from_sheet) checks, with the same scope rules: *Call function* actions, function map registrations and `Functions.Name(...)` calls (listed in `references.callers`), and the System conditions/actions on a variable and expressions that use it by name (`references.variableReferences`). A use that another sheet's function or global of the same name still resolves does not count, uses inside the deleted sheet do not count, and local variables (in groups, blocks and function blocks) are not visible to other sheets. Scripts are not scanned.
- Event sheets and layouts that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched for the sheet's name, and event sheets also for the names of its functions and global variables: a match, or such a file that cannot be read at all, blocks as well (`unscannedFiles`). When the sheet to delete could not be parsed itself, the functions and globals it defines are unknown, so the delete is refused too (`textSearch: "not-searched"` with what was `unchecked`). The check for uses of its functions and globals stops at its traversal limit, 100,000 events (sub-events included) across all event sheets, which only very large projects reach; the delete is then refused without `force` too, since the uses beyond the limit are unknown (a sheet that defines neither needs no such check), and with `force` a warning says so.
- If referenced and `force=false`: returns the reference list (`references`: `includedBy`, `boundLayouts`, and `callers` / `variableReferences` when there are any) and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up); the uses of its functions and global variables left behind are listed in `references` and named in a warning, since the editor's loader throws *invalid function name*, *cannot find function* or *cannot find event variable* for them (see [`delete_event_from_sheet`](#delete_event_from_sheet))
- Refuses when the JSON file changed on disk since it was read; then removes the name from `project.c3proj` and deletes the file (kept as `.bak`). When either step fails, the call is undone; when `project.c3proj` was saved again meanwhile and cannot be put back, the error says what is on disk: if it no longer lists the name, the file is left on disk unregistered. If `project.c3proj` lists the name again after the file was deleted, the call is an error

### `rename_event_sheet`

Rename an event sheet and update what names it (#ISSUE).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current event sheet name, as registered (letter case included) |
| `newName` | string | Yes | New event sheet name (the rules of [`create_event_sheet`](#create_event_sheet)) |
| `dryRun` | boolean | No | Report the references the rename would update and the files it would write, and write nothing (default: false) |
| `force` | boolean | No | Rename even when event sheets or layouts that could not be parsed possibly name the sheet (they are NOT updated). Default: false |

The rename updates what names the sheet, matching names ignoring case as the editor compares sheet names (in Construct 3 r506-2, Free edition, renaming a sheet in the Project Bar changed the same references):
- **Include events** in event sheets (`includeSheet`, at any depth, for example inside a group) get the new name.
- **Layouts** whose `eventSheet` binding is the sheet are bound to the new name.
- **`project.c3proj`**: the sheet's entry in the project bar gets the new name and keeps its folder and its position.
- **The file** is written as `<new name>.json` in the same folder, with its `"name"` changed and its SID kept; the old file is deleted and kept as `.bak` (`backupFile`).
- **The editor's view state** of the sheet, `<name>.uistate.json` beside its file, is moved to the new name (`viewStateMoved`), with the `"name"` it holds set to the new name. It holds view settings only, so it is moved last and a failure is a warning: a file whose new name holds other content is left as it is, and a warning says when the `"name"` it holds could not be changed.

Refused, changing nothing (the message ends "Nothing was changed."): a sheet that is not registered or is given in another letter case than registered (the error gives the registered name); a sheet whose own file does not exist or could not be parsed (rename it in the Construct 3 editor); a `newName` that is not a valid name, starts or ends with a space, is the sheet's own name, differs from it only in letter case (on Windows and macOS both names are the same file: rename it to another name first) or is another event sheet's name ignoring case; a file for the new name that already exists in the sheet's folder and is not one a stopped rename of this sheet left (below).

Event sheets and layouts that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched as text for the sheet's name: a match, or such a file that cannot be read at all, refuses the rename (`"success": false`, `"action": "rename_blocked"`, `message`, `references` and `unscannedFiles`; nothing changed). With `force: true` it goes ahead, and a warning names those files, which are NOT updated.

The event sheets and layouts that name the sheet are written first, then the sheet under its new name, then `project.c3proj`, then the old file is deleted (the last write the rollback covers), then the view state is moved. When a write fails, what the call wrote is put back; a file another write changed after the call wrote it (a save in the editor) is left as it is and named with its `.bak`, and a new file whose own write could not be confirmed is left and named. When a file the call is about to write changed on disk during the call, the write is refused, the file keeps that change, and what the call wrote before is put back.

Running the same call again finishes a rename that stopped midway (the server process ended): references already pointed at the new name are not found again; a file for the new name that holds the sheet's SID and the new name, and is not registered, is written over; and when the project registers the new name already while the old file itself is still there with the same SID, the call does what is left (points the references that still name the old name at the new one, deletes the old file, moves the view state) and says so with `"stoppedRun": true` and a warning. The old file is deleted as the last write, so a finished rename leaves only its `.bak`: the same call after a finished rename answers that the name is not found and changes nothing. Lines of project script files that hold the sheet's name as a string are listed in `possibleReferences` (`kind` `script file`, `in` the script's path) and never changed; a script file that cannot be read is named in a warning.

Returns `{ success, entity (the new name), category: "eventsheet", action: "renamed", previousName, references, filesWritten, fileDeleted, backupFile?, viewStateMoved?, possibleReferences?, stoppedRun?, warnings?, unscannedFiles? }`. `references` has one entry per place that was updated: `in` (the file, project-relative, e.g. `eventSheets/Menu.json`, `layouts/Level 1.json`), `kind` (`include` or `eventSheet binding`), `path` for an include (its JSON path) and `value` (the name as saved); `filesWritten` lists project-relative paths; `viewStateMoved` lists `{ from, to }`. With `dryRun: true` nothing is written: `action: "would_rename"`, `newName`, `references`, `possibleReferences?`, `filesToWrite`, `fileToDelete`, `stoppedRun?`, and the same warnings worded as what would happen.

### `delete_event_from_sheet`

Delete an event from an event sheet by SID or include name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet, as registered (letter case included) |
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

  Other event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched for the names of the functions the delete removes and, when the deleted event is a variable at the top level of its sheet, for that global variable (local variables are not visible to other sheets). A match, or such a sheet that cannot be read at all, is refused the same way, also on a dry run, and listed in `unscannedFiles`.

  The check stops at its traversal limit, 100,000 events (sub-events included) across all event sheets, which only very large projects reach. The uses beyond it are unknown, so the delete of a function or variable is then refused without `force` as well, also on a dry run; with `force` a warning says that the check stopped.
- **Load-time rules**: A delete takes an event out together with all its sub-events. The `expression-syntax`, `empty-expression` and `trigger-placement` rules look only at an event's own conditions and actions and at its ancestors, and no remaining event gains an ancestor or a condition, so a delete cannot introduce an issue of these rules; the names it leaves dangling are covered by the reference safety above. It can leave an else block without the block it belonged to (after a triggered block, after a non-block event or first in its list, comments aside): that `else-placement` warning is returned in `warnings`, also on a dry run. Include deletion is not checked (includes are not part of these rules).
- Error messages include a navigable summary of top-level events with their types and SIDs.

### `update_event_block`

Update an existing block event — modify action parameters, add/remove actions or conditions, toggle disabled state, make it an else or OR block.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | Yes | SID of the block event to update |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `disabled` | boolean | No | Enable or disable the entire block |
| `isElse` | boolean | No | `true`: put the System `else` condition first (existing conditions then make an else-if); `false`: remove a leading `else` condition. Blocks only. A block-level `isElse` key left by older versions is dropped either way. |
| `isOrBlock` | boolean | No | `true`: make it an OR block; `false`: AND-combine its conditions again |
| `updateActions` | array | No | `[{ index, parameters?, disabled? }]` — update actions by index (merge semantics). For a function call, `parameters` is an argument array that replaces all arguments, or an object keyed by position (`"0"`, `"1"`, …) or parameter name that replaces single ones. For a custom action call, `parameters` is an array in parameter order that replaces all arguments, and an object is refused. A comment row takes `text`, `"text-color"` and `"background-color"` instead (colours as `[red, green, blue, alpha]`, each 0-1; `null` removes one): it is edited in place, so it keeps its position among the actions and the keys it has, and a new colour goes where the editor writes it. Other keys are refused. |
| `updateConditions` | array | No | `[{ index, parameters?, isInverted?, disabled? }]` — update conditions by index. Other keys (e.g. `behaviorType`) are refused: remove the condition and add a new one instead. |
| `addActions` | array | No | Append new actions (same shapes as in `add_event_block`) |
| `addConditions` | array | No | Append new conditions |
| `removeActionIndices` | number[] | No | Remove actions by 0-based index |
| `removeConditionIndices` | number[] | No | Remove conditions by 0-based index |
| `insertActions` | array | No | `[{ index, action }]`: insert actions, in the shapes of `addActions`, at indexes. `index` counts the actions after `removeActionIndices`, before this call's other inserts and `addActions`; it may equal that count, which appends. Two inserts at one index are refused. |
| `insertConditions` | array | No | `[{ index, condition }]`: insert conditions at indexes, counted as `insertActions` counts actions. A System `else` condition inserted at index 0 stays first; one inserted anywhere else gets a warning (use `isElse: true`; when the block already starts with an else condition, or gets one through `isElse: true`, the warning says Else is saved once, first). |
| `replaceConditions` | array | No | `[{ index, condition }]`: replace conditions in place. `index` is the condition's index before this call; the new condition gets a new SID. A condition cannot be replaced and also removed or updated by the same call. |

At least one update parameter must be provided.

**Operation ordering** (indexes are the ORIGINAL array positions, except for inserts):
1. Block toggles (`disabled`, `isOrBlock`)
2. Condition updates (`updateConditions`): merge parameters, toggle flags
3. Action updates (`updateActions`)
4. Replacements (`replaceConditions`), indexes before the call
5. Removals (descending order, deduped): shrink arrays
6. Inserts (`insertConditions`, `insertActions`), indexes after the removals; two at one index are refused
7. Additions (`addConditions`, `addActions`): append
8. `isElse`: adds or removes the leading `else` condition

A call refuses, changing nothing, each of these; the message ends "Nothing was changed.": a removal index past the end of the block's conditions or actions (named before the inserts are counted); an insert index past the list after the removals; two inserts at one index; a replacement index past the block's conditions; a condition replaced twice, or replaced and also removed or updated; an insert at index 0 when the block's first condition, after this call's replacements and removals, is a System `else` condition (it stays first, also when disabled), unless the same call sets `isElse: false`, which takes that condition out; and a call that adds conditions or actions (through `addConditions`, `addActions`, `insertConditions` or `insertActions`) when the block would then hold more than 100 of them, the else condition `isElse: true` adds included. A call that adds none edits a block of any size. A trigger condition put into a block that holds a function block or a custom action block, at any depth below it, is refused by the load-time gate whichever of `addConditions`, `insertConditions` and `replaceConditions` brings it. Each of these is checked before the block changes. If a step throws after the block has changed, the block is put back as it was read and the error reads "The change was stopped before anything was written: ... Nothing was changed."; a failed write keeps its own message.

**Notes:**
- Only works on `block`, `function-block` and `custom-ace-block` (custom action block) events, not on groups, variables, etc.
- New actions/conditions get fresh SIDs via the ID generator
- `objectClass` is validated on new conditions/actions; `behaviorType` is soft-validated and the deprecated `"behavior-type"` alias is normalized, as in `add_event_block`. All additions are validated in one pass before anything changes, so each warning appears once and a conflicting key aborts the call without writing.
- Existing conditions/actions edited through `updateConditions`/`updateActions` that still carry the legacy `"behavior-type"` key are normalized to `"behaviorType"` with the same rules as `fix_legacy_behavior_keys`, and each one is reported in `warnings`. `update_event_block_action` does the same for the action it edits.
- `insertActions`, `insertConditions` and `replaceConditions` are checked like additions: object classes, the deprecated `isOr` flag, the load-time gate and the *Set return value* warning. Replacing or inserting a condition with a System `else` condition in the wrong place gets a warning.
- Duplicate removal indices are automatically deduplicated
- Warns only when this call removed the last condition (the block then runs whenever its parent runs; a function body or a custom action body on every call). Blocks that never had conditions, such as function blocks and condition-less sub-events, get no warning.
- `disabled` on the block, an action or a condition is written right after its `sid`, as the editor does. Parameters added to a condition that has `isInverted` but no `parameters` go before `isInverted`, and a new `isInverted` goes last, where the editor writes them.
- Added actions on the built-in Functions object are checked as in `add_event_block`; *Set return value* gets no warning when the block is a function block or one of its sub-events.
- An added condition with the deprecated `isOr` flag is refused unless the block is (or becomes) an OR block. An added System `else` condition is appended: on a block without conditions it becomes the first condition; in an else block, or with `isElse: true`, it is a duplicate and is dropped; otherwise it lands after the existing conditions with a warning (use `isElse: true` instead).
- Comment rows and script actions have no parameters: `parameters` on them is refused, and so is `disabled` on a comment row (editor-saved comment rows are `{ type, text }` with the optional colours `"text-color"` and `"background-color"`; none on record carries `disabled`). A comment row's text and colours are changed with `text`, `"text-color"` and `"background-color"` in its `updateActions` entry; these keys on any other action are refused.
- A function call already in the editor's shape keeps its keys where they are when its arguments change: only `parameters` is replaced, so an update with the same arguments leaves the call as it was (also a disabled call saved with `disabled` after `parameters`).
- Arguments the tool does not take are refused, and nothing changes: `update_event_block` does not add sub-events, so `children` is refused too. Added conditions and actions, and the entries of `updateConditions` / `updateActions`, refuse keys they do not know, as in `add_event_block` (see **Unknown keys** there); a `sid` on an added condition or action is ignored.
- A function call stored in an older shape (with `id`/`objectClass` or keyed parameters) whose arguments are edited is rewritten in the editor's shape, with a warning. A call whose name differs from its function's only in case is written with the function's spelling, with a warning.
- Runs the load-time gate (see `add_event_block`) on the whole sheet, so a trigger added to a sub-event of a triggered event, of a function block or of a custom action block is rejected, as is a second trigger in one event. New conditions are appended, so a trigger added to a block that already has conditions ends up after them; that only warns, since the editor moves it to the top when it opens the project. A block made an else block where Else cannot stand (no block before it, comments aside, or a block with a trigger) gets an `else-placement` warning.

### `update_event_block_action`

Replace the parameters of a single action. The block is found by SID anywhere in the sheet; the action by its 0-based index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `blockSid` | number | Yes | SID of the `block`, `function-block` or custom action block holding the action |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `actionIndex` | number | Yes | 0-based action index |
| `parameters` | object \| array | Yes | New parameter values; replaces the existing `parameters` entirely (max 100 keys, depth 6). For a function call: the arguments in parameter order as an array; an object keyed `"0"`, `"1"`, … or by the function's parameter names is converted to that array. For a custom action call: an array in parameter order, and an object is refused. An array for any other action is refused. |

Runs the load-time gate (see [`add_event_block`](#add_event_block)): parameters that break `expression-syntax` or `empty-expression` are refused and nothing is written; function call arguments are checked position by position. A legacy `"behavior-type"` key on the edited action is normalized as in `update_event_block` and reported in `warnings`, and a function call stored in an older shape is rewritten in the editor's shape (with the function's spelling of its name). Comment rows and script actions have no parameters and are refused; the error for a comment row points to `update_event_block`, whose `updateActions` change its text and colours in place. The result names the action by `actionId`, or by `callFunction` for a function call. A custom action call takes its arguments as an array in parameter order, which replaces the stored ones (an empty array removes them).

### `move_event_block`

Move an event, with its sub-events, to another place in the same event sheet (#ISSUE): the top level, a group (`groupPath`), the sub-events of an event (`parentSid`) or beside one (`siblingSid` with `position` `"before"` or `"after"`). Blocks, groups, variables, function blocks and custom action blocks are moved by SID. The event keeps its SID and everything in it. Use `move_events_between_sheets` to move top-level events to another sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet, as registered |
| `sid` / `eventPath` | number / string | Yes / No | The event to move; the path picks one of several events that share the SID |
| `groupPath`, `parentSid` / `parentEventPath`, `siblingSid` / `siblingEventPath` | string, number / string, number / string | No | The destination, as in `add_event_to_sheet`; none: the top level |
| `position` | enum | No | `"start"`, `"end"` (default), `"before"`, `"after"` |
| `force` | boolean | No | Move even when events then use a variable or parameter outside its scope |

Refused, changing nothing (the message ends "Nothing was changed."): a SID that matches no event or several without `eventPath`; a destination inside the moved event or beside itself; a place the placement rules of `add_event_to_sheet` do not allow for that kind of event; a function block, or an event holding one, under or below a block with a trigger or below a function block or a custom action block (the rule of `add_event_to_sheet`); a variable or parameter whose name would clash in its new scope (the editor's rule, see [Event variable names](#event-variable-names)); a new error of the load-time gate; an event of a type the tool does not move (the refusal names the type); a comment, an include or a script event has no SID and is refused as not found. If checking a very deeply nested sheet fails after the event is placed in memory and before the write, the sheet is put back and the call is refused with a message that begins "The change was stopped before anything was written" and ends "Nothing was changed."; a failed write keeps its own message.

Without `force`, the move is refused, changing nothing, and the result is `{ success: false, entity, category: "eventsheet", action: "move_blocked", message, references, reboundReferences?, unscannedFiles? }` when any of these holds:

- a use of an event variable or a function parameter would no longer find its declaration in the new scope (a local variable moved away from its users, a block moved out of the function whose parameter it uses, a global variable moved into a group while other sheets use it). These uses are listed in `references`;
- a use would find another event variable or function parameter of the same name after the move, so it would bind to a different declaration. These uses are listed in `reboundReferences`;
- event sheets that could not be parsed may hold a use of a global variable the move makes local (a text match, listed in `unscannedFiles`);
- the check of the uses stopped at its traversal limit (100,000 events across all event sheets) or at its nesting-depth limit (events nested more than 50 deep), so the uses further on are unknown.

With `force`, the move is written, the uses are listed in `references` (out of scope) or `reboundReferences` (another declaration), and each is named in a warning; the unparsed sheets and the limit are named in warnings as well. A move that makes an else block continue another event is reported in a warning, and other new warnings of the load-time gate are returned as well.

Each reference names the use's location in `path`, built like the paths of the other reference checks: the enclosing events as `function:<name>`, `group:<title>`, `block` or `custom-action:<object class>.<action name>` (a use inside a custom action body), then `condition:N` or `action:N` (0-based index).

Returns `{ success, entity, category: "eventsheet", action: "updated", movedSid, movedType, from, to, childrenMoved, warnings?, references?, reboundReferences?, unscannedFiles?, backupFile }`; `from` and `to` are event paths. A move to where the event already is returns `action: "unchanged"` and writes nothing. When the write fails, the sheet is put back, unless another write changed it since; the error then names it with its `.bak`.

### `update_event_variable`

Update an event variable declaration found by SID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the variable, as registered (letter case included) |
| `sid` | number | Yes | SID of the `variable` event |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `newName` | string | No | New name (checked, see [Event variable names](#event-variable-names)) |
| `newType` | `"number"` \| `"string"` \| `"boolean"` | No | New type |
| `newInitialValue` | string | No | New initial value, as a string |
| `isStatic` | boolean | No | Value persists between calls |
| `isConstant` | boolean | No | Value cannot change at runtime |
| `dryRun` | boolean | No | Report what the update would change, the uses a rename points at the new name included, and write nothing (default: false) |
| `force` | boolean | No | Rename even when uses would keep the old name: parameters the server cannot update, script lines, event sheets that could not be parsed and possibly use a renamed global or declare the new name, uses past the limit of the search; those uses are NOT updated, and expressions left with the old name made Construct 3 r506-2 show an *Invalid expressions* dialog naming them, offering only to close the project (default: false) |

At least one change must be provided. A new name is refused where the editor refuses it (see [Event variable names](#event-variable-names)): for a global variable it must differ, ignoring case, from every event variable and function parameter in the project, for a local one from those in its scope; changing only the case of the variable's own name is allowed.

**Renames and the events that use the variable.** A rename points uses of the variable at the new name where the server can tell what the parameter holds: the `variable` parameter of System variable conditions and actions (*Compare variable*, *Set value*, *Add to* ...) and the arguments of function and custom action calls (`F(Score * 2)`), matched ignoring case, as the editor looks variables up, including names with letters outside ASCII. Which events use it follows the editor's scope: a variable at the top level of a sheet is global and seen by every sheet; any other is local, seen by the events beside it and below them. A use finds the innermost local of its name, then a parameter of its enclosing function or custom action, then the global. A use of the same name that finds another variable (a local of that name in another group, one that hides a global, a function parameter) is left as it is. The server has no parameter types for the conditions and actions of plugins, behaviors and System, so it cannot tell an expression from a choice or another kind of name there (*Set group active* names a group in `group-name` and holds a choice in `state`). Such a parameter that names the variable, a call argument with a backtick, and a script line that reads the variable (`runtime.globalVars.Score`, `localVars.Count`) are listed in `usesNotUpdated` and never changed. Names held by the object, instance variable, layout and audio file parameters of System conditions and actions, member names (`Sprite.Score`), calls (`Score(1)`) and string literals are not uses. The `layout` of System *Go to layout (by name)* and *Load layout images (by name)* may hold an expression and is listed when it names the variable, and so is a plugin's or behavior's parameter of those kinds whose value names the variable (an addon's parameter there may be an expression; with `force` it is left as it is). Call arguments are not rewritten to a new name that starts with a digit, since an expression would read it as a number; they are listed. Script text that reads the variable is found even when the access is split over lines; scripts outside event sheets (`scripts/*.js` files) are not searched. An event sheet that could not be parsed whose text names the new name refuses a rename without `force`, a local's rename too (it may declare a variable of that name), and so does one whose text names the old name of a renamed global. Construct 3 r506-2 (Free edition) rewrites expression uses too when a variable is renamed in the editor; this server does so only for call arguments. The editor leaves script lines as they are too. In that editor a renamed global that a *Set group active* action spelled in `group-name` was rewritten there as well; the server never writes `group-name` and lists it. Construct 3 r506-2 (Free edition) renames a global the same way: a local that hides it keeps its uses. Construct 3 r506-2 (Free edition) does not accept a backtick in an expression: it lists it as an invalid expression and offers only to close the project. Uses of the new name that found no variable before and find this one after the rename are listed in `captured` and a warning. The other event sheets it changes are written first, in registration order, the variable's own sheet last; when a write fails, what the call wrote is put back, and a file another write changed since is left and named with its `.bak`.

**When a rename refuses.** A rename refuses (`success: false`, `action: "rename_blocked"`, `uses`, `usesNotUpdated`, `unscannedFiles`; nothing changed) while any use would keep the old name: a use in `usesNotUpdated`, an event sheet that could not be parsed whose text names a renamed global or the new name (or that cannot be read at all), or a search for the uses that stops at its traversal limit (for a local variable too). With `force: true` it goes ahead and a warning names what still names the old name. Expressions left naming the old name made Construct 3 r506-2 (Free edition) show an *Invalid expressions* dialog naming them when the project was opened, offering only to close the project; script lines left unchanged were not reported there. Correct the parameters of an action with `update_event_block_action` and those of a condition with `update_event_block` (`updateConditions`) before opening the project; script lines are edited in the editor. A registered event sheet with no file holds no uses. In a project where most uses of a variable are expressions in plugin or System actions, expect the refusal and use `dryRun` to list them. A dry run of a rename that would refuse returns the refusal.

The result of a rename that goes ahead holds `sheetsWritten`, `uses` (`sheet`, `path`, `kind` `event-variable` or `variable-expression`, `parameter`, `sid`, `value`) and, when there are any, `usesNotUpdated` (`sheet`, `path`, `parameter`, `sid`, `reason`: `parameter-type-unknown`, `name-parameter`, `template-text`, `number-like-name`, `number-like-new-name` or `script`, `value`) and `captured`; with `dryRun` it returns `action: "would_update"` and `sheetsToWrite` instead of writing.

### `move_events_between_sheets`

Copy top-level events from one sheet to another by SID; with `deleteSource` they are moved. SIDs and nested children are kept as they are.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceSheet` | string | Yes | Sheet to copy/move from, as registered (letter case included) |
| `targetSheet` | string | Yes | Sheet to copy/move into (must differ from the source), as registered |
| `sids` | number[] | Yes | SIDs of top-level events in the source sheet (min 1, each SID once) |
| `eventPaths` | string[] | No | Paths of top-level events (`"events[4]"`) that pick one of several top-level events sharing a SID in `sids`, one per such SID (see [Events that share a SID](#mutation-tools)) |
| `deleteSource` | boolean | No | Remove the events from the source after copying (default: false) |
| `targetGroupPath` | string | No | Insert into a group by title path (e.g. `"Movement > Collision"`), matched as `groupPath` in `add_event_block` (titles with leading/trailing whitespace included) |
| `position` | `"start"` \| `"end"` | No | Insert position (default: end) |
| `force` | boolean | No | Move even when events still use an event variable the move takes out of their scope (default: false); the uses are listed in `references` and in a warning, and left dangling |

Copied and moved events keep their function names: a copy of a function block (`deleteSource: false`, also inside a copied group) would leave two function blocks with one name, which the editor refuses (see [Function names](#function-names)), so it is refused and nothing is written; moving it is fine. They also keep their event variable and function parameter names. A copy or move that would give one of them a name that is in use, ignoring case, in its new scope (see [Event variable names](#event-variable-names)) is refused and nothing is written; the error lists the clashing names. The most common case is a copy of a global variable (`deleteSource: false`), since its original keeps the name; moving it to the top level of another sheet keeps it a global variable (see the next paragraph for moves into a group). A local variable or parameter moved into a group (`targetGroupPath`) can also clash with the group's variables. The editor renames a pasted variable in this case instead; rename it first with `update_event_variable`. Clashes that the events already had in their old place are not counted.

**Custom actions.** A copy (`deleteSource: false`) that would leave two custom actions of one name on one object type or family is refused, and nothing is written; the error lists up to ten of the duplicates and says to move the custom action instead (`deleteSource: true`). Construct 3 r506-2 (Free edition) renamed the second of two such definitions when it saved. A copy is also refused, `force` or not, while the check for custom actions stops at its limit, since the duplicates beyond it are unknown, whatever the copied events hold. A move is not refused by either rule.

**Scope of moved variables.** A variable at the top level of a sheet is a global variable, visible in every sheet; any other variable is local, visible only to the events beside it and below them. So a global variable moved into a group (`targetGroupPath`) becomes a local variable of that group, and the events elsewhere that use it no longer find it: the editor's loader throws *cannot find event variable* for them (whether the project then fails to open has not been confirmed in the editor). Unless `force=true`, such a move is refused (`success: false`, `action: "move_blocked"`) and nothing is written; `references.variableReferences` lists the uses that would lose the variable, with `variable`, `via` (`event-variable` or `expression`), `sheet`, `path` and `sid`, where they are after the move. The uses are those [`delete_event_from_sheet`](#delete_event_from_sheet) checks (System conditions and actions on the variable, expressions that use it by name; scripts are not scanned), with the same scope rules; a use that still resolves after the move (in the same group, moved along, or through another variable of that name) does not count. Move the events that use it along, keep it at the top level of a sheet, or pass `force=true`, which moves it and returns the uses in `references` and a warning. Other event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched as text for a global variable the move makes local: a match, or such a sheet that cannot be read at all, is refused the same way (`unscannedFiles`). The check stops at its traversal limit, 100,000 events (sub-events included) across all event sheets, which only very large projects reach; a move of events that declare an event variable is then refused without `force` as well, since the uses beyond the limit are unknown. Functions stay visible in every sheet wherever they are moved.

Runs the load-time gate (see [`add_event_block`](#add_event_block)) over the source and target sheets together, before anything is written. Moving an event that already breaks a load-time rule only relocates the problem and is allowed; copying it (`deleteSource: false`) adds the problem to a second sheet, so a copied error is refused and a copied warning is returned in `warnings`.

Only top-level events count: a SID shared by two top-level events of the source is refused unless `eventPaths` picks one, while a nested event with the same SID does not make it ambiguous. `deleteSource` removes exactly the copied events. A SID listed twice in `sids` is refused; top-level events that share a SID are moved one per call.

Moved events keep their SIDs; when a moved event, or one of its sub-events, has a SID that another event of the target sheet already has, the move is still written, since the editor opens such sheets, and `warnings` names each such SID with the paths of its events there: the SID-based event tools then refuse it in the target sheet unless `eventPath` picks one. Copied events get new SIDs, the copied conditions, actions and parameters too (`reassignedSids` counts them), so a copy never shares a SID with its original.

Returns `movedSids`, `movedCount`, `backupFiles` (target first, then source when modified) and `warnings`, if any: new load-time warnings, the shared-SID warning and, with `force`, the uses left out of scope (also in `references`). A copy (`deleteSource: false`) also returns `reassignedSids`, the number of SIDs it gave new values.

### `move_event_block_items`

Move, reorder or copy conditions or actions within a block, function block or custom action block of an event sheet, or into another such block of the same sheet. A moved item keeps its SID. A copy (`copy: true`) gets a new SID and the source keeps its items; an item without a SID is copied without one. This tool moves conditions and actions only, never events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet, as registered |
| `sourceBlockSid` / `sourceEventPath` | number / string | Yes / No | The block, function block or custom action block the items are in; the path picks one of several events that share the SID |
| `targetBlockSid` / `targetEventPath` | number / string | Yes / No | The block the items go to (the same SID to reorder); the path picks one of several events that share the SID |
| `itemType` | `"actions"` \| `"conditions"` | Yes | Which list the items are in |
| `indices` | number[] | Yes | Indexes of the items in the source, 1 to 100 of them, each once; they keep their order whatever order they are given in |
| `targetIndex` | number | Yes | Where the items go in the target. A move within one block counts it after the items are taken out; otherwise it counts the target as it is, and it ranges from 0 to the number of items there |
| `copy` | boolean | No | Copy instead of move (default: false) |
| `force` | boolean | No | Move even when an item then uses an event variable or function parameter outside its scope (default: false); the uses are listed in `references` and in a warning |

Refused, changing nothing (each message ends "Nothing was changed."): an index listed twice or past the end of the source; a `targetIndex` past the place the items can go; a move between blocks or a copy that would give the target more than 100 items of the kind (a reorder is not capped); a source or target SID that matches no event, or several without its path argument (the candidates are listed), or an event that is not a block, function block or custom action block; moving or copying an else condition, which stays first in its own block; an item put at index 0 in front of the target's else condition, enabled or disabled (use index 1 or later); an object class that is no object type, family, System or the Functions object, checked against the target as `add_event_block` checks it; a new load-time error of the sheet.

Without `force`, a move or copy after which an item uses an event variable or function parameter (a custom action parameter included) outside its scope, or where a use finds another declaration of the same name, returns `{ success: false, action: "move_blocked", message, references }` (with `reboundReferences` for a name that then finds another declaration) and changes nothing. The check stops at its traversal limit, 100,000 events (sub-events included) across all event sheets, or at a nesting depth of more than 50 levels (events nested more than 50 deep); then the move is refused without `force` too, since the uses beyond the limit are unknown; when only a limit blocks the move, the message offers `force=true` only, since there is no other place to move the items to.

Written moves carry warnings, if any: new load-time warnings; *Set return value* where it stands outside a function block after the move (never refused); a notice when every condition of the source has moved, so the source then runs whenever its parent runs (a function block or custom action block: on every call of it); and, with `force`, the uses left out of scope. A move or copy of a trigger condition into a block that holds a function block or a custom action block, at any depth below it, is refused by the load-time gate (*cannot add another trigger to event branch*).

Returns `{ success, entity, category: "eventsheet", action: "updated", sourceBlockSid, targetBlockSid, itemType, copy, sids, targetIndex, warnings?, references?, reboundReferences?, backupFile }`; `sids` are the SIDs of the moved items (the new ones for a copy). A call that leaves the items where they were writes nothing and returns `action: "unchanged"`. When the write fails, the sheet is put back, unless another write changed it since; the error then names it with its `.bak`. A failure before the write puts the sheet back and reads "The change was stopped before anything was written: ... Nothing was changed."

### `remove_event_from_sheet`

Remove include events for a given sheet from an event sheet. Use `delete_event_from_sheet` with a SID for other event types.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet to modify |
| `includeSheet` | string | Yes | Name of the included sheet to remove |

### `add_custom_action`

Add a custom action definition (a custom action block, `eventType` `"custom-ace-block"`) to an event sheet. A custom action belongs to an object type or family and is called on it with a call action (see **Calling a custom action** below). Its conditions and actions are added afterwards with [`update_event_block`](#update_event_block) on the returned SID. Arguments the tool does not take are refused, and nothing is written.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet, as registered (letter case included) |
| `objectClass` | string | Yes | The object type or family the custom action belongs to |
| `aceName` | string | Yes | The custom action's name, as calls give it in `customAction` |
| `description` | string | No | The description shown in the editor (up to 2000 characters) |
| `category` | string | No | The category it is listed under in the editor |
| `isAsync` | boolean | No | The editor's "Asynchronous" option (default false) |
| `copyPicked` | boolean | No | The editor's "Copy picked" option (default false) |
| `parameters` | array | No | Parameters in call order, up to 100: `{ name, type, initialValue?, comment? }` with `type` `"number"`, `"string"` or `"boolean"`. `initialValue` defaults to `"0"`, `""` or `"false"` by type. |
| `groupPath` | string | No | Into a group by title path, matched as in `add_event_block` |
| `parentSid` | number | No | Into the sub-events of this group |
| `parentEventPath` | string | No | Picks one of several events that share `parentSid` |
| `siblingSid` | number | No | Beside this event, in the same list; needs `position` `"before"` or `"after"` |
| `siblingEventPath` | string | No | Picks one of several events that share `siblingSid` |
| `position` | enum | No | `"start"`, `"end"` (default), or `"before"` / `"after"` the `siblingSid` event |
| `force` | boolean | No | Add even while an event sheet the server could not parse, or a scan that stopped at its limit, may define a custom action of that name (default false) |

**Placement.** The definition goes at the top level, in a group, or beside an event there, and only where every event above it is a group, so a group inside a group is allowed. A place below a block, a block with conditions, a function block or a custom action block is refused. Construct 3 r506-2 (Free edition) was tried with a custom action block at the top level and in a top-level group, and accepted it in both; the rule for nested groups is this tool's own and was not checked in the editor. A custom action block is a trigger root for the load-time check, as a function block is.

**Refusals.** Each one changes nothing, and its message ends with "Nothing was changed.":
- An owner that is no object type or family. System and the Functions object own no custom action. A name that differs only in letter case gets a hint with the spelling that exists.
- An empty `aceName`, or one of only spaces.
- A second custom action of the same name on the same owner, ignoring letter case, anywhere in the project; the message names its sheet, path and SID. A custom action of the same name on another object type, or a member's own action that overrides its family's, is allowed. Construct 3 r506-2 (Free edition) ran the first of two definitions of one name and renamed the second one when it saved (DoK became DoK2), so a call could not tell them apart. The refusal also covers names that differ only in letter case; that wider rule is the tool's own and was not checked in the editor.
- A parameter name that the editor's function parameter dialog refuses: a name that a global variable, an event variable or an earlier parameter of the same list has, a name given twice, or a name that differs only in case from one of them. In a group, a name that a variable of an enclosing event has is refused as well; this is the tool's own rule.
- A place where a custom action block may not stand (see **Placement**).

**Unparsed sheets and the scan limit.** Event sheets that the server could not parse are searched as text for the custom action's name and its owner. A possible match refuses the call without `force`, and the sheets are listed in `unscannedFiles`; with `force` the definition is added and a warning names them. A sheet searched without a match gets a warning. The scan of custom action definitions stops at its limit (100,000 events across all event sheets, or nesting deeper than 50 levels); a definition past it is unknown, so the call refuses without `force`, and with `force` it is added with a warning. A registered sheet other than the target that cannot be read at all refuses the call without `force`; with `force` the call is added with a warning. If the target sheet itself cannot be read, the call is refused, with or without `force`.

**Load-time gate.** The sheet is checked against the load-time rules as in `add_event_block`, and the new warnings are returned in `warnings`. For example, a custom action block placed between a block and its else block gets an `else-placement` warning.

**Written shape.** The definition is written as Construct 3 r506-2 (Free edition) saved one: the keys `aceType`, `aceName`, `objectClass`, `functionDescription`, `functionCategory`, `functionReturnType` (always `"none"`), `functionCopyPicked`, `functionIsAsync`, `functionParameters`, `eventType` (`"custom-ace-block"`), `conditions`, `actions` and `sid`, in that order, with no `children` key. Each parameter is `{ name, type, initialValue, comment, sid }`. There is no return type parameter.

**Returns.** `generatedSid` (the definition's SID), `parameterSids` (`{ name, sid }` for each parameter, when there are any), `eventPath`, `backupFile`, and `warnings` and `unscannedFiles` when there are any.

**Rollback.** When the write fails, the sheet is put back, unless the file no longer holds this call's write (an editor save changed it after the write, say, or another write did); then the sheet is left as it is and the error names it with its `.bak`. The message keeps the write's own error.

**Calling a custom action**

A call is an action of `add_event_block` (in `actions`) or of `update_event_block` (in `addActions`): `{ customAction, objectClass, customActionObjectClass?, parameters?, disabled? }`. It is written with the keys `customAction`, `objectClass`, `customActionObjectClass` (when there is one), `sid`, `disabled` (only when true) and `parameters` (only when there are arguments), in that order.

- `objectClass` must be an object type or family of the project. System and the Functions object are refused, and so is an unknown name.
- `customActionObjectClass` must be `objectClass` itself or a family that `objectClass` belongs to; any other name is refused.
- The definition a call runs is the one on `customActionObjectClass` when given, else on `objectClass`, else on the first family `objectClass` belongs to that defines the name. The name matches ignoring letter case. A call written in another case gets the definition's spelling from `add_event_block` and from the calls `update_event_block` adds, with a warning; `update_event_block`'s `updateActions` and `update_event_block_action` keep the stored name and warn.
- A member's call of a custom action its family defines (the member has no definition of that name) carries `customActionObjectClass` set to that family, after `objectClass`, as Construct 3 r506-2 (Free edition) saved it. A call on the family itself, or on a member with its own definition, carries none.
- A call that names no custom action of the parsed sheets is written with a warning. Whether Construct 3 opens a project with such a call was not checked.
- When the object has no definition of the name of its own, the call names no `customActionObjectClass`, and two of its families both define the name, the call uses the first family in the order the families are read, with a warning. Which one Construct 3 runs was not checked. The first family is used whatever the spelling: when it defines the name in another letter case than the call and a later family defines it in the call's exact spelling, the warning names that family.
- An argument count other than the definition's parameter count is written with a warning.
- A boolean argument stays a JSON boolean. Other arguments are strings, as expressions. `add_event_block` and the `addActions` of `update_event_block` refuse a number argument (the argument schema takes strings and booleans only); `update_event_block_action` and the `updateActions` of `update_event_block` take numbers and write them as strings. The number behavior was not checked in the editor.
- `update_event_block` edits the conditions and actions of a custom action block by its SID (it has no `isElse`, since a custom action block cannot be an else block). It adds no sub-events, and no tool on this branch places an event inside a custom action block.
- `update_event_block` and `update_event_block_action` replace a call's arguments with an array in parameter order (key-value parameters are refused); an empty array removes them. An argument count that differs from the definition's parameter count is written with a warning.

### `update_function`

Change a function block (`eventType` `"function-block"`) or a custom action block (`"custom-ace-block"`), found by its SID: its name, description, category, options and parameters and, for a function block, its return type. `returnType` is refused for a custom action block: this tool applies it to function blocks only. The calls that run the block are rewritten only with `updateCallers`. Arguments the tool does not take are refused, and nothing is written.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet that holds the block, as registered (letter case included) |
| `sid` | number | Yes | SID of the function block or custom action block |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `functionName` | string | No | The new name: a function's name, or a custom action's `aceName`. A function name is checked as in [Function names](#function-names); a custom action name as in [`add_custom_action`](#add_custom_action) |
| `returnType` | `"none"` \| `"number"` \| `"string"` \| `"any"` | No | The editor's Return type. Function blocks only |
| `description` | string | No | The editor's Description |
| `category` | string | No | The editor's Category |
| `isAsync` | boolean | No | The editor's Asynchronous option |
| `copyPicked` | boolean | No | The editor's Copy picked option |
| `addParameters` | array | No | Parameters to append, in order: `{ name, type, initialValue?, comment? }`, with `type` `"number"`, `"string"` or `"boolean"` |
| `removeParameters` | string[] | No | Names of parameters to remove |
| `renameParameters` | array | No | `{ from, to }` renames. Uses in the body are not rewritten, so a rename whose old name the body still uses is refused without `force` (below) |
| `updateCallers` | boolean | No | Rewrite the calls that run the block and, for a function block, its function map registrations (default: false) |
| `force` | boolean | No | Update past the refusals marked "without `force`" below; what was found is named in a warning, and parameter uses in the body are also listed in `references` and `reboundReferences` (default: false) |
| `dryRun` | boolean | No | Report what would change and write nothing (default: false) |

**Calls and function maps.** A call is found by its name, ignoring letter case. With `updateCallers`, a rename rewrites the name of each call (`callFunction`, or `customAction` for a custom action block) and the function name of each function map registration. A `Functions.Name(...)` call in an expression is listed and left as it is. Scripts are not checked: a script action is neither found nor rewritten.

**Refused, with or without `force`.** Nothing is written:
- A call that gives no update (none of the name, the options, `returnType` or a parameter change) and no `dryRun`.
- An event that is neither a function block nor a custom action block.
- A function name the editor refuses, as in [Function names](#function-names), and a return type the function's current name cannot have.
- `returnType` on a custom action block.
- A custom action renamed to an empty name or one of only spaces: `functionName is empty or only spaces.`
- A custom action renamed to a name its owner already has, ignoring letter case (a case-only rename is checked against the owner's other definitions too), with the rule of [`add_custom_action`](#add_custom_action). An update that keeps the name is not checked, so a duplicate the project already holds does not stop it.
- A parameter to remove or rename that the block does not have, or a parameter name the editor refuses (see [Event variable names](#event-variable-names)). Removals come before renames, so renaming a parameter the same call removes is refused.
- A rename, or a parameter added or removed, while calls (or, for a renamed function block, function map registrations) exist and `updateCallers` is not given: the calls are listed.

**Refused without `force`.** Each refusal lists what it found and writes nothing:
- Removing a parameter or renaming one that the body still uses by its old name, or a rename after which a use in the body finds another parameter.
- A `Functions.Name(...)` call in an expression, when the block is renamed, a parameter is added or removed, or its return type changes to `none`.
- An event sheet that could not be parsed, whose text may hold the old name or, for a rename, the new name, when the block is renamed, a parameter is added or removed, or the return type becomes `none`. Such a sheet is searched as text.
- A check of the uses of the block that stopped at its limit of 100,000 events across all event sheets.

**Refused even with `force`.**
- A custom action rename that would make a call the scan reached run another definition, stop running the renamed one, or, running nothing now, run the renamed one. The message lists the calls, with what each runs now and what it would run after the rename.
- Removing and adding the same number of parameters in one call while calls exist. Each call would keep its argument count, so a run repeated after a stop could not tell a call already rewritten from one not yet rewritten. Make two calls: one that removes, then one that adds. With no calls, the same update is made.

**Calls rewritten with `updateCallers`.**
- A call's arguments are rewritten only when it passes the parameter count from before the update: arguments at removed positions are dropped and new ones appended. A call with another count keeps its arguments and is listed in `warnings`, so a run repeated after a stop changes nothing more.
- A new parameter's argument is its initial value: a number as its numeric literal, a string as a Construct string literal with each inner quote doubled, or `true` or `false` for a boolean.
- The initial value is checked before anything is written: a number must be a number (`1 + x` is refused), a boolean must be `true` or `false`, and a string cannot hold a line break (a newline or a carriage return). That refusal is this tool's own rule: whether Construct 3 accepts a line break inside a string literal was not checked in the editor.

**Custom action calls.** A call is matched to the definition it runs as [`add_custom_action`](#add_custom_action) describes. A plain call on an object that belongs to two families that both define the new name gets a warning: it uses the definition on the renamed block's owner, and which one Construct 3 runs was not checked in the editor. Ten such warnings are listed, one for each call; further calls are counted in a last warning ("And N more rewritten call(s) ...").

**Order and rollback.** Every sheet is read before the first write. The caller sheets are written first, in the order the project registers them, and the sheet of the block last. A failure after the first write puts back what the call wrote. A file that another program saved meanwhile is left as it is, and the message names it with its `.bak`. "Nothing was changed." appears only when the call left every file as it was. The message says what is on disk.

**Unchanged and dry runs.** An update to the values the block already has returns `action: "unchanged"` and writes nothing. `dryRun` reports what would change (`calls`, `maps`, `expressions` and `parameters`) and writes nothing.

**Returns.** `kind` (`"function"` or `"custom-action"`), `updatedSid`, `name`, `previousName`, `parameters` (each with its `sid`), `updatedSheets` in the order written, `rewrittenCalls`, `rewrittenMaps`, `backupFiles`, and when there are any `warnings`, `references` and `reboundReferences` (parameter uses left with `force`) and `unscannedFiles`.

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
- `isElse: true` on a block without conditions whose previous sibling, not counting comments, is a block without a trigger: a System `else` condition with a new SID is put first and the key dropped. When the block already starts with the `else` condition, or the key is not `true`, the key is just dropped.
- `isOr` on every condition after the first: the block gets `isOrBlock: true` and the keys are dropped. `isOr` keys that never had an effect (on the first condition only, `false`, or in a block that already is an OR block) are dropped.
- Function calls: `id`, `objectClass` and behavior keys are dropped, and parameters keyed `"0"`, `"1"`, … or exactly by the function's parameter names become the positional array, in the order `callFunction, sid, disabled, parameters`.
- Script actions and script events: a script stored as one string becomes an array of lines (split at line breaks), and a missing `language` becomes `"javascript"`, in the order `type, language, script, disabled`.

**Reported under `manual`** (left untouched): an `isElse` block that has conditions (it would become an else-if that tests them: decide with `update_event_block` and `isElse: true` or `false`), an `isElse` block with no block before it (comments aside) or after a block with a trigger (Else can only follow non-triggered events), `isOr` on only some of the later conditions (make it an OR block, or split the event), calls whose parameter keys cannot be mapped, and scripts that are neither text nor a list of lines.

Only sheets with conversions are written, each backed up first. Returns `totalConverted`, `totalManual`, `totalBehaviorChanges` and per-sheet `changes` (kind, JSON path, SID, what changes, `changesBehavior`; capped at 100 per sheet), `manual` and `backupFile` when written. `validate_project` reports affected sheets as warnings with check `legacy-event-shape`.

### `update_event_group`

Update a group event in place (#ISSUE): its title, description, *Active on start*, disabled state and colours. The group keeps its SID and its sub-events. A group is found by SID; `eventPath` picks one of several events that share it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet, as registered |
| `sid` / `eventPath` | number / string | Yes / No | The group; the path picks one of several events that share the SID |
| `title`, `description` | string | No | New title and description |
| `isActiveOnStart`, `disabled` | boolean | No | The editor's *Active on start*; disables or enables the group |
| `backgroundColor`, `textColor` | `[red, green, blue, alpha]` or `null` | No | Each 0-1, written as `background-color` and `text-color`; `null` removes the key |
| `force` | boolean | No | Rename even while a `group-name` parameter or an unparsed event sheet may name the old title; they are listed and left as they are |

Give at least one of `title`, `description`, `isActiveOnStart`, `disabled`, `backgroundColor` and `textColor`. A value the group already has changes nothing.

Refused, changing nothing (each message ends "Nothing was changed."): no update given; a SID that no event has, or that several events share (`eventPath` picks one); an event that is not a group; an event sheet that is not registered.

**Titles.** Refused, changing nothing: an empty or blank title, and a title that another group in the same list has, exactly or with outer whitespace ignored, since group paths in that list could not tell the two apart. Another group that has the title, ignoring letter case and outer whitespace, does not refuse the rename: it is named in a warning, because "set-group-active" and "is-group-active" name a group by its title. That covers a group in another list or another sheet, and a group in the same list whose title differs only in letter case. Construct 3 r506-2 (Free edition) opened and saved a project with two groups titled "Same", one at the top level and one nested in a group "Outer".

**Uses of the old title.** A rename is refused without `force` while a `group-name` parameter of a condition or action names the old title: a quoted string equal to it, equal to it ignoring case, or any other value, which may give it. Event sheets that could not be parsed (for example, not valid JSON) are searched as text for the old title, and a match refuses the rename too. A search that stops at its node limit (100,000 events across all event sheets) or its nesting-depth limit (events nested more than 50 deep) refuses the rename too and names the limit. The refusal lists the uses and ends "Nothing was changed."; with `force` the group is renamed, the uses are listed in `references` and counted in a warning, and they are never rewritten. A local count of an r495.2 editor-saved project found no `group-name` parameter.

**Colours.** The colour keys are written after `sid`, with `text-color` before `background-color`. That order rests on one saved group in Construct 3 r506-2 (Free edition), which carried both colours. A colour key the group already has is updated where it stands. A group with only one colour gets the same placement; that was not checked in the editor. `null` removes the key.

Returns `{ success, entity, category, action, updatedSid, eventPath, title, warnings?, references?, unscannedFiles?, backupFile? }`, with `backupFile` when written. `action` is `"updated"`, or `"unchanged"` when the values already match and nothing is written. A rename that is refused for its uses, a limit or an unparsed sheet returns `{ success: false, action: "rename_blocked", message, entity, category, references, unscannedFiles? }` and changes nothing.

When a change throws before the write, the sheet is put back in memory and the call refuses with "The change was stopped before anything was written: ... Nothing was changed." When the write fails, the call is rolled back; if the editor saved the sheet after the failed write, the error names the file and its `.bak` and leaves the sheet as it is.

### `update_comment`

Update a comment event in place (#ISSUE): its text and colours. A comment has no SID, so it is addressed by its container and its 0-based `index` among all events of that container, counted in the order the events appear there. A comment row among a block's actions is changed with `update_event_block` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet, as registered |
| `groupPath` | string | No | The group that holds the comment; none: the top level |
| `parentSid` / `parentEventPath` | number / string | No | The event whose sub-events hold the comment |
| `index` | integer | Yes | Index of the comment among all events of its container |
| `text` | string | No | New text |
| `textColor`, `backgroundColor` | `[red, green, blue, alpha]` or `null` | No | Each 0-1, written as `text-color` and `background-color`; `null` removes the key |

Give at least one of `text`, `textColor` and `backgroundColor`. The tool takes no `siblingSid` and no `position`; they are refused as unknown arguments.

Refused, changing nothing (each message ends "Nothing was changed."): no update given; an index past the end of the container; an event at the index that is not a comment; an event sheet that is not registered or cannot be read.

A comment event keeps its keys in the order `eventType`, `text`, `text-color`, `background-color`. A colour the comment lacks is inserted after the keys that come before it in that order (`text-color` after `text`, `background-color` after `text-color`). The tool uses this order for comment rows among a block's actions too; it was not checked in the editor for a comment event. `null` removes a colour. An update to the values the comment already has returns `"unchanged"` and writes nothing.

Returns `{ success, entity, category, action, eventPath, backupFile? }`, with `action` `"updated"` or `"unchanged"` and `backupFile` when written. A failure is handled as for `update_event_group`: the sheet is put back, and a failed write names the file and its `.bak` when the editor saved the sheet after it.

### `update_script_event`

Replace the JavaScript of a script event, enable or disable it, or remove it (#ISSUE). A script event has no SID, so it is addressed like a comment, by its container and `index`. A script action among a block's actions is changed with `update_event_block` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet, as registered |
| `groupPath` / `parentSid` / `parentEventPath` | string / number / string | No | The container, as for `update_comment` |
| `index` | integer | Yes | Index of the script event among all events of its container |
| `script` | string or string[] | No | New JavaScript: one string, split into lines, or an array of lines |
| `disabled` | boolean | No | `true` disables the event; `false` removes its `disabled` key |
| `remove` | boolean | No | Removes the script event; needs `expectedText` |
| `expectedText` | string | With `remove` | The first line of the script event to remove |

Give exactly one of `script`, `disabled` and `remove`. `expectedText` is only used with `remove`.

**Removal.** `remove` needs `expectedText`, and the script event at `index` must start with it: its first line, whether the script is stored as one string or as a list of lines (an entry of the list that holds a line break counts up to the break). Otherwise the removal is refused and the message gives the first line found. Removing a script event runs the load-time gate; its warnings are returned, and an else block that then continues another event is reported in a warning.

Refused, changing nothing (each message ends "Nothing was changed."): none, or more than one, of `script`, `disabled` and `remove`; `expectedText` without `remove`; `remove` without `expectedText`; a first line that differs; an index past the end of the container; an event at the index that is not a script event (an event without an `eventType` is named as one that has none); an event sheet that is not registered or cannot be read; a removal after which the load-time check reports errors for issues the removal introduces in the sheet (the message starts "Construct 3 load-time check failed; nothing was written." and lists the rules broken; no current load rule can produce this for a real sheet, since the rules look at an event's ancestors, and at its predecessor only for an else block, which is a warning, but the guard stays).

Returns `{ success, entity, category, action, eventPath, warnings?, backupFile? }`; `action` is `"updated"`, `"deleted"` for a removal, or `"unchanged"` when the event already has the values given. `backupFile` is given when written. Failures are handled as for `update_comment`.

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
| `zElevation` | number | No | Z elevation for 3D layering (default: 0), written as `world.z` |
| `originX` | number | No | Horizontal origin 0-1 (default: 0.5 = center) |
| `originY` | number | No | Vertical origin 0-1 (default: 0.5 = center) |
| `instanceVariables` | object | No | Instance variable values as `{varName: value}`; every instance variable of the object and its families not given gets its default (`0`, `""` or `false`); a name the object and its families have no instance variable of is refused |
| `behaviors` | object | No | Behavior property values as `{behaviorName: {properties: {prop: val}}}` (the shape `get_layout_details` returns) or `{behaviorName: {prop: val}}`; they override the defaults |
| `tags` | string | No | Comma-separated instance tags (alphanumeric only) |
| `showing` | boolean | No | Whether instance is initially visible (default: true) |
| `locked` | boolean | No | Whether instance is locked in the editor (default: false) |

**Notes:**
- Blocks global-only objects (singleglobal-inst) from being placed
- The new UID is above every UID in the project, sub-layer instances included, and above every UID a hierarchy link names (`sceneGraphData` `"parent-uid"` and `children`), so a link left pointing at a deleted instance never names the new one; the new SID is unused. Layouts and object types over the reader's size limit (10MB by default) or with invalid JSON count too: their UIDs and SIDs are found by a text scan of the file. The text scan streams the file, so there is no size limit. The scan reads a UTF-16LE byte order mark as such and leaves out NUL characters, so UTF-16 without a byte order mark, UTF-16BE and a file whose end is zeros are scanned too. When a registered layout or object type exists but cannot be read at all (e.g. a folder in its place, no access), the tool refuses and names the file and the reason instead of risking a UID that is already in use, and the next call tries the file again; a registered name without a file does not block it
- Nonworld-global objects (Array, JSON, Dictionary) are placed in `nonworld-instances` instead of on layers
- Auto-fills default instance properties for Sprite, Text, TiledBg, NinePatch
- Writes a behavior entry for every behavior of the object and of the families it belongs to, like the editor: family behaviors first, then the object's own, each as `{"properties": {...}}` with the built-in behavior's default values (from the Construct 3 r449 editor's behavior definitions). Values passed in `behaviors` override the defaults. A behavior without known defaults (third-party addons) gets `{"properties": {}}` and a warning; Construct 3 fills in missing properties with their defaults when it opens the project (Scirra's own example projects contain such entries). The warning also points out a behaviorId that is not one the editor defines, such as `"Solid"` for `"solid"`
- Writes a value for every instance variable of the object and of the families it belongs to, like the editor: family variables first, then the object's own, the given values on top of the defaults (`0`, `""`, `false`). A name in `instanceVariables` that neither the object nor its families have is refused (names are matched with their letter case; a name that differs only in case is pointed out), and a value of another type than its variable is written with a warning. A family file that could not be parsed (see [Files the server could not parse](#mutation-tools)) whose text names the object, or that cannot be read at all, may make the object a member: a given name that its text holds is written as given, and a warning (with `unscannedFiles`) says that the new instance got no values for that family's other instance variables and no entries for its behaviors
- Warns on behavior names that are not behaviors of the object or its families, on property ids that a built-in behavior does not have, and on values whose type differs from the property's default (e.g. a string for a check box)
- All visual and behavioral properties are preserved when specified

### `delete_layout`

Delete a layout from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Blocks unconditionally if the layout is the project's startup layout (`firstLayout`)
- Checks for bound event sheets and placed objects
- When the layout's own file could not be parsed (see [Files the server could not parse](#mutation-tools)), its text is searched for instances (`"uid": <number>`) and a non-empty `"eventSheet"` binding: a match (`names`: `instances`, `an event sheet binding`), or a file that cannot be read at all, blocks as well (`unscannedFiles`)
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Refuses when the JSON file changed on disk since it was read; then removes the name from `project.c3proj` and deletes the file (kept as `.bak`). When either step fails, the call is undone; when `project.c3proj` was saved again meanwhile and cannot be put back, the error says what is on disk: if it no longer lists the name, the file is left on disk unregistered. If `project.c3proj` lists the name again after the file was deleted, the call is an error

### `rename_layout`

Rename a layout and update what names it (#ISSUE).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Current layout name, as registered (letter case included) |
| `newName` | string | Yes | New layout name (the rules of [`create_layout`](#create_layout)) |
| `dryRun` | boolean | No | Report the references the rename would update and the files it would write, and write nothing (default: false) |
| `force` | boolean | No | Rename even when event sheets that could not be parsed possibly name the layout, or timeline files that could not be read or parsed possibly start on it (they are NOT updated). Default: false |

The rename updates what names the layout, matching names ignoring case as the editor compares layout names (in Construct 3 r506-2, Free edition, renaming a layout in the Project Bar changed the Go to layout parameters, the startup layout and the timelines' `startOnLayout`, and left a Go to layout (by name) string, a longer string and a variable value that held the name):
- **`"layout"` parameters** of conditions and actions in every event sheet that are the layout's name as the editor saves it, the bare name and not a string expression (`"layout": "Level 2"`, System *Go to layout*), get the new name. Only System conditions and actions are rewritten: a `"layout"` parameter of another object's condition or action (a custom function or action, a plugin) is listed in `possibleReferences`.
- **Timelines** whose `startOnLayout` is the layout get the new name (the old content of each timeline file is kept as `.bak`; a timeline the editor saved during the call is left as it is and the rename is refused).
- **`project.c3proj`**: the layout's entry keeps its folder and its position, and the startup layout (`firstLayout`, also in `properties` when the file holds it there) stays the startup layout under its new name.
- **The file** is written as `<new name>.json` in the same folder, with its `"name"` changed and its SID kept; the old file is deleted and kept as `.bak` (`backupFile`). The layout's `eventSheet` binding is not changed.
- **The editor's view state** is moved to the new name (`viewStateMoved`): `<name>.uistate.json` beside the layout's file and `layouts/uistate/<folders>/<name>.instancesBar.json` (the Instances Bar's folders). It holds view settings only, so it is moved last and a failure is a warning: a file whose new name holds other content is left as it is.

Other strings that contain the layout's name may name the layout or something else of that name, so they are never changed: a warning lists them and `possibleReferences` holds each one: string literals in other parameters, as part of a longer expression or as a function call argument (*Go to layout (by name)*, `LayoutName = "Level 2"`; the `"layout"` parameter of a `...-by-name` action is an expression, never rewritten; `kind` `string literal`), quoted strings in script lines of events (`kind` `script`), initial values of event variables and function parameters that are the name (`kind` `variable value`), instance variable values of layout instances that are the name (`kind` `instance variable`, with the instance's `uid`), and lines of project script files that hold the name as a string (`kind` `script file`, `in` the script's path). A script file that cannot be read is named in a warning. Layouts that could not be parsed are not searched for instance variable values, and the call does not say so.

Refused, changing nothing (the message ends "Nothing was changed."): a layout that is not registered or is given in another letter case than registered (the error gives the registered name); a layout whose own file does not exist or could not be parsed (rename it in the Construct 3 editor); a `newName` that is not a valid name, starts or ends with a space, is the layout's own name, differs from it only in letter case (on Windows and macOS both names are the same file: rename it to another name first) or is another layout's name ignoring case; a file for the new name that already exists in the layout's folder and is not one a stopped rename of this layout left (below).

Event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched as text for the layout's name: a match, or such a sheet that cannot be read at all, refuses the rename (`"success": false`, `"action": "rename_blocked"`, `message`, `references` and `unscannedFiles`; nothing changed). So does a timeline file that cannot be read or parsed, or a timeline registered in a folder the timeline tools cannot resolve (it may start on the layout). With `force: true` it goes ahead, and a warning names those files, which are NOT updated.

The event sheets that name the layout are written first, then the layout under its new name, then `project.c3proj`, then the timelines, then the old file is deleted (the last write the rollback covers), then the view state is moved. When a write fails, what the call wrote is put back; a file another write changed after the call wrote it (a save in the editor) is left as it is and named with its `.bak`, and a new file whose own write could not be confirmed is left and named. When a file the call is about to write changed on disk during the call, the write is refused, the file keeps that change, and what the call wrote before is put back.

Running the same call again finishes a rename that stopped midway (the server process ended): references already pointed at the new name are not found again; a file for the new name that holds the layout's SID and the new name, and is not registered, is written over; and when the project registers the new name already while the old file itself is still there with the same SID, the call does what is left (points the references and timelines that still name the old name at the new one, deletes the old file, moves the view state) and says so with `"stoppedRun": true` and a warning. A rename deletes the old file as its last write, so the same call after a finished rename answers that the name is not found and changes nothing.

Returns `{ success, entity (the new name), category: "layout", action: "renamed", previousName, references, possibleReferences?, filesWritten, fileDeleted, backupFile?, viewStateMoved?, stoppedRun?, warnings?, unscannedFiles? }`. `references` has one entry per place that was updated: `in` (the file, project-relative), `kind` (`layout parameter` with `path` (the event's JSON path), `ace` and `parameter`; `firstLayout`, `in` `project.c3proj`; or `startOnLayout`, `in` the timeline file) and `value` (the name as saved); `filesWritten` lists project-relative paths; `viewStateMoved` lists `{ from, to }`. With `dryRun: true` nothing is written: `action: "would_rename"`, `newName`, `references`, `possibleReferences?`, `filesToWrite`, `fileToDelete`, `stoppedRun?`, and the same warnings worded as what would happen.

### `update_layout`

Update layout properties (event sheet binding, dimensions).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to update |
| `eventSheet` | string | No | New event sheet binding (validated for existence) |
| `width` | number | No | New layout width in pixels |
| `height` | number | No | New layout height in pixels |

At least one parameter must be provided.

### `add_layer`

Add a new top-level layer to a layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout to add the layer to |
| `layerName` | string | Yes | New layer name, different from every layer of the layout (sub-layers included) ignoring case, as the editor compares layer names |
| `index` | number | No | Insert position (0 = bottom; default: on top) |
| `isInitiallyVisible` | boolean | No | Starts visible (default: true) |
| `isTransparent` | boolean | No | Transparent background (default: true) |
| `parallaxX` | number | No | Horizontal parallax rate (default: 1) |
| `parallaxY` | number | No | Vertical parallax rate (default: 1) |
| `blendMode` | enum | No | `"normal"` (default), `"additive"`, `"xor"`, `"copy"`, `"destination-over"`, `"source-in"`, `"destination-in"`, `"source-out"`, `"destination-out"`, `"source-atop"`, `"destination-atop"` |

A name used by another layer of the layout (sub-layers included) is refused, also when it differs only in case: the editor refuses such a layer name and cannot load a layout with two of them.

### `update_layer`

Update properties of an existing layer or sub-layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer or sub-layer to update, by name (a sub-layer also by its path, e.g. `"Main > HUD"`, which picks one of several layers with the same name) |
| `newName` | string | No | Rename the layer (must differ from the other layers of the layout, sub-layers included, ignoring case; changing the case of the layer's own name is fine) |
| `updateReferences` | boolean | No | With `newName`: point the event parameters that name the layer at the new name (default: true; see below) |
| `isInitiallyVisible` | boolean | No | Initial visibility |
| `isInitiallyInteractive` | boolean | No | Initial interactivity |
| `isTransparent` | boolean | No | Transparency |
| `parallaxX` | number | No | Horizontal parallax rate |
| `parallaxY` | number | No | Vertical parallax rate |
| `blendMode` | enum | No | Same values as `add_layer` |
| `scaleRate` | number | No | Scale rate (parallax zoom) |
| `zElevation` | number | No | Z elevation for 3D layering |

At least one property must be provided. A new name used by another layer of the layout (sub-layers included), also one that differs only in case, is refused; changing only the case of the layer's own name is allowed.

**Events that name the layer.** Conditions and actions name a layer in their `"layer"` parameter as a string expression (`"layer": "\"HUD\""`), and layer expressions take one too (`LayerScale("HUD")`); the editor looks layer names up ignoring case, and a layer parameter names a layer of whatever layout runs the event sheet. On a rename, every event sheet is searched (events, groups, function blocks and sub-events):
- A `"layer"` parameter whose whole expression is the quoted old name, ignoring case, is pointed at the new name (a quote in the name is written as two quotes), and a warning lists them. Not when `updateReferences` is `false`, or when another layout has a layer of the old name (ignoring case) or a layout the reader could not parse names it (see [Files the server could not parse](#mutation-tools)): a layer parameter may name that layer, so they are listed in a warning instead
- Any other string literal naming the layer (in another parameter, as part of a longer expression, as a function call argument, in a script) may name the layer or something else of the same name, such as an animation or a text: a warning lists them and they are never changed
- Event sheets the reader could not parse are searched as text for the old name; a match, or one that cannot be read, is named in a warning (`unscannedFiles`)

A rename that only changes the letter case (`Main` to `MAIN`) breaks no event, since the editor looks layer names up ignoring case: the event sheets are not searched or written.

The layout is written first, then the event sheets; if one fails, everything written is restored from its backup, except a file saved again in the editor meanwhile, which is left as it is and named in the error.

### `rename_layer`

Rename a layer in one or more layouts in one call (#ISSUE). In each layout the layer is found as [`update_layer`](#update_layer) finds it (its exact name, or a sub-layer by its path such as `"Main > HUD"`), or else the layer whose name differs only in letter case. The new name must not match another layer of the layout, sub-layers included, ignoring case. Every layout is read and checked before anything is written; a refusal changes nothing.

The `"layer"` parameters of conditions and actions whose whole expression is the quoted old name (ignoring case) name a layer of whatever layout runs the event sheet. They are pointed at the new name only when every layout with a layer of the old name is in `layoutNames`; while another layout has one (or a layout file the server could not parse names the old name), they are listed in a warning and not changed, as with `update_layer`. Other strings that name the layer (`LayerScale("Main")`, scripts, function call arguments) are listed, never changed. A rename that only changes the letter case changes no event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutNames` | string[] | Yes | 1 to 200 layouts; each is renamed once, also when listed twice or in another letter case |
| `layerName` | string | Yes | Current layer name, or a sub-layer path |
| `newName` | string | Yes | New layer name |
| `updateReferences` | boolean | No | Default `true`; `false` lists the parameters instead of changing them |
| `dryRun` | boolean | No | Default `false`; `true` returns `wouldWrite` and the warnings and writes nothing |

Returns `{ success, entity, category: "layer", action: "renamed", newName, layouts, filesWritten, warnings?, unscannedFiles? }`; with `dryRun`, `action: "rename_preview"`, `dryRun: true` and `wouldWrite` instead of `filesWritten`. A layout whose layer already has the new name is left out of `layouts`. The layouts are written first, then the event sheets; when a write fails, the files the call wrote are rolled back, except a file another write changed since (a save in the editor), which is left as it is and named with its `.bak`. When the first write fails, nothing had been written, and the error says so. This is a rollback of the failed call, not an undo a user can run later. If the server process stops during the call (for example out of memory), nothing is rolled back; the `.bak` files the call left are the way back. Before each layout or event sheet is replaced, the call copies it to a `.bak` file beside it (for example `layouts/Layout 1.json.bak`), which holds the file as it was before the call and stays after a successful call, until a later call writes that file again.

### `delete_layer`

Delete a layer or sub-layer from a layout, together with its sub-layers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer or sub-layer to delete, by name (a sub-layer also by its path, e.g. `"Main > HUD"`) |
| `force` | boolean | No | Delete even if the layer or its sub-layers hold instances; they are lost (default: false) |

**Behavior:**
- The last top-level layer of a layout cannot be deleted
- A layer whose own or sub-layers' instances are not empty returns `success: false`, `action: "delete_blocked"` with `instanceCount` (sub-layers included), and `subLayerCount` when the layer has sub-layers, unless `force=true`
- Hierarchy links of the layout's other instances to the deleted instances are removed, as for [`delete_instance_from_layout`](#delete_instance_from_layout): children on other layers stay without a parent, and parents on other layers no longer list the deleted children; a warning names their UIDs

### `reorder_layers`

Put the layers of one level of a layout in a new order (#ISSUE): the layout's own layers, or the sub-layers of `parentLayer`. `layerNames` lists every layer of that level once, with its exact name, first to last (index 0 first, as `add_layer` counts). Sub-layers and instances stay with their layer. A list that leaves out, repeats or adds a layer is refused and changes nothing; so is a level where two layers share a name. Returns `{ success, entity, category: "layout", action: "updated", order, parentLayer?, backupFile, warnings? }`; an order the level already has returns `action: "unchanged"` and writes nothing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerNames` | string[] | Yes | Every layer of the level, in the new order |
| `parentLayer` | string | No | Reorder this layer's sub-layers (a path such as `"Main > HUD"` is accepted) |

A `"layer"` parameter of a condition or action can name a layer by a number (any number literal, or an expression that may give one), which may count layers by their position; every such parameter that is not one quoted name is counted in a warning, which lists the first five and then a count, and is never changed. Event sheets the server could not parse are not searched for them, and a warning names the first five of them. The scan covers only `"layer"` parameters: layer numbers in expressions (such as `LayerOpacity(1)`) and in scripts are not searched.

When the write fails, the layout is put back, unless another write changed it since; the error then names it with its `.bak`.

### `move_layer`

Move a layer, with its sub-layers and instances, to another place in the same layout (#ISSUE): into the sub-layers of `parentLayer`, with `parentLayer: null` to the layout's own layers, or with `parentLayer` left out within its current level, at `index` (0 = first; default: last). A move into the layer itself or one of its sub-layers is refused. Returns `{ ..., action: "updated", layer, from: { parentLayer, index }, to: { parentLayer, index }, backupFile, warnings? }` (`parentLayer` null for the layout's own layers); a layer already in that place returns `action: "unchanged"`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer to move, or a sub-layer path |
| `parentLayer` | string \| null | No | Destination parent layer; null: the layout's own layers; omitted: its current level |
| `index` | number | No | Position at the destination once moved; refused when past the last place |

A `"layer"` parameter of a condition or action can name a layer by a number (any number literal, or an expression that may give one), which may count layers by their position; every such parameter that is not one quoted name is counted in a warning, which lists the first five and then a count, and is never changed. Event sheets the server could not parse are not searched for them, and a warning names the first five of them. The scan covers only `"layer"` parameters: layer numbers in expressions (such as `LayerOpacity(1)`) and in scripts are not searched.

When the write fails, the layout is put back, unless another write changed it since; the error then names it with its `.bak`.

### `update_instance`

Update a placed instance, found by UID on any layer or sub-layer or among the non-world instances (which ignore position, size, angle, Z elevation and color).

The Z elevation is written as `world.z`. Construct 3 r495.2 saves that key for instances (one editor-saved project, 47 of 47 instances), and r506-2 keeps it when it saves a project; layers keep `zElevation`. On a new instance `world.z` goes after `color`; a key renamed in place from `world.zElevation` keeps the old key's position. An instance keeps one Z key: one written by version 1.10.0 or older holds `world.zElevation`, which is moved to `world.z` in its place, and one with both keys loses `world.zElevation`; each with a warning that names the old value (#ISSUE). Construct 3 r506-2 reads `world.zElevation` and saves it as `world.z`; this was seen on one project that used the Normalized Z axis scale.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the instance |
| `x`, `y` | number | No | New position |
| `width`, `height` | number | No | New size |
| `angle` | number | No | New angle in radians |
| `zElevation` | number | No | New Z elevation, written as `world.z` |
| `color` | number[4] | No | RGBA tint `[r, g, b, a]`, values 0-1 |
| `showing` | boolean | No | Initial visibility |
| `locked` | boolean | No | Locked in the editor |
| `tags` | string | No | Comma-separated tags |
| `instanceVariables` | object | No | Values merged into the instance's existing `instanceVariables`; only instance variables of the instance's object type and its families |

At least one property must be provided. A name in `instanceVariables` that neither the instance's object type nor its families have is refused and nothing is changed (names are matched with their letter case; a name that differs only in case is pointed out), as is any value when the object type does not exist; a value of another type than its variable is written with a warning. When the object type's file could not be parsed, the names are not checked and a warning says so. A name that a family file which could not be parsed possibly declares (its text names the object type and the name, or it cannot be read at all) is written with a warning and `unscannedFiles`, as in [`add_instance_to_layout`](#add_instance_to_layout).

### `move_instance`

Move a placed instance to another layer or sub-layer of its layout, to another place in its layer's instances, or both (#ISSUE). A layer keeps its instances in an array: `position` counts in it, from `"first"` to `"last"`. With `afterUid` or `beforeUid` the instance goes right after or right before that instance of the destination layer. Without a position, an instance that changes layer goes last. Refused, changing nothing: a call with nothing to do (no `toLayer` and no position), an anchor that is the instance itself, a UID the layout does not have, a non-world instance, a UID or anchor that several instances of the layout have, an anchor on another layer, an index past the last place, two placements at once. Hierarchy links stay as they are. Returns `{ ..., action: "updated", uid, fromLayer, fromIndex, toLayer, toIndex, layerInstanceCount, backupFile }`; an instance already in that place returns `action: "unchanged"`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of an instance on a layer or sub-layer |
| `toLayer` | string | No | Destination layer or sub-layer path (default: its own layer) |
| `position` | `"first"` \| `"last"` \| number | No | Place in the destination's instances |
| `afterUid` / `beforeUid` | number | No | Right after / right before this instance |

When the write fails, the layout is put back, unless another write changed it since; the error then names it with its `.bak`.

### `move_instances`

Move many placed instances of one layout in one call and one write (#ISSUE). Each move takes a `uid` and the other arguments of [`move_instance`](#move_instance) and is applied as that tool applies it, in list order: a `position` or an anchor counts the instances as the moves before it left them, and an anchor may be an instance an earlier move put on the destination layer. Every move is checked and applied to the layout in memory first. When one is refused, for any reason `move_instance` refuses a call or because its arguments are (two placements, nothing to do, a place next to itself), or when applying it throws, nothing is changed and the message names the move by its 0-based index and ends with "Nothing was changed." (for example `Item 1: Instance 5 is not on the destination layer "Main": ... Nothing was changed.`); the first refusal in list order is the one reported. The layout name must be given as registered, in that letter case; a layout file that cannot be read is refused too. Hierarchy links stay as they are.

When the moves leave the layout as it was, nothing is written and the result is `action: "unchanged"` (with `dryRun: true` when `dryRun` was given). Otherwise the layout is written once, with one backup, and the result is `{ ..., action: "updated", count, results, backupFile }`, where `results` has one entry per move: `{ index, uid, fromLayer, fromIndex, toLayer, toIndex, layerInstanceCount }`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name, as registered, in that letter case |
| `moves` | array | Yes | 1 to 500 moves, applied in order; each has `uid` and the optional `toLayer`, `position`, `afterUid` and `beforeUid` of `move_instance` |
| `dryRun` | boolean | No | Check every move and apply it to the layout in memory, report the results, and write nothing (default: false) |

A dry run of moves that change the layout returns `action: "dry-run"` and `dryRun: true`. It checks the moves; the write's own checks run only when the layout is written. More than 500 moves are refused when the arguments are parsed. When the write fails, the layout is put back, unless another write changed it since; the error then names it with its `.bak`. `move_instance` rolls back a failed write in the same way.

### `delete_instance_from_layout`

Remove a placed instance by UID from the layout's layers and sub-layers or its non-world instances.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the instance to remove |

Hierarchy (scene graph) links to the instance are removed with it, since links name UIDs and a new instance can get the deleted one's UID: its children get `"parent-uid": null` and stay in the layout, on whatever layer they are (whether the editor deletes them with their parent is not verified, and detaching loses no instance), and its parent's `children` entry for it is removed (an emptied `children` array is removed, as the editor saves a parent without children). A warning names the UIDs of the instances changed. When another instance of the layout has the same UID (a duplicate UID, `duplicate-uid` in `validate_project`), the links naming it are left as they are, since they may mean that instance, and a warning says so; `delete_layer` does the same.

### `set_instance_parent`

Make a placed instance the hierarchy child of another one in the same layout, or with `parentUid: null` take it off its parent (#ISSUE). Both sides of the link are written, as the editor saves them: the child's `sceneGraphData` gets `"parent-uid"` and `flags`, the parent's lists `{ uid, flags }` in `children`; children may sit on another layer than their parent. A child with another parent is taken off that one, and any other instance that lists it as a child without the child naming it loses that entry (`staleEntries`, a one-sided link); the loop check follows both sides of every link. An instance without a `sceneGraphData` record gets one, placed before its `instanceFolderItem`, `showing`, `locked` or `world` key, whichever it has first. A record that gains children gets `children` after `uid` and before `flags` and `preview`, the order of a record saved by Construct 3 r506-2 (`parent-uid`, `uid`, `children`, `flags`, `preview`) and of upstream's three-cups record. Its `preview` copies the keys of a record already in the project (numbers 0, booleans false, other values as they are), or it gets none when the project has no record. An existing link keeps its flags, keys this server does not know included; given keys are written over them. A child with no hierarchy record, or a record without `flags`, gets the flags Construct 3 r495.2 saved for a record (`x`, `y`, `z`, `w`, `h`, `d`, `a` true; `o`, `v` false; `sm` `"normal"`; checked against one r495.2 editor-saved project), with the given keys written over them. Observed: a save by Construct 3 r506-2 added `de: true` to the flags of links written outside the editor. This server does not write `de`. Whether the editor keeps the flags this server writes, or rewrites them, has not been checked. Refused, changing nothing: a link that would close a loop, an instance that is its own parent, a UID that names no instance, a non-world instance, a UID that several instances of the layout have, a previous parent or other lister whose UID several instances share, and `flags` with `parentUid: null`. Taking off a child keeps its record with `"parent-uid": null`, and a parent left without children loses its `children` list. Returns `{ success, entity, category: "layout", action: "updated", childUid, parentUid, flags, previousParentUid?, staleEntries?, createdRecords?, backupFile, warnings? }` (`flags` only when a link is made); a link that exists already with these flags, or a child without a parent taken off, returns `action: "unchanged"`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `childUid` | number | Yes | The child |
| `parentUid` | number \| null | Yes | The parent, or null to take the child off its parent |
| `flags` | object | No | Booleans `x`, `y`, `z`, `w`, `h`, `a`, `o`, `v`, `d` and the string `sm`, as the layout file saves them; other keys given here are refused (a saved link's own unknown keys are kept) |

### `remove_instance_children`

Take every hierarchy child off a placed instance (#ISSUE): each child it lists that names it as its parent gets `"parent-uid": null` (`detached`), so does each instance that names it as its parent without being listed (`unlisted`: a one-sided link, which `validate_project` reports as `hierarchy-link`), and the instance loses its `children` list. Entries that name no instance of the layout (`missing`) or an instance with another parent or none (`otherParent`, whose own record stays as it is) are removed too and listed. Refused, changing nothing: a `parentUid` that names no instance, a `parentUid` several instances of the layout have, a non-world instance, and a child UID that several instances have. Returns `{ success, entity, category: "layout", action: "updated", parentUid, detached, unlisted?, missing?, otherParent?, backupFile, warnings? }`; an instance that neither lists children nor is named as a parent returns `action: "unchanged"`.

### `add_instances_to_layout`

Place many object instances on one layout in one call and one write. Each item is placed as [`add_instance_to_layout`](#add_instance_to_layout) places one, in list order. Every item is checked and placed in the layout in memory first; the layout file is written once, with one backup of it, only when every item was placed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout, as registered, in that letter case |
| `instances` | object[] | Yes | 1 to 500 items, placed in order. Each item takes the arguments of `add_instance_to_layout` without `layoutName`: `layerName`, `objectType`, `x`, `y`, `width`, `height`, `properties`, `angle`, `color`, `zElevation`, `originX`, `originY`, `instanceVariables`, `behaviors`, `tags`, `showing`, `locked` |
| `dryRun` | boolean | No | Place every item in memory, report the results and write nothing (default: false) |

**Limits.** At most 500 items per call (`MAX_BULK_INSTANCES`). The limit bounds the size of one request and of its result, since each item may carry up to 50KB of property values and 50KB of behavior values and the result lists every item; it does not bound a layout. A layout is bounded by the file size limit instead: the writer refuses a layout whose text as written (tab-indented, in the file's line endings, with its BOM) is over the limit in UTF-8 bytes, 10MB by default and set by `C3MCP_MAX_FILE_MB`, before anything is backed up or written, whatever the number of calls that grew it. The reader refuses a file over the same limit, so a layout these tools write can be read back. A dry run of a call whose layout would pass the limit is refused the same way. Construct 3 r506-2 (Free edition) opened and saved a layout of 9,975,982 bytes that had been written with `add_instance_to_layout` calls, one per instance: that is the size the editor was seen to open, not a check of these tools.

**Refusals.** When an item is refused, the call is refused as a whole before anything is written, and the message names the item by its 0-based index and ends with `Nothing was changed.`, for example `Item 1: Object type "Missing" does not exist. ... Nothing was changed.` The refusals are the single tool's. An error a step throws inside the item loop (for example the UID generator refusing because a project file could not be scanned) is refused the same way. A layout name that is not registered in that letter case is refused (`Did you mean "Layout 1"?`), as is a layout file that cannot be read or does not hold a layout object; an error before the first item becomes `The change was stopped before anything was written: ... Nothing was changed.` The UIDs and SIDs taken for the items of a refused call are not reused within one server run.

**Result.** `success`, `entity`, `category`, `action` (`"updated"`), `count`, `results` (for each item `index`, `objectType`, `uid`, `sid`), `backupFile`, `warnings` and `unscannedFiles`. A warning that several items gave is listed once with its items: `Item 2: ...`, `Items 0, 1: ...` (after five items, `Items 0, 1, 2, 3, 4 and 7 more: ...`). A family file the server could not parse that possibly lists an object type of an item as a member is listed once in `unscannedFiles`, with the names every item found in it. Each placement searches such a file again, so a call with many items costs more when a family file cannot be parsed.

**Dry run.** `dryRun: true` places the items in memory and runs the checks of the write (the JSON, the file's text style and the size limit), and writes nothing. The result has `action: "dry-run"`, `dryRun: true`, the `results` and a `message` saying so. The UIDs and SIDs in it were taken for the preview only: a call without `dryRun` gives new ones.

**Rollback.** If the write fails after it replaced the file, the file is put back from its backup, and the error says what is on disk. A file another write changed meanwhile (an editor save, say), or whose backup was replaced, is left as it is and named in the error, which then says the call was rolled back only in part. The single instance tools write without this rollback, as before; these three tools roll back a failed write.

### `update_instances`

Update many placed instances of one layout in one call and one write. Each item is applied as [`update_instance`](#update_instance) applies one, in list order: two items for one UID apply one after the other.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name, as registered, in that letter case |
| `updates` | object[] | Yes | 1 to 500 items. Each item takes the arguments of `update_instance` without `layoutName`: `uid`, `x`, `y`, `width`, `height`, `angle`, `zElevation`, `color`, `showing`, `locked`, `tags`, `instanceVariables` |
| `dryRun` | boolean | No | Apply every item in memory, report the results and write nothing (default: false) |

An item that names no property to change (only `uid`) is refused as `update_instance` refuses it, at its turn: the first refused item in list order is the one named. The limits, refusals, rollback and dry run are as for [`add_instances_to_layout`](#add_instances_to_layout), except that no UID or SID is taken, so the dry run's message says only that nothing was written. `results` lists `index` and `uid` for each item. An update that moves a Z elevation held as `world.zElevation` to `world.z` gives the single tool's warning, prefixed with its item.

### `delete_instances_from_layout`

Remove many placed instances of one layout by UID in one call and one write, as [`delete_instance_from_layout`](#delete_instance_from_layout) removes one, in list order.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name, as registered, in that letter case |
| `uids` | number[] | Yes | 1 to 500 UIDs of the instances to remove |
| `dryRun` | boolean | No | Remove every instance in memory, report the results and write nothing (default: false) |

A UID that is not in the layout is refused at its turn, and so is a UID listed twice (`Item 2: UID 5 is listed more than once.`). Hierarchy links to the removed instances are removed once for all of them, after the last one: a child of a removed instance gets `"parent-uid": null` and stays in the layout, and a removed child is taken out of its parent's `children`, as for the single tool. For a chain of parent, child and grandchild, removing the parent and the child gives one warning, which names the grandchild (it stays, without a parent), and none about the removed child. A hierarchy warning is given only when a link changed, and it is not prefixed with an item. `results` lists `index`, `uid` and `objectType` for each item, and the warnings say where each was removed from (`Item 0: Removed instance of "Sprite" (UID 5) from layer "Main".`; an instance with no type name gets none). The limits, refusals, rollback and dry run are as for [`add_instances_to_layout`](#add_instances_to_layout), except that no UID or SID is taken, so the dry run's message says only that nothing was written.

### `get_tilemap_data`

Read the painted tiles of a placed Tilemap instance, stored in the instance's `ownData.tilemapData`. A read tool: it changes nothing, so its refusals do not end with "Nothing was changed.".

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the Tilemap instance |
| `region` | object | No | Cell rectangle `{ x, y, width, height }` to return; required when the tilemap has more than 10,000 cells |

The result holds `layoutName`, `uid`, `objectType`, `width` and `height` (the grid, in cells), `tileWidth` and `tileHeight`, `tilesetTileCount` (when the object type's image size is known: the tiles that fit in it after the tile offsets and spacing), `emptyCells` (empty cells of the whole map, not only of the region), `region`, `rows`, and `warnings`. `rows[y][x]` is `null` for an empty cell, a tile index (the first tile of the tileset is 0, as the Tilemap Bar numbers it in Construct 3 r506-2, Free edition) for a plain tile, or `{ tile, flipX, flipY, flipDiagonal }` for a flipped one. Tile width and height come from the instance's `properties` or `ownData` (default 32). An instance with no tile data shows an empty grid sized from the instance (instance size divided by tile size, rounded up), with a warning.

Refused with an error:
- a layout name that is not registered exactly (a name that differs only in letter case is answered with *Did you mean* and the registered spelling), or an unknown layout;
- an instance that is not in the layout, a UID used by more than one instance of the layout (`duplicate-uid` in `validate_project`), or an instance of an object type whose plugin is not `Tilemap`; an object type file that cannot be read;
- an instance whose `ownData` or `ownData.tilemapData` is present but not an object;
- an invalid tile size, tile data that cannot be decoded (malformed token or a cell count that does not match the size), and a bare instance whose size gives a grid over the 4,000,000-cell limit of a tilemap;
- a tilemap over 10,000 cells without a `region`, a `region` over 10,000 cells, or a `region` that extends past the map.

### `set_tilemap_tiles`

Paint, flip or erase single cells of a placed Tilemap instance, or fill a rectangle; all other cells are kept. The instance's size is not changed. The layout is written once.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the Tilemap instance |
| `tiles` | object[] | No | Up to 250,000 cells `{ x, y, value }`, applied in order |
| `fill` | object | No | Rectangle `{ x, y, width, height, value }`, applied before `tiles` |

At least one of `tiles` and `fill` must be given. `value` is `null` (erase), a tile index from 0, or `{ tile, flipX, flipY, flipDiagonal }` with the flags optional. Rotations are clockwise (as the Tilemap Bar of Construct 3 r506-2, Free edition counts them): 90 degrees is `flipX` + `flipDiagonal`, 180 degrees is `flipX` + `flipY`, 270 degrees is `flipY` + `flipDiagonal`. A cell with no flag set is stored as its plain index. A tile index is at most 9007199254740990 (the schema refuses a larger one in the request; a larger stored one, with a paint on the same map, is refused by the tool).

An instance with no tile data gets a grid sized from the instance (instance size divided by tile size, rounded up), with a warning. A tile index past the end of the tileset (when its size is known) is written with a warning. The other keys of `ownData.tilemapData` are kept; its `width`, `height`, `max-width` and `max-height` are set to the grid size. `tile-width`, `tile-height`, `tile-x-offset`, `tile-y-offset`, `tile-x-spacing` and `tile-y-spacing` are copied from the instance's `properties` into `ownData` when `ownData` lacks them, and never replaced. On success the result is a `WriteResult` with `category: "layout"`, `action: "updated"`, `entity: "<layout>/<uid>"` and `backupFile`, the absolute path of the layout's `.bak`.

Refused before anything is written, with the ending "Nothing was changed.":
- neither `tiles` nor `fill`, a `fill` over 250,000 cells, a `fill` or a cell outside the map, and a map with no cells;
- every refusal of [`get_tilemap_data`](#get_tilemap_data) that concerns the layout, the instance, `ownData`, `ownData.tilemapData`, the tile size, undecodable tile data and a grid over the cell limit;
- a tile index over the limit anywhere in the resulting grid;
- an error thrown by one of the checks, worded *The change was stopped before anything was written: ...*.

A layout file that Construct 3 saved after the server read it is refused, not overwritten: the text says `layouts/<name>.json was changed on disk after this server read it ... It was not written, so that change is kept. Run the tool again: it reads the file as it is now.`. When the write fails after the layout was replaced (for example the read-back fails), the layout is rolled back and the error says *The call was rolled back: layouts/<name>.json is as before the call.*; if it cannot be put back, the error names the file and its `.bak`.

### `set_tilemap_data`

Replace all tile data of a placed Tilemap instance with `rows[y][x]`. The grid size becomes the size of `rows`. The layout is written once.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the Tilemap instance |
| `rows` | array | Yes | `rows[y][x]` of `null`, a tile index, or `{ tile, flipX, flipY, flipDiagonal }`; every row the same length, at most 250,000 cells |
| `resizeInstance` | boolean | No | Set the instance size to columns x tile width by rows x tile height (default: true) |

The previous tile data is replaced, also when it cannot be decoded. With `resizeInstance: false` the instance size is kept, and a warning names the cells the instance covers when they differ from the grid. A tile index past the end of the tileset (when its size is known) is written with a warning. Tile keys and `max-width` and `max-height` are written as for [`set_tilemap_tiles`](#set_tilemap_tiles), and the result is the same `WriteResult`.

Refused before anything is written, with the ending "Nothing was changed.": an empty first row, a grid over 250,000 cells, a row of another length than the first, a cell that is not `null`, a non-negative integer or an object with `tile` and boolean flags (an unknown key is refused), a tile index over 9007199254740990, and the refusals of `set_tilemap_tiles` that concern the layout, the instance and its `ownData`. A stale layout and a failed write end as described for `set_tilemap_tiles`.

**Editor behavior (Construct 3 r506-2, Free edition).** A layout written by these tools was opened in the editor: it drew every cell as written (plain, mirrored, flipped vertically, rotated), and the saved layout held the same `tilemapData.data` strings byte for byte. A cell written as `flipX` + `flipDiagonal` showed as a rotation of 90 degrees clockwise, the same picture as the cell the editor wrote when its Tilemap Bar rotated a tile clockwise once; the editor wrote 180 degrees as `flipX` + `flipY` and 270 degrees as `flipY` + `flipDiagonal`. Rotating anticlockwise was not tried. On an instance 64 x 32 with a 3 x 3 grid (`resizeInstance: false`) the editor drew the 3 x 2 cells of the grid that lie inside the 4 x 2 area the instance covers, not the third row, and kept both the instance size and the 3 x 3 data when it saved. When it saved a Tilemap instance written by these tools it also changed `world.originX` and `world.originY` from 0.5 to 0 and added `tile-x-offset`, `tile-y-offset`, `tile-x-spacing` and `tile-y-spacing` (0) to `ownData`, and `drawing-mode`, `tile-x-drawing-offset`, `tile-y-drawing-offset` and the four offset and spacing keys to `properties`. A Tilemap instance painted in the editor, and one the editor created itself, saved with `tile-width`, `tile-height`, `tile-x-offset`, `tile-y-offset`, `tile-x-spacing` and `tile-y-spacing` in `ownData` and `max-width` and `max-height` in `tilemapData`. The editor does not re-read a layout the server writes while the project is open (see the editor reload note).

### `list_tilemap_brushes`

List the editor brushes stored for a Tilemap object type. A read tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |

The result holds `objectName`, `file` (the brush file's project-relative path), `fileExists`, `brushes` (each `{ index, name, type, size }`; `size` is columns x rows, `4x4` for `auto16`, `8x6` for `auto47`, and the brush's `width` x `height` for a `patch`, or `unknown`), `count` and `warnings`. An object type without a brush file lists no brushes. An object type whose plugin is not `Tilemap` is listed anyway, with a warning.

**Where the brush file is.** A Tilemap object type's brushes are stored outside its object file, in `tilemapBrushes/objectTypes/<its project-bar folders>/<name>.brush.json`, one folder for each folder of the object type's path in the project bar (so `Tiles` is `tilemapBrushes/objectTypes/Tiles.brush.json` and `Walls` in the folders `Scenery/Inner` is `tilemapBrushes/objectTypes/Scenery/Inner/Walls.brush.json`). The tools use the file of that name, ignoring letter case, in the object type's own folder. A brush file named after the object type in another folder below `tilemapBrushes/` is not used: the read tool lists it in a warning, and a write tool refuses while the object type's own folder has none, since the object type would get two brush files. The search below `tilemapBrushes/` stops at 20,000 entries and 8 folder levels or when a folder cannot be read; while it is incomplete and the own folder has no file, the read tool warns that another file may exist and a write tool refuses.

Refused with an error: an object name that is not registered exactly (a name that differs only in letter case is answered with *Did you mean* and the registered spelling), an object type file that cannot be read, and a brush file that cannot be read: not valid JSON, not an array, holding an entry that is not an object with a string `name`, unreadable, or over 10MB. The message names the file by its project-relative path.

### `add_tilemap_brush`

Add a brush to a Tilemap object type's brush file, creating the file (and its folders) when it does not exist yet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |
| `name` | string | Yes | Brush name, unique within the object type |
| `type` | string | Yes | `auto16`, `auto47` or `patch` |
| `data` | any | Yes | The brush grid for the type (below) |

The grids the tools accept: `auto16`, 4 rows of 4 cells; `auto47`, 6 rows of 8 cells; `patch`, `{ width, height, data }` with `width` and `height` from 1 to 256 and `data` holding `height` rows of `width` cells. A cell is a tile index (a non-negative integer), `null` for an empty cell, or an array of weighted alternatives `[{ index, probability }]` with a probability above 0. A new file is written compact (one line); an existing file keeps its indentation, line endings, trailing whitespace and BOM. The result is a `WriteResult` with `category: "tilemapbrush"`, `action: "created"`, `entity: "<object>/<brush>"` and `backupFile`, the absolute path of the file's `.bak` (none for a new file).

Brush names are compared exactly when a brush is looked up. A new name that differs from an existing one only in letter case is refused, and the error names the existing brush.

Refused before anything is written, with the ending "Nothing was changed.": an invalid name, a grid of the wrong size or with a bad cell, a name already used (also in another letter case), every refusal of [`list_tilemap_brushes`](#list_tilemap_brushes), and a brush file named after the object type in another folder or an incomplete search for one (see above).

A brush file that another program saved after the server read it is refused and left as it is: the text says `<file> was changed on disk after this server read it ... It was not written, so that change is kept. Run the tool again: it reads the file as it is now.`. When a write fails, the message says what the file holds: *Nothing was changed.* when it is as it was read and the call left nothing beside it, or that it is as it was read and this call's `.bak` or a folder it made for a new file is left; that it holds the new list although the write was not confirmed, that it is missing or cannot be read, or that it is not as it was before the call, each with where its state from before the call is (the file's own `.bak`, checked, "it did not exist before the call", or "the state from before the call is not known").

### `update_tilemap_brush`

Rename a brush, change its type, or replace its grid.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |
| `name` | string | Yes | Current brush name |
| `newName` | string | No | New brush name |
| `type` | string | No | New type; requires `data` |
| `data` | any | No | Replacement grid, checked against the brush's (new) type |

At least one of `newName`, `type` and `data` must be given. A call that leaves the brush list as it was returns `action: "unchanged"` and writes nothing. Otherwise the result is a `WriteResult` with `action: "updated"`.

Refused before anything is written, with the ending "Nothing was changed.": nothing to update, a `type` without `data`, an invalid `newName`, an object type without a brush file, an unknown brush (a name that differs only in letter case is answered with the registered spelling), a `newName` already used by another brush (also in another letter case), data that does not fit the type, and the refusals of `add_tilemap_brush`. A stale brush file and a failed write end as described there.

### `delete_tilemap_brush`

Delete a brush. The file is kept as an empty array when the last brush is removed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Tilemap object type name |
| `name` | string | Yes | Brush name to delete |

The result is a `WriteResult` with `action: "deleted"`. Refused before anything is written, with the ending "Nothing was changed.": an object type without a brush file, an unknown brush (a name that differs only in letter case is answered with the registered spelling), and the refusals of `add_tilemap_brush`. A stale brush file and a failed write end as described there.

**Editor behavior (Construct 3 r506-2, Free edition).** The Tilemap Bar listed the brushes of the files these tools wrote at the paths above: `auto16` and `patch` brushes with tile indices written as bare integers, for `Tiles` and for `Walls` in the folders `Scenery/Inner`, and brushes the editor created were saved to the same files. When the editor saved after brush editing it rewrote every cell of the brushes these tools had written as a weighted alternative `{ "index": N, "probability": 1 }`, and a brush created empty in the editor was saved as four rows of `null` cells. Whether an empty cell of a brush written by these tools stays `null` was not checked. The Tilemap Bar listed an `auto47` brush written by these tools (6 rows of 8); its grid was not opened in the brush editor. The editor does not re-read a brush file the server writes while the project is open (see the editor reload note).

### `update_project_metadata`

Update project-level metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Project name |
| `version` | string | No | Project version |
| `author` | string | No | Author name |
| `description` | string | No | Project description |

At least one parameter must be provided.

### `register_addon`

Add an addon to the project's `usedAddons`. Known Scirra plugins and behaviors are registered automatically by `create_object` and `update_object_properties`; effects are not, so register them with this tool. The ID is not checked: any ID is written, and afterwards `create_object` accepts objects of that plugin. Registering a third-party addon does not install it; add third-party addons in the editor.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` | Yes | Addon type |
| `id` | string | Yes | Addon ID (e.g. `"Sprite"`, `"Tween"`, `"hsladjust"`) |
| `name` | string | Yes | Display name |
| `author` | string | No | Author (default: `"Scirra"`) |
| `bundled` | boolean | No | Value of the entry's `bundled` flag (default: false) |

An addon that is already registered returns `action: "already_registered"` and nothing is written. Otherwise `project.c3proj` is written through the project writer: backed up once per call (`project.c3proj.bak`), written through a temp file and read back. A `project.c3proj` saved in the editor during the call is merged with the new entry, not refused.

### `unregister_addon`

Remove an addon from `usedAddons`. Construct 3 errors on load if objects or behaviors still use it, and the server does not check for such uses (`force` only concerns built-ins); it only adds a warning. Afterwards `validate_project` reports leftover uses as `missing-addon` warnings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` | Yes | Addon type |
| `id` | string | Yes | Addon ID |
| `force` | boolean | No | Required to remove a known Scirra built-in plugin or behavior (default: false) |

The removal is written through the project writer: `project.c3proj` is backed up once per call (`project.c3proj.bak`), written through a temp file and read back. A `project.c3proj` saved in the editor during the call is merged with the removal, not refused.

### `list_effects`

List the effects of an object type, a family, a layout or one of its layers, in order, as saved, and the effect addons registered in the project (the effect ids `add_effect` accepts). Nothing is written.

The five effect tools (`list_effects`, `add_effect`, `update_effect`, `remove_effect` and `reorder_effects`) take the same target. Give exactly one of `objectName`, `familyName` and `layoutName`; with `layoutName`, `layerName` makes a layer of that layout the target instead of the layout. Names are matched with their letter case, as registered; an object type or family name that differs only in case is refused with a hint giving the registered spelling. `layerName` without `layoutName` is refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | One of the three | Object type that holds the effect, as registered |
| `familyName` | string | One of the three | Family that holds the effect, as registered |
| `layoutName` | string | One of the three | Layout that holds the effect, or whose layer does |
| `layerName` | string | No | With `layoutName`: the layer that holds the effect, by its name or, for a sub-layer, its path (`"Main > HUD"`), found as `update_layer` finds it |

Where the state of an effect is kept:

- An object type's or family's effect is an entry `{ effectId, name }` in the `effectTypes` of its file (the shape of the one family entry of an r495.2 editor-saved project and of the one object type entry Construct 3 r506-2 saved). Its state is on every placed instance of the object type, or of each member of the family, in the instance's `effects`, under the effect's name, as `{ isEnabled, parameters }`.
- A layer's or layout's effect is an entry `{ effectId, name, instance: { isEnabled, parameters } }` in the `effectTypes` of the layer or of the layout: the one layer entry of an r495.2 editor-saved project, and the one layout entry Construct 3 r506-2 saved.

The result is `{ target, effects, registeredEffectAddons }`. `target` is `{ kind, name }` for an object type, a family or a layout, and `{ kind: "layer", layout, layer }` for a layer; `effects` lists the entries in order; `registeredEffectAddons` lists the `usedAddons` entries of type `effect`.

### `add_effect`

Add an effect to an object type, a family, a layout or a layer, at the end of its stack or at `index`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName`, `familyName`, `layoutName`, `layerName` | string | See `list_effects` | The target, as in `list_effects` |
| `effectId` | string | Yes | Effect addon id, as registered in `usedAddons` (for example `"fogexponential"`) |
| `name` | string | No | Effect name: letters, digits, underscores and spaces (default: the effect id with its first letter in upper case, so `"fogexponential"` is named `"Fogexponential"`) |
| `parameters` | object | No | Parameter values, as the editor saves them for this effect (default: `{}`) |
| `isEnabled` | boolean | No | Whether the effect starts enabled (default: true) |
| `index` | integer | No | Position in the stack, from 0 (default: after the last effect) |

- `effectId` must be an entry of `usedAddons` of type `effect`. The tool never registers an addon, since the addon's files must be in the project: a refusal names `register_addon`.
- `name` passes the name check the other tools use, and must not match, ignoring case, a name the instances key their entries by: an effect of the holder; for an object type, also an effect of one of its families; for a family, an effect that any member gets from itself or from another family.
- `index` past the end of the stack is refused; `index` equal to the number of effects appends.
- `parameters` is optional. When it is left out, `{}` is written. Construct 3 r506-2 opened and kept such an entry for an object type's effect and for a layout's effect. A family's effect has the same entry shape as an object type's, and a layer's the same as a layout's; neither was opened in the editor, so the editor's handling of those two is not checked.
- An object type's or family's effect gets `{ isEnabled, parameters }` on every placed instance of the object type, or of each member of the family. Instances placed after the effect was added get none, because `add_instance_to_layout` does not write effect entries; `update_effect` refuses such an instance.
- A layer's or layout's effect writes only its own layout.

The result is `{ success, entity, category, action: "updated", effect, effects, backupFile }`, with `warnings` and `unscannedFiles` when there are some.

### `update_effect`

Change an effect's `isEnabled` and `parameters`. The parameters given are merged key by key into the existing ones; keys not given keep their values. Give `name` (the effect's name, letter case included) and at least one of `isEnabled` and `parameters`, or the call is refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | The effect's name, as registered on the holder |
| `isEnabled` | boolean | No | Enable or disable the effect |
| `parameters` | object | No | Parameter values to set, merged key by key |
| `instanceLayoutName` | string | Object type and family only | The layout of the instance to change |
| `instanceUid` | integer | Object type and family only | The UID of the instance to change |

- A layer's or layout's effect: its entry's `instance` is changed, and the layout is the only file written.
- An object type's or family's effect: the state is on one placed instance, so `instanceLayoutName` and `instanceUid` are required. The instance must be of the object type, or of one of the family's members, and must hold an entry for the effect; otherwise the call is refused and nothing is changed. An instance placed after the effect was added holds no entry, because `add_instance_to_layout` does not write effect entries, and the refusal says so.
- One layout is written, and the holder is not. A call that changes nothing returns `action: "unchanged"` and writes nothing.

The result is as for `add_effect`; for an object type or a family it also carries `instance: { layout, uid }`, the instance that changed.

### `remove_effect`

Remove an effect from the holder: its entry and, for an object type or a family, its entries on the placed instances. Parameters are the target, `name` (the effect's name, letter case included) and `force` (boolean, default false).

Before anything changes, the uses of the effect in the event sheets are checked. A use refuses the call unless `force` is given; with `force` the effect is removed and a warning lists the uses. Uses are never changed.

- Object type: actions and conditions on the object type that name the effect. This check, and the search of event sheets that could not be parsed, are skipped when one of the object type's families keeps an effect of that name: actions on the object type still reach the family's effect, so no use check runs, and the instance entries are kept (an entry a family still has is not removed).
- Family: actions and conditions on the family, and those on each member that keeps no effect of that name, of its own or from another family (a member's action reaches the family's effect without naming the family).
- Layer and layout: System actions and conditions that name an effect of that name. Which layer or layout a System action means is not checked, so each of them counts as a possible use.
- A use whose effect is given by an expression that is not a quoted name cannot be checked: it is listed in a warning, not counted as a use.
- Event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are searched as text: for an object type, for the effect's name together with the object type's name; for a family, for the effect's name together with the family's name or a member's name that keeps no effect of that name; for a layer or layout, for the effect's name alone. A match, or such a sheet that cannot be read at all, refuses without `force` as well (`unscannedFiles`).

A blocked removal returns `{ success: false, action: "remove_blocked", message, entity, category, references: { eventSheets, effectUses } }`, with `layer` for a layer target and `unscannedFiles` when event sheets that could not be parsed were searched as text (the field is absent when there are none). It changes nothing, and its message says so before the hint about `force`. Each removal that drops entries on placed instances, with or without `force`, names them in a warning: the first ten, then a count of the rest. Only the layouts' `.bak` files hold those entries afterwards. With `force`, the uses are listed in a warning and are not changed.

### `reorder_effects`

Put the effects of the holder in a new order. `names` lists every effect of the holder once, with its exact name (1 to 100 names). An order the holder already has is reported as `action: "unchanged"` and writes nothing.

- `names` must be a permutation of the holder's effects; any other list is refused, and the refusal gives the current order.
- A holder whose effects share a name is refused, and the refusal names them, since their entries cannot be told apart.
- For an object type or a family, the placed instances' entries of these effects are put in the new order among the places they hold. Entries of other effects, and of other families, stay where they are.
- The result carries `effects` (the new order) and no `effect` key, since the change is to the whole stack.

**Writes and rollback** (the four tools that write; `list_effects` writes nothing): each tool writes the layouts whose instance entries it changes first and the holder's file last. A call stopped between those writes leaves the holder as it was, and running the call again finishes the work: an entry already added is skipped, and an entry already gone is not removed again. A failed write is rolled back: the files the call wrote earlier are put back from their `.bak`, and a file that an editor saved after its failed write is left as it is and named with its `.bak`. A layer or layout target writes only its layout, and `update_effect` writes one layout. A process that is stopped in the middle of a call rolls nothing back. The check of `remove_effect` covers event sheets only, not scripts, timelines or flowcharts.

Each of the four write tools returns `success`, `entity`, `category` (`object`, `family`, `layout` or `layer`), `action` (`updated` or `unchanged`), `effects` and, except for `reorder_effects`, `effect`, with `backupFile` for a write and `layer` for a layer target. `list_effects` returns the fields listed in its section. `add_effect`, `remove_effect` and `reorder_effects` refuse a holder whose `effectTypes` is not a list, or holds an entry that is not a record with a string `name` (a hand edit; the editor does not save such a file), because they would drop an entry or write the wrong ones. The refusal names the entry and asks for it to be renamed or removed in the Construct 3 editor first. A refusal made before any write changes nothing. Most refusals end with "Nothing was changed."; a name that is not found, and an error raised while `remove_effect` reads the event sheets ("Error ...: <cause>"), do not say so. An instance's layout that `update_effect` cannot read is refused with the sentence.

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

### `rename_animation`

Rename an animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Current animation name |
| `newName` | string | Yes | New animation name |
| `force` | boolean | No | Rename even when layouts that could not be parsed possibly have instances that start with the animation (they are NOT updated). Default: false |

A new name that differs from another animation of the sprite (in any animation folder) only in case is refused (see [`add_animation_to_sprite`](#add_animation_to_sprite)); changing only the case of the animation's own name is allowed. `objectName` must be spelled exactly like the object's name: layout instances and event sheets name the object exactly, so a differently cased name (which Windows and macOS would still find the object file with) is refused.

The rename also does what the editor does when it renames an animation:
- **Frame image files** are renamed with it: for every frame, the file it uses, `images/<object>-<old name>-NNN.<ext>` (`.jpg` for a JPEG frame, `.png` otherwise), becomes `images/<object>-<new name>-NNN.<ext>`, all lowercase. A file whose name differs only in case or in Unicode normalization (e.g. `ä` stored decomposed, as macOS HFS+ lists names) is found too and gets the lowercase name. Frames, `sid` and `imageSpriteId`s stay as they are (the file name does not contain them). A frame without an image file is named in a warning. Files no frame uses (another extension, or an index past the last frame) keep their names.
- **Layout instances** of the object whose `initial-animation` is the old name get the new name (on every layer and sub-layer).

It is refused, and nothing is changed, when:
- a renamed image would replace an existing file in `images/` (also one whose name differs only in case);
- the new name has a character that cannot be part of a file name (see [`add_animation_to_sprite`](#add_animation_to_sprite));
- another animation of the object (in any animation folder) has frames and a name that differs from the old name only in case: both use the same image files, and renaming them would leave the other animation without images. Delete the duplicate first (`delete_animation` leaves the image files in place).

The image files are renamed first, then the object and the layouts are written; if a write fails, the files already written are put back as they were before the call, the file whose write failed is restored from its backup if it was already replaced (e.g. its post-write check failed), and the image files are renamed back. A file saved again in the editor after the call wrote it, or during its write, is left as it is and named in the error.

Strings in event sheets that name the old animation (e.g. `"Walk"` in *Set animation*) are not changed; a warning lists the event sheets with such parameters on the conditions and actions of the object and of the families it belongs to. Parameters that compute a name (e.g. `"Walk" & n`) are not counted.

Layouts and event sheets that could not be parsed (see [Files the server could not parse](#mutation-tools)) are not updated or counted. They are searched as text for the object's name together with the old animation name: a warning names each layout whose instances possibly still start with the old name, each such layout that cannot be read at all, and the event sheets that possibly name it; they are listed in `unscannedFiles`. Without `force`, a layout whose text names both (possibly instances that start with the old name, which the rename cannot update), or that cannot be read at all, refuses the rename (`"success": false`, `"action": "update_blocked"`, nothing changed); with `force: true` it goes ahead and the warnings name those layouts. Event sheets only get a warning.

### `delete_animation`

Delete an animation from a Sprite object; an animation in an animation folder is removed from that folder. The last animation cannot be deleted (animations in folders count). The animation's image files are left in `images/`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation to delete |

### `create_animation_folder`

Create an animation folder among a Sprite object's animations, with the folders above it that are not there yet (#ISSUE). The folder is not part of the frame image file names, so no image file changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `folderPath` | string | Yes | Folder path, `/`-separated (e.g. `"Combat/Melee"`); no empty segment, `.`, `..` or `\` |

Returns `foldersCreated` (the paths created, outermost first). A new folder is written as `{ "items": [], "subfolders": [], "name": ... }`, the key order of a new project-bar folder; the order the editor itself writes for animation folders was not checked. Refused, with nothing changed: an invalid `folderPath`; an object that is not found, is not a Sprite, or whose animations have no folder list; a path that exists already; a folder that differs from an existing sibling folder only in case (a rule of the server, as for `subfolder` paths; whether the editor allows such folders was not checked); a folder on the path that has no list of items or subfolders. If the object write fails after replacing the file, the file is restored from its backup while it holds that write's content; another write's content is left as it is.

### `move_animation_to_folder`

Move an animation of a Sprite object into an existing animation folder, or back to the top level of its animations (#ISSUE). The animation is found by its exact name in any folder, as by the other animation tools, and is added at the end of the target's list, so the order of the object's animations changes (moving one out and back puts it last); how the editor treats that order was not checked. No image file changes, and nothing in the animation changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation to move |
| `folderPath` | string \| null | No | Existing folder path, `/`-separated, compared exactly; left out, `null` or `""` for the top level |

Returns `fromFolder` and `toFolder` (`null` for the top level). A warning says when this move leaves no animation outside animation folders; how the editor treats such an object was not checked. Refused, with nothing changed: an invalid `folderPath`; an object that is not found, is not a Sprite, or has no animations structure; an animation that is not found; a folder that does not exist, or has no items list (the error names an existing folder whose name differs only in case from the requested one); and a move into the folder the animation is in (also the top level, when it is there). A failed object write is handled as for `create_animation_folder`.

### `add_frame_to_animation`

Add a blank frame (with a placeholder PNG in `images/`) to a Sprite animation. Like every image the tools write, the file is named as the editor names it: `<object>-<animation>-<frame, 3 digits>.png`, all lowercase, spaces kept (e.g. `hero-walk left-001.png`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `index` | number | No | Insert at this frame index, 0 to the frame count (default: append) |
| `width` | number | No | Frame width in pixels (default: first frame's width) |
| `height` | number | No | Frame height in pixels (default: first frame's height) |
| `duration` | number | No | Frame duration (default: 1) |

An `index` greater than the frame count is refused before anything is written.

**Frame image files move with their frames.** The editor names a frame's image after the frame's index (`<object>-<animation>-NNN.<ext>`), so inserting at `index` renames the image files of the frames from `index` on one index up, the last frame first (`hero-walk-002.png` → `hero-walk-003.png`, then `hero-walk-001.png` → `hero-walk-002.png`), and the placeholder takes the freed name. Each file keeps the extension of its frame's `fileType` (`.jpg` for a JPEG frame, `.png` otherwise; for another `fileType`, every file with the frame's name and a single extension moves, e.g. `.gif`). Names are matched ignoring case and Unicode normalization (as for `rename_animation`), and moved files get the lowercase name. The names are built from the object's name as stored in its file (so an `objectName` that reaches the file another way, e.g. `./Sprite`, finds the same images). `warnings` gives how many image files were renamed, with the first one, and names the frames after the index that have no image file.

No existing file is written over, also when appending: a file that no frame uses but has the name a moved image or the placeholder needs (e.g. an image left behind by `delete_frame_from_animation` of earlier versions, or a PNG next to a JPEG frame's `.jpg`) is renamed to `<file>.bak` (`<file>.1.bak`, … if that name is taken) and named in `warnings`. The image files are renamed first, then the placeholder and the object are written. The placeholder is written only to a name that holds no file when its write runs: a file that appeared there after the renames were planned (written by another program, or saved in the editor) refuses the write and is left as it is. If a step fails, the object file is restored from its backup only while it still holds the failed write's own content. The images are undone only when the object file, read again after the failure, holds the frames from before the call: then a placeholder this call wrote is removed (unless it changed on disk since) and the image files get their old names again. An image file whose old name is taken (for example by such a file) keeps its new name; the other files are renamed back, and the error lists what was rolled back and what was not, including which file holds the old name. When the object file holds this call's frames the images stay with them, and when it holds neither or cannot be read they stay as the call left them and the error says recovery is unresolved and where each file is. If the object write failed because another write replaced the file during it (the post-write check finds other valid JSON, e.g. from a tool outside the animation tools running in parallel), the file is read again instead: when it has this call's frames, that write was made on top of this one, the image files stay moved and the call succeeds with a warning to re-read the object; when it has the frames from before the call, the placeholder and the renames are undone to match it; otherwise the images stay, as above. The file is left as that write left it (no backup is restored over it). The call is refused, with nothing changed, if the renames cannot be done without replacing a file (e.g. two files whose names differ only in case on a case-sensitive file system).

### `update_frame`

Update per-frame properties of a Sprite animation frame.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |
| `width` | number | No | New frame width in pixels |
| `height` | number | No | New frame height in pixels |
| `duration` | number | No | New frame duration |
| `originX` | number | No | Horizontal origin 0-1 (0.5 = center) |
| `originY` | number | No | Vertical origin 0-1 (0.5 = center) |

### `delete_frame_from_animation`

Delete a frame by index. The last frame of an animation cannot be deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |

Like [`add_frame_to_animation`](#add_frame_to_animation), it keeps the frames and their image files together: the deleted frame's image file is renamed to `<file>.bak` (kept, not deleted), then the image files of the frames after it are renamed one index down, with the extension of their `fileType`. `warnings` gives how many image files were renamed, with the first one, names the kept file, and names the frames after it that have no image file. If the object write fails, the object file is restored from its backup if it was already replaced, and the image files get their old names again only when the object file, read again, holds the frames from before the call (an image file whose old name is taken keeps its new name, and the error says which file holds it); when another write replaced the object file during it, the file is kept as for `add_frame_to_animation` and the image files follow what it holds.

### `reorder_frames`

Put the frames of a Sprite animation in a new order (#ISSUE). Each frame keeps its properties and its `imageSpriteId`, and its image file moves with it: the editor names a frame's image after the frame's index (see [`add_frame_to_animation`](#add_frame_to_animation)), so the file of the frame that ends at index k is renamed to `<object>-<animation>-<k, 3 digits>.<ext>`, all lowercase, keeping the extension of its `fileType` (for another `fileType`, every file with the frame's name and a single extension moves).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `order` | number[] | Yes | The frames' indexes before the call, in their new order: `order[k]` is the frame that ends at index k. Every index from 0 to the frame count minus 1, once. Integers, from 1 to 1000 entries (longer lists or other values are refused when the arguments are checked) |

Refused before anything is written, with nothing changed: an animation with no frames, or whose object file has no frames list; an `order` that does not list every frame once, or that leaves every frame at its index; another animation of the object (in any animation folder) with frames and a name that differs only in case (both use the same image files, so moving them would give that animation other images); renames that cannot be done without replacing a file.

Files that take each other's names in a cycle (two that swap, or more) move through a temporary name, `<file>.reorder` (`<file>.1.reorder`, ... when taken). A file no frame uses under a name a moved image needs is renamed to `<file>.bak` first. `warnings` give how many image files were renamed, with the first ones, the files kept as `.bak`, and the frames that change index but have no image file. The image files are renamed first, then the object file is written; if the write fails, the object file is restored from its backup when it was already replaced and still holds that write's own content, then read again. The image files are renamed back only when it holds the frames from before the call (an image file whose old name is taken keeps its new name, and the error names the file in its way, and what was and was not rolled back); when it holds the new order (compared by `imageSpriteId` when every frame has its own, otherwise by each frame's whole content, and by each frame's image file extension) they stay, and after another write made on top of this one the call succeeds with a warning; when it holds neither or cannot be read they stay and the error says recovery is unresolved and where each file is. A frame that has no image file still reserves its new name: an unused file there is kept as `.bak`. A process stopped during the renames leaves the object file as it was and can leave image files under their new or `.reorder` names; restore `images/` from version control or a copy of the project.

### `reverse_frames`

Reverse the order of a Sprite animation's frames, with their image files, as [`reorder_frames`](#reorder_frames) does with the reversed order (#ISSUE). The middle frame of an odd count keeps its file. An animation with one frame is refused, with nothing changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |

### `duplicate_frame`

Insert a copy of a Sprite animation frame (#ISSUE): the frame's properties, a new `imageSpriteId` when the frame has one (as for a frame [`add_frame_to_animation`](#add_frame_to_animation) adds), and a copy of its image file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based index of the frame to copy |
| `index` | number | No | Insert the copy at this index, 0 to the frame count (default: right after the frame), as `add_frame_to_animation`'s `index` |

As for `add_frame_to_animation`, the image files of the frames from `index` on move one index up first, and a file no frame uses under a needed name is kept as `<file>.bak`; then each of the frame's files is copied, from its new name when it moved, to `<object>-<animation>-<index>.<ext>` with its own extension, only to a name that holds no file. A frame without an image file is copied without one, with a warning; every frame placed, the copy included, reserves its image name, so an unused file there is kept as `.bak` instead of being taken. Returns `index` (where the copy was inserted) and `imageSpriteId` (the copy's). If a copy or the object write fails, the object file is restored from its backup if it was already replaced and read again; when it holds the frames from before the call, every copy this call wrote is removed (a copy that cannot be confirmed as this call's is left and named) and the image files get their old names again; otherwise the images are kept as for [`reorder_frames`](#reorder_frames) (the whole frame list is compared). A frame index or `index` out of range is refused before anything is written, and so is a frame of an animation that shares its image files with another one whose name differs only in case, an animation with no frames or without a frames list in its object file, and an insert whose renames or copies cannot be done without replacing a file (for example two files whose names differ only in case on a case-sensitive file system); nothing is changed, and no `.bak` is made.

### `replace_sprite_image`

Replace a frame's image with real PNG data. The PNG is written to the frame's file in `images/`; the object JSON is backed up and rewritten. The editor picks the file's extension from the frame's `fileType`, so a frame stored in another format (e.g. JPEG, in `<name>.jpg`) gets `fileType: "image/png"` and the new `<name>.png`; the old file is left in `images/` and a warning names it. The image the frame held is backed up once per call as `<file>.bak` under the first free name (`<file>.1.bak`, ... when that name is taken), before the new PNG is written; it is never replaced.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |
| `pngBase64` | string | Yes | Base64-encoded PNG (checked for the PNG signature) |
| `width` | number | No | Image width in pixels; updates the frame metadata |
| `height` | number | No | Image height in pixels; updates the frame metadata |

### `replace_object_image`

Replace the single image of an object type that has one image instead of animations (#ISSUE). Any object type with an `image` record and no `animations` is accepted. The repository has checked this storage, `images/<object>.<ext>`, for a Tiled Background (see `src/construct3/object-images.ts`); no other single-image object type was checked, so where the editor keeps its image file is not known to this tool. For Sprite frames use [`replace_sprite_image`](#replace_sprite_image).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type name |
| `pngBase64` | string | Yes | Base64-encoded PNG (checked for the PNG signature, as `replace_sprite_image` does) |
| `width` | number | No | Image width in pixels; set in the image record only when given |
| `height` | number | No | Image height in pixels; set in the image record only when given |

The PNG is written to `images/<object>.png`, all lowercase, the object's name as stored in its file. An image under that name is kept first under the first free `.bak` name, as for `replace_sprite_image`. The image record then gets `fileType: "image/png"`, and its `width` and `height` each only when given. The object file is always written, also when its record did not change, so the write's check that the file did not change on disk since the call read it always runs. An image stored in another format (`images/<object>.jpg`) is left in `images/` and named in a warning.

Returns `imageFile`, `imageBackup` (absent when there was no image under the name) and `backupFile`. The image is written first, then the object file. If the object write fails, or is refused because the object file changed on disk during the call, the object file is restored from its backup when its write failed after replacing it and it still holds that write's own content (a file another write changed is left as it is, and the error names it and its `.bak`), and then read again. A record that this call left unchanged (no size given, and the record was PNG already) is the same before and after, so it counts as the one from before the call and a failed write puts the image back. The image is put back from its `.bak` (which stays), or removed when there was none, only when the object's image record (its stored name, format and size) is the one from before the call, and only while neither the image nor its `.bak` changed on disk since; otherwise both are left and named, and neither is called the old image. When the object file holds this call's image record, the new image stays (after another write made on top of this one the call succeeds with a warning); when it holds neither record or cannot be read, the new image stays and the error says recovery is unresolved. When the rollback cannot finish, the error leads with "The change was not rolled back" when nothing was undone, and with "The change was rolled back only in part" when something was. When the image write itself cannot be confirmed (another write landed right after it), the object file is not written, and the error names the file this call kept before writing the image (its `.bak`) when there was an image under the name.

### `create_timeline`

Create a timeline in `timelines/` (or `timelines/<subfolder>/`) and register it in `project.c3proj`, in the same project-bar folder. The name must not be used by another timeline, by a transition, or by an entry in a malformed nameless folder (see [`list_timelines`](#list_timelines)). Construct 3 compares timeline names exactly, but a name that differs only in case from a timeline in the same folder is refused: on Windows and macOS both would be one file. A case variant of a timeline in another folder, or of a transition, is created with a `warnings` entry. A `subfolder` folder that differs from an existing project-bar folder only in case is refused, and an existing file at the target path is never replaced (no backup is made on create).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name (unique) |
| `totalTime` | number | No | Total duration in seconds (default: 5) |
| `loop` | boolean | No | Loop the timeline (default: false) |
| `pingPong` | boolean | No | Ping-pong playback (default: false) |
| `repeatCount` | number | No | Repeat count when not looping (default: 1) |
| `startOnLayout` | string | No | Layout to auto-start on (default: `""` = none) |
| `ignoreSystemTimescale` | boolean | No | Ignore the system timescale (default: true) |
| `subfolder` | string | No | Project-bar folder within `timelines/`, `/`-separated (e.g. `"UI"` or `"UI/Menus"`). Not `"transitions"`: Construct 3 keeps transitions there |

### `update_timeline`

Update the settings of an existing timeline, in whichever `project.c3proj` folder it is. The file is backed up to `<file>.bak` and rewritten at the same path. Transitions are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |
| `totalTime` | number | No | New total duration in seconds |
| `loop` | boolean | No | Loop setting |
| `pingPong` | boolean | No | Ping-pong playback |
| `repeatCount` | number | No | Repeat count |
| `startOnLayout` | string | No | Auto-start layout (`""` = none) |
| `ignoreSystemTimescale` | boolean | No | Ignore the system timescale |
| `enabled` | boolean | No | Enable or disable the timeline |
| `ease` | string | No | Timeline-level ease: one of Construct's ease names (e.g. `"noease"`) or a custom ease. A name that is neither is written with a warning |
| `interpolationMode` | string | No | Timeline-level interpolation mode (e.g. `"default"`) |
| `resultMode` | string | No | Timeline-level result mode (e.g. `"default"`). The stored values of the numeric keyframes of instance tracks are recomputed for the new mode |
| `pathMode` | string | No | Timeline-level path mode (e.g. `"line"`) |
| `transformWithSceneGraph` | boolean | No | Apply the timeline's values through scene-graph parents |

At least one setting must be provided. A new `resultMode` is refused, changing nothing, in two cases: an untyped (older) instance track takes its result mode from the timeline, and changing it would leave the values stored in that track stale; or an instance track sits in a track folder, or has a property-track folder, with a result mode other than `default`, so the values the new mode would store are not known. The file is not written when it was saved on disk after the tool read it (see **Editing timelines and eases** below).

### `delete_timeline`

Delete a timeline: back up exactly the file that is deleted to `<file>.bak`, delete it, and remove the timeline from its folder in `project.c3proj`. Transitions are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name to delete |

Result: a `WriteResult` with `action: "deleted"` and `backupFile`, the path of the `.bak` file.

**Behavior change.** `delete_timeline` of a registered timeline whose file is missing removes the registration (`action: 'deregistered'`) instead of refusing; the result has no `backupFile` and a warning says that no file was removed. A file that exists but cannot be read, or that holds no tracks (a custom ease file, for example), is not deleted: the call is refused and `project.c3proj` is left as it is. A timeline file saved on disk after the tool read it is not deleted either. When the file cannot be deleted, or the registration cannot be removed after the delete, the tool returns an error, `project.c3proj` is unchanged, and the file is put back (a file it could not put back is named in the error).

**Editing timelines and eases.** The tools from `add_timeline_track` to `delete_ease` below edit timelines piece by piece. They share these rules.

- **Refusals change nothing.** A tool checks every argument and every file it will touch, builds all the new text, and only then writes. A deliberate refusal is an error result whose message ends once with "Nothing was changed."; no file changes, `.bak` files included. A timeline or ease name in another letter case than the registered one is refused, and the message names the registered one (`Did you mean "Move"?`). The read-only tools (`get_timeline_details`, `list_timeline_tracks`) answer the same lookups with a plain error that does not say this. An unexpected failure is reported as `Error <doing>: <message>`.
- **Messages name files relative to the project folder**, written with `/` (`timelines/Move.json`), never an absolute path. A file that cannot be read is named with the error code or the JSON parse text, not the file system's message.
- **The writes.** A tool that changes a timeline reads its one file, builds the new text and writes that file, backed up once per call as `<file>.bak` (`backupFile`, the path of the backup). An existing file keeps its text style (line endings and BOM); a new file follows the project's. When a timeline is saved, its `transitionsData` gets a copy of each custom ease the timeline uses, refreshed when the ease changed, and loses the copy of a project ease it no longer uses. A timeline or ease file that changed on disk after the tool read it is neither written nor deleted: the call is refused and the file keeps the change. A file another program created meanwhile is not overwritten, and the message says so. Run the tool again. `create_timeline`, `delete_timeline`, `create_ease`, `update_ease` and `delete_ease` write several files (the timeline or ease file, `project.c3proj`, and for `update_ease` and `delete_ease` the event sheets and timelines that hold a copy of the ease). When a later step fails, they put the earlier files back, and the error names a file they could not put back.
- **Results.** A write returns a `WriteResult` (`success`, `entity`, `category: "timeline"` or `"ease"`, `action`, `backupFile`, `warnings`) and the editor reload note.
- **What the tools leave alone.** The values of an untyped instance track (an older track with no `type`) are never rewritten: `add_timeline_track` for its instance, `add_property_track`, `set_keyframe` and a result mode change refuse it, and `remove_timeline_track`, `remove_property_track`, `delete_keyframe`, `move_timeline_track` and `update_track` flags still work. Property-track folders are read (the tools find property tracks inside them) but never created, renamed or deleted. A track or property-track folder with a result mode other than `default` is never given values: the tools that would compute them refuse. The timeline tools never read, change or delete transitions (custom eases); the ease tools do.
- **File shapes.** New tracks, keyframes, folders and eases are written in the key order of timelines saved by Construct 3 r495.2 (the shapes kept in the test fixtures).

### `add_timeline_track`

Add an instance track to a timeline: one world instance of a layout, with master keyframes at the given times and one property track per property. Each property track gets a keyframe at every master keyframe time, holding the instance's current value (a world property from the layout, an instance variable or plugin property from the instance). Value and audio tracks are added with [`add_value_track`](#add_value_track) and [`add_audio_track`](#add_audio_track).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `layoutName` | string | Yes | Layout that holds the instance |
| `instanceUid` | integer | Yes | UID of the world instance to animate |
| `properties` | string[] | No | Properties to animate, at most 32 (default: `["offsetX","offsetY"]`) |
| `keyframeTimes` | number[] | No | Master keyframe times in seconds, each within `[0, totalTime]`, 1 to 200 of them (default: `[0]`). Duplicates count once and the times are sorted |

`properties` takes the world properties `offsetX`, `offsetY`, `offsetZElevation`, `offsetWidth`, `offsetHeight`, `offsetScaleX`, `offsetScaleY`, `offsetAngle`, `offsetOpacity` and `offsetColor`, the names of the object type's instance variables, and the ids of the instance's plugin properties (such as `initial-animation`). Write `var:name` or `plugin:name` when a name is both. A name that matches none of them is refused before anything is written, whatever the name: Construct 3 r506-2 (Free edition, guest) refused to open a project with a property track named `angle` on a Text object type ("property track type 'undefined' is not valid", then "Failed to open project"), and no other unknown name was tried. The message names the known world properties. The property tracks are stored in a fixed order (world properties, then instance variables, then plugin properties) whatever order they are given in.

Result: `action: "track-added"`. Refused, with nothing written: a property name that matches no world property, instance variable or plugin property of the instance (the message names it and lists the world properties; when the object type file cannot be read it says so, also for a `var:` or `plugin:` name, since only world properties are then known), as well as the other refusals of this tool.

Refused, changing nothing: the layout is not registered (the message gives the registered spelling of a different letter case, or the nearest names) or its file cannot be read; the instance UID is not in the layout, or is not a world instance; the instance already has a track in the timeline (also an untyped track, or one in a track folder); the timeline's root track folder has a result mode other than `default`; a property is named twice, or a known property's current value cannot be read; a keyframe time lies outside `[0, totalTime]`.

### `remove_timeline_track`

Remove a track with all of its property tracks and keyframes: an instance track by `instanceUid` (an untyped track included) or a value or audio track by `trackName`, at the root or in a track folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | integer | One of the two | UID of the animated instance (instance tracks) |
| `trackName` | string | One of the two | Name of a value or audio track |

Result: `action: "track-removed"`. Refused: neither or both selectors given; no track for the UID (the message lists the tracked UIDs); no value or audio track of that name (the message lists the names).

### `add_property_track`

Add one property track to an existing instance track, with a keyframe holding the instance's current value at every master keyframe time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | integer | Yes | UID of the animated instance |
| `property` | string | Yes | Property to animate (names as for [`add_timeline_track`](#add_timeline_track)) |

Result: `action: "property-track-added"`. Refused: no track for the UID; the track is an untyped (older) track; a track folder or property-track folder holding the track has a result mode other than `default`; the instance is in no layout (when a layout could not be read, the message names it), or is not a world instance; the property name matches no world property, instance variable or plugin property of the instance (as for `add_timeline_track`); the property has a track already (also one in a property-track folder), or its current value cannot be read.

### `remove_property_track`

Remove one property track, and all of its keyframes, from an instance track (also from a property-track folder).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` | integer | Yes | UID of the animated instance |
| `property` | string | Yes | Property track to remove; `var:` or `plugin:` selects between tracks that share a name |

Result: `action: "property-track-removed"`. Refused: no track for the UID; no such property track (the message lists the ones present).

### `set_keyframe`

Create or update the master keyframe at a time on a track, and the per-property keyframes at that time. An instance track takes any animated property; a value track takes only `value`; an audio track has master keyframes only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` / `trackName` | integer / string | One of the two | The track, as for [`remove_timeline_track`](#remove_timeline_track) |
| `time` | number | Yes | Keyframe time in seconds, within `[0, totalTime]` |
| `values` | object | No | Per-property values, at most 32, e.g. `{ "offsetX": { "absolute": 400 }, "offsetOpacity": { "relative": -0.5 }, "tag": { "absolute": "done" } }` |
| `ease` | string | No | Master keyframe ease (a new keyframe gets `"default"`) |
| `enabled` | boolean | No | Master keyframe enabled flag |
| `tags` | string | No | Master keyframe tags |

Each entry of `values` has `absolute`, `relative` and `ease`. A number property takes `absolute` (the value) or `relative` (an offset from the instance's own value in its layout); the stored values follow the result mode in force. A string or boolean property, or an instance variable or plugin property of that type, takes `absolute`; `offsetColor` takes `absolute` as `[r, g, b, a]`, each 0 to 1. A property without a track gets one, and a warning lists the tracks created: they hold a keyframe only at the times set so far. A name that matches no world property, instance variable or plugin property does not get a new track: it is refused (see below). A track that already has such a name, for example one the editor saved, can still be set, and then needs both `absolute` and `relative` as numbers, which are stored as given. A value track takes `values.value.absolute` as a number and no `relative`; a keyframe is created only when `absolute` is given. A warning names an ease that is neither one of Construct's nor a custom ease of the project.

Result: `action: "keyframe-created"` when the track had no master keyframe at that time, otherwise `"keyframe-updated"`. Refused: a time outside `[0, totalTime]`; more than 32 properties; an untyped (older) track; values given for an audio track; a value track given another property, a `relative` value or a value that is not a number; a value of the wrong kind, or a number property given neither `absolute` nor `relative`; a property name that matches no world property, instance variable or plugin property and has no track yet (nothing is written; Construct 3 r506-2 Free edition, guest, refused to open a project with a property track named `angle` on a Text object type); the instance is in no layout (the message names a layout that could not be read); a folder with a non-default result mode.

### `delete_keyframe`

Delete the master keyframe at a time and every property keyframe at that time, or with `property` only that property's keyframe of an instance track.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` / `trackName` | integer / string | One of the two | The track, as for [`remove_timeline_track`](#remove_timeline_track) |
| `time` | number | Yes | Time of the keyframe, in seconds |
| `property` | string | No | Delete only this property track's keyframe of an instance track, leaving the master keyframe |

Result: `action: "keyframe-deleted"`, or `"property-keyframe-deleted"` with `property`. Refused: no master keyframe at that time (the message lists the times); the last master keyframe of a track (use `remove_timeline_track`); the keyframe at time 0 of an audio track; `property` given for a value or audio track; no such property track, or no keyframe on it at that time.

### `update_track`

Update the playback properties of one track. A value or audio track can also be renamed, and an audio track pointed at another registered audio file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` / `trackName` | integer / string | One of the two | The track, as for [`remove_timeline_track`](#remove_timeline_track) |
| `enabled` | boolean | No | Enable or disable the track |
| `ease` | string | No | Track ease name |
| `interpolationMode` | string | No | Track interpolation mode |
| `resultMode` | string | No | Track result mode (instance and audio tracks) |
| `pathMode` | string | No | Track path mode (instance tracks) |
| `initialVisibility` | boolean | No | Visibility when the timeline starts |
| `name` | string | No | New name of a value or audio track |
| `audioFile` | string | No | Audio track: registered sound or music file to play |
| `audioFolder` | `"sound"` \| `"music"` | No | Audio track: which folder holds `audioFile`, needed only when both do |
| `audioStartOffset` | number | No | Audio track: offset into the file, in seconds |
| `audioTag` | string | No | Audio track: tag given to the playing audio |

Result: `action: "track-updated"`. Refused: no update given; `resultMode` on a value track, or on an untyped (older) track, or under a folder with a non-default result mode; `pathMode` on a value or audio track; `name` on an instance track, or a name another value or audio track has, or a name Construct cannot use; an audio argument on a track that is not an audio track; an audio file that is not registered, or registered in both folders without `audioFolder`.

### `list_timeline_tracks`

Read-only. Summarize every track of a timeline.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |

Result: `{ timeline, tracks, count }`. Each track has `kind` (`instance-track`, `value-track`, `audio-track`, or `legacy-instance-track` for an untyped track), `folder` (`""` at the root), `enabled`, `keyframeTimes` and `propertyTracks` (`property`, `sourceType`, `folder`, `keyframeCount`). An instance track has `instanceUid` and `objectType`, a value or audio track has `name`, an audio track has `audioFile`, `audioType`, `audioStartOffset` and `audioTag`, and an untyped track has a `note`. Lookup failures are plain errors.

### `add_value_track`

Add a value track (a named number animated over time) with one keyframe per given time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `name` | string | Yes | Track name, unique among the timeline's value and audio tracks |
| `keyframes` | object[] | No | `{ time, value, ease? }`, 1 to 200 (default: one keyframe of value 0 at time 0) |
| `folder` | string | No | Track folder to put the track in (default: the root) |

Result: `action: "value-track-added"`; `warnings` names an ease that is neither one of Construct's nor a custom ease. Refused: a name Construct cannot use; a name another value or audio track has (also in a folder); a time given twice; a time outside `[0, totalTime]`; a folder that does not exist (the message lists the folders).

### `add_audio_track`

Add an audio track that plays a sound or music file registered in the project. The track holds a copy of the file's registration entry; `audioProjectFilePath` is written only when the project's export file structure is one the tool knows, and otherwise a warning says so.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `audioFile` | string | Yes | File name of a registered sound or music file, e.g. `"Theme.webm"` |
| `audioFolder` | `"sound"` \| `"music"` | No | Folder holding `audioFile`, needed only when both hold that name |
| `name` | string | No | Track name (default: `"Audio Track N"`, the next free number) |
| `audioStartOffset` | number | No | Offset into the file, in seconds (default: 0) |
| `audioTag` | string | No | Tag given to the playing audio (default: empty) |
| `keyframeTimes` | number[] | No | Master keyframe times in seconds (default: `[0]`) |
| `folder` | string | No | Track folder to put the track in (default: the root) |

Result: `action: "audio-track-added"` and `trackName`. Refused: the file is not registered in the project's sound or music files (import it in the editor first), or is registered in both without `audioFolder`; a name Construct cannot use, or one another value or audio track has; a time outside `[0, totalTime]`; keyframe times without 0; a folder that does not exist.

### `add_timeline_folder`

Create a track folder in a timeline.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `name` | string | Yes | Folder name, 1 to 200 characters, without `/` or control characters |
| `parentFolder` | string | No | Slash-separated path of the folder to create it in (default: the root) |

Result: `action: "folder-added"`. A folder inside another folder is written with a warning: how Construct stores a nested track folder is not known here. Refused: an invalid name; a parent folder that does not exist (the message lists the folders); a sibling folder of that name.

### `rename_timeline_folder`

Rename a track folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `folder` | string | Yes | Path of the folder to rename |
| `newName` | string | Yes | New folder name (same rules as `name` of `add_timeline_folder`) |

Result: `action: "folder-renamed"`. Refused: an invalid name; the root folder; a folder that does not exist; a sibling folder of the new name.

### `delete_timeline_folder`

Delete a track folder. Its tracks and subfolders move to the parent folder unless `deleteContents` is true.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `folder` | string | Yes | Path of the folder to delete |
| `deleteContents` | boolean | No | Also delete the tracks and subfolders inside it (default: false) |

Result: `action: "folder-deleted"`; a warning counts the items moved or deleted. Refused: the root folder; a folder that does not exist; without `deleteContents`, a subfolder whose name the parent folder already has, and a move that would change the result mode in force for an instance, audio or untyped track (a value track is exempt), as [`move_timeline_track`](#move_timeline_track) is. With `deleteContents` the result mode check does not apply, since the tracks are deleted with the folder.

### `move_timeline_track`

Move a track into a track folder, or back to the root with `folder: ""`. The track keeps all of its keyframes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline name |
| `instanceUid` / `trackName` | integer / string | One of the two | The track, as for [`remove_timeline_track`](#remove_timeline_track) |
| `folder` | string | Yes | Destination track folder |

Result: `action: "track-moved"`. Refused: the track is already there; the destination folder does not exist; a folder the track leaves or enters has a result mode other than `default` (a value track is exempt).

### `list_eases`

Read-only. List the project's custom eases, the timelines that use them and the event sheets whose ease parameters (such as the Tween ease) name them.

No parameters. Result: `{ eases, count, unreadableTimelines? }`. Each ease has `name`, `linear`, `purpose`, `points`, `usedBy` (timeline names) and `usedByEventSheets`. A registered ease whose file cannot be read has an `error` without a path instead of its points. `unreadableTimelines` names timelines that could not be opened, which are left out of `usedBy`.

### `create_ease`

Create a custom ease curve: a file in `timelines/transitions/` registered in the Transitions folder of `project.c3proj`. Timelines can then name it as an ease.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Ease name |
| `points` | object[] | Yes | Curve points, 2 to 50: `{ x, y, startHandle?, endHandle? }`, from (0,0) to (1,1); `x` is 0 to 1, `y` and the handle offsets -10 to 10 |
| `linear` | boolean | No | The `linear` flag (default: false) |

Result: `action: "created"`, `category: "ease"`; no `backupFile`, since the file is new. A curve with points between the ends is written with a warning to check it in the editor. If the registration fails, the new file is removed again. Refused: a name Construct cannot use; one of Construct's own ease names (compared ignoring letter case); a name already registered, or one that differs from a registered ease only in letter case; the name of a timeline; points that do not run from (0,0) to (1,1) with strictly increasing `x`, or that give the first point an incoming handle or the last point an outgoing handle; a file of that name that already exists on disk but is not registered.

### `update_ease`

Change a custom ease's points or `linear` flag, and refresh the copy of it in every timeline that uses it and in every event-sheet ease parameter that embeds it. Timelines that do not use the ease are not touched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Ease name |
| `points` | object[] | No | New curve points, as for `create_ease` |
| `linear` | boolean | No | New `linear` flag |

Result: `action: "updated"`, `backupFile` (the ease file's backup), `timelinesRefreshed` and `eventSheetsRefreshed`. The event sheets are written first, then the timelines, and the ease file last. It is refused, changing nothing, while a registered timeline or an event sheet cannot be read, because the copy in it could not be refreshed. Also refused: no update given; an ease that is not registered, or whose file cannot be read; invalid points.

### `delete_ease`

Delete a custom ease that no timeline uses: its registration, its file (kept as a `.bak`) and its editor-state file (`<name>.uistate.json`, also kept as a `.bak`). A timeline's stored copy of the ease is removed from timelines that no longer use it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Ease name |
| `force` | boolean | No | Delete although event sheets or script files mention the name, or cannot be read (default: false) |

Result: `action: "deleted"` and `backupFile`. Refused: an ease that is not registered; a timeline that cannot be opened; a timeline that uses the ease; unless `force` is set, an event sheet or script file that mentions the name as a whole word (a lexical search, which can report a name that is not an ease), or that cannot be read. With `force`, a warning says so and names the event sheets that still embed a copy of the ease. Files saved on disk after the tool read them (the ease file, its editor-state file, a timeline) are not deleted. A failed step puts the earlier ones back.

### Flowchart tools

A flowchart is `flowcharts/<name>.json` (`flowcharts/<folder>/.../<name>.json` in a Project Bar folder), registered in the `flowcharts` container of `project.c3proj` in the same folder, as a timeline is. The tools below share these rules:

- A name is accepted as registered, letter case included. A name in another letter case is refused with the registered name. `create_flowchart` refuses a name that differs only in case from an existing flowchart in any folder, and a `subfolder` that differs only in case from an existing Project Bar folder.
- A tool reads the file, changes it in memory and writes it back once, through a temp file, with the state from before the call kept as `<file>.bak` (once per call). A flowchart file that changed on disk after the call read it, for example because it was saved in the editor, is not overwritten: the error says so and the file keeps that change. The server does not make an open editor re-read the file (see the editor reload note).
- A refusal is given before anything is written and ends with *Nothing was changed.* A write refused because the file changed on disk says so in its own words: the file was not written, and the tool can be run again. An error before the first write says the change was stopped before anything was written. When a write fails, the error says what is on disk.
- Arguments a tool does not take are refused, also inside the `outputs` entries of `add_flowchart_node`. Positions and sizes must be finite numbers.
- A registration whose folder or name would put the file outside `flowcharts/` is not read, changed or deleted.
- The file keeps its line endings, trailing whitespace and BOM; a new file follows `project.c3proj`. Keys the tools do not model are kept.
- The tools never write the editor-state file `<name>.uistate.json`, except that `delete_flowchart` deletes it with the flowchart. In Construct 3 r506-2 (Free edition, guest) the editor wrote its own `<name>.uistate.json` for each flowchart when it saved.
- A flowchart file that is not an object with a list of `nodes` is refused.

Observed in Construct 3 r506-2 (Free edition, guest): the editor opened a project with two flowcharts made by these tools (one at the root, one in a Project Bar folder) without a dialog, listed both in the Project Bar, opened both, and saved them at the same paths with the values the tools wrote: node types, start and enabled flags, captions, outputs and their connections, `pnSIDs`, `poSIDs`, `nodeSIDs`, and the comment node's text and formatting. A comment body with one run of two spaces inside a line and one line break was kept byte for byte. Runs of three or more spaces, spaces at a line start or end and blank lines were not seen. The order in which Construct 3 runs the outputs of a node was not observed.

#### File format

The fields the tools read and write. In the same r506-2 (Free edition, guest) save, the nodes had the same set of keys, and the flowchart the same top-level keys, as the files the tools wrote:

| Field | Meaning |
|-------|---------|
| `sid`, `name`, `w`, `h` | Flowchart SID, name and canvas size (20000 x 20000 on a new flowchart) |
| `preset-nodes` | `{ items, subfolders }` preset-node folder tree |
| `nodes[].t` | Node type/title. Usually equal to `c`; empty on comment boxes |
| `nodes[].c` | Node caption. **Not** a color: node and output colors live in the sibling `<name>.uistate.json` |
| `nodes[].s` | Start node. The tools keep exactly one |
| `nodes[].e` | Enabled |
| `nodes[].ty` | Value type: `dictionary` or `comment` |
| `nodes[].n`, `fo`, `fs`, `fb`, `fi`, `fc` | Comment nodes only, after `prfnsid`: body as the editor's HTML (first line plain, later lines in `<div>`, blank lines `<div><br></div>`), font face, font size, bold, italic and `#rrggbb` font color. Comment nodes have no outputs or connections and `t: ""`; their `c` is a separate caption |
| `nodes[].pi` | Observed values 0, 1 and 2; meaning not determined |
| `nodes[].pr`, `prfsid`, `prfnsid` | Preset-node markers. Never taken from tool input: new nodes get `false`/`null`/`null` and existing nodes keep whatever they carry |
| `nodes[].pnSIDs`, `poSIDs` | Strictly parallel, one entry per incoming connection: `poSIDs[i]` is an output of the node `pnSIDs[i]` |
| `nodes[].nodeSIDs` | Distinct child node SIDs, in an order independent of the `outputs` array order |
| `nodes[].outputs[]` | `{ sid, cnSID, name, value, enable, default }`; `cnSID` is the connected node SID or `null` |

#### `create_flowchart`

Create an empty flowchart and register it in the same folder of `project.c3proj`, creating the `flowcharts` entry and the folders when they are missing. The file is written first and the registration second. The checks on the name and the folder are made again on the `project.c3proj` the registration is made in, so a name or folder saved in the editor after the first check is refused and nothing is registered. When the write of the file fails after the file was written, or the registration fails, the registration this call made is taken out again (a change saved in the editor meanwhile is kept) and the file is removed again once `project.c3proj` on disk does not register it; the error says so. A file that cannot be removed is named; a file that `project.c3proj` still registers, or whose registration cannot be checked, is kept and named. A folder the write made stays, empty, and the error names it. Refused before anything is written: an unsafe name or folder, a name that is registered already (a name registered in a folder without a name is refused with its own message), a name that differs only in case from a registered one, a folder that differs only in case from an existing one, a file already on disk at the path (also one whose name differs only in case), and a `project.c3proj` that changed on disk after the call read the version its checks used. When the Flowchart plugin is not in `usedAddons` the result carries a warning that a Flowchart object has to be added in the editor before the flowchart is used at run time. This tool does not register plugins. In Construct 3 r506-2 (Free edition, guest) the editor opened a project whose `usedAddons` held no Flowchart plugin and drew the nodes of both flowcharts; the project it saved listed no addons at all, so this does not show what it does with a Flowchart plugin entry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Flowchart name |
| `subfolder` | string | No | Slash-separated folder path under `flowcharts/`, created in both places |

#### `delete_flowchart`

Delete a flowchart: remove its registration from `project.c3proj`, then its file (kept as `<file>.bak`) and the editor-state file `<name>.uistate.json` beside it (also kept as `.bak`). Each file is deleted only if it is still in the state it had before the call began: a flowchart file or editor-state file saved in the editor during the call, or created where there was none, is kept (for the flowchart file the call is refused and the registration put back; for the editor-state file it is a warning). When the file cannot be deleted, a file that is gone is restored from its backup first and then the registration is put back at its place in its folder, on the `project.c3proj` as it is then (a change saved in the editor meanwhile is kept); a file that cannot be restored leaves the registration removed, so no registered name lacks its file, and the error names the backup. The error says what is on disk. A registered name whose file is missing loses its registration, with a warning. A failure to delete the editor-state file is a warning; the flowchart is gone. Refused before anything is changed when `project.c3proj` changed on disk after the call read it, and when the registration's folder or name would put the file outside `flowcharts/`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Flowchart name to delete |

#### `add_flowchart_node`

Add a node. Outputs are created unconnected; wire them with
`connect_flowchart_nodes`. When `isStart` is true the flag is cleared on every
other node, so that a flowchart has one start node (each flowchart the editor of
r506-2, Free edition, guest, saved had exactly one). The
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
| `commentText` | string | No | Comment body as plain text, escaped and stored as the editor's HTML (default: the caption). Runs of spaces become alternating `&nbsp;` and spaces starting with `&nbsp;`, ending in `&nbsp;` at a line end, and a lone space at a line start or end becomes `&nbsp;` |
| `commentHtml` | string | No | Comment body as HTML, stored unchanged; give this or `commentText` |
| `font`, `fontSize`, `bold`, `italic`, `fontColor` | string, number, boolean, boolean, `#rrggbb` | No | Comment formatting (`fo`, `fs`, `fb`, `fi`, `fc`). Missing values take the values most common in editor-saved flowcharts (Calibri, 36, bold, not italic, `#39b530`) with a warning; Construct's own defaults were not observed (in r506-2, Free edition, guest, the editor kept a size of 24, bold, and these common values for the other three unchanged when it saved) |

The comment fields are refused on a dictionary node, and a comment node
cannot be the start node.

There is no `color` parameter: the node `c` field is the caption, and colors are
held in the `.uistate.json` file these tools do not write.

#### `update_flowchart_node`

Update node properties. Connections, preset markers and unknown keys are
preserved. `isStart: true` clears the flag on every other node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | SID of the node to update |
| `caption` | string | No | New caption (`c`) |
| `nodeType` | string | No | New type/title (`t`) |
| `tags` | string | No | Writes a `tags` key. **Not observed**; the result carries a warning saying so |
| `isStart` | boolean | No | Set or clear the start flag |
| `enabled` | boolean | No | The `e` field |
| `parentIndex` | number | No | The `pi` field (meaning undetermined) |
| `x`, `y`, `width`, `height` | number | No | Canvas position and box size |
| `valueType` | `dictionary` / `comment` | No | Change the `ty` field. To `comment`: refused while the node has outputs or connections, or is (or is being made) the start node; `t` is cleared and the comment keys are added (body from the caption unless given). To `dictionary`: the comment keys are removed and an empty `t` takes the caption |
| `commentText`, `commentHtml`, `font`, `fontSize`, `bold`, `italic`, `fontColor` | | No | Comment fields as for `add_flowchart_node`; only on a node that is, or becomes, a comment |

#### `delete_flowchart_node`

Delete a node and clean every reference to it: other nodes' `nodeSIDs`, their
parallel `pnSIDs`/`poSIDs` entries, and any output whose `cnSID` pointed at it
(set back to `null`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | SID of the node to delete |

#### `add_flowchart_output`

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

#### `update_flowchart_output`

Update an output pin. Its `cnSID` is preserved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | SID of the output to update |
| `name`, `value` | string | No | New name / value |
| `enabled` | boolean | No | The `enable` field |
| `isDefault` | boolean | No | The `default` field |

#### `delete_flowchart_output`

Delete an output pin, first undoing any connection it held.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | SID of the output to delete |

#### `reorder_flowchart_outputs`

Reorder a node's output pins. `outputSids` must be a permutation of that node's
current output SIDs, so a wrong, short or duplicated list is rejected and
nothing is written. A node whose outputs hold one SID twice is refused too.
The new order is the order of the outputs array in the flowchart file. Whether
Construct 3 runs the outputs in that order was not observed, so check the
flowchart's behavior after a reorder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `nodeSid` | number | Yes | Node whose outputs to reorder |
| `outputSids` | number[] | Yes | The node's output SIDs in their new order |

#### `connect_flowchart_nodes`

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

#### `disconnect_flowchart_nodes`

Reverse one connection. Because `pnSIDs` and `poSIDs` are per connection, only
the entry for this output is removed; the target stays in the source's
`nodeSIDs` while any other output still points at it, so a second connection
between the same two nodes survives untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flowchartName` | string | Yes | Flowchart name |
| `outputSid` | number | Yes | Output pin to disconnect |

### Instance template tools

A template is a layout instance whose `template` block has `mode: "template"`; the instances that follow it are its replicas, whose blocks have `mode: "replica"` and name it. The state of an instance is its `template` block in `layouts/<name>.json`; there is no separate registry. Construct 3 r506-2 (Free edition, guest) saved the template an object type creates new instances from in `editorNewInstanceIsReplica` and `editorNewInstanceTemplateName` on the object type. Instances are found on every layer and sub-layer and among the non-world instances, but `set_instance_template` writes a block on a world instance only. Construct 3 r506-2 (Free edition, guest) opened a project in which `set_instance_template` had written a template, a replica of it and a replica of a template that does not exist on Text instances, and `set_default_template` the default, and saved all of them with the text that was written.

Template names are compared exactly, with their letter case and Unicode form, and the tools identify a template by its object type and name. Construct 3 r506-2 (Free edition, guest) accepted a template `herot` next to `HeroT`, and a name next to its Unicode-normalisation twin, and saved them as separate templates. A name in another letter case is therefore a different template: `set_default_template` warns that no such template exists, and `set_instance_template` writes the name as given.

Layout and object type names must be given as registered in `project.c3proj`, in that letter case. A name that differs only in letter case is refused with the registered spelling named (`Layout "level 1" not found: names are matched with their letter case. Did you mean "Level 1"?`). The two write tools end every refusal that happens before a write with `Nothing was changed.` `list_templates` changes nothing and answers an unknown object type with the plain not-found text.

**The `template` block.** `set_instance_template` writes the block in the shape Construct 3 r506-2 (Free edition, guest) saved for a template and for a replica on Text and Sprite instances (other plugins were not checked): `mode`, `templateName`, `sourceTemplateName`, three hierarchy flags, `components` and `replicasUIDs`. The editor saved `replicasUIDs` as `null`, on a template that has a replica as well, and the tool writes `null`. `components` always holds the five ids `plugin`, `instance-variable`, `behavior`, `effect` and `world-instance`, in that order, built from the instance itself:

| Component | Derived from | Notes |
|---|---|---|
| `plugin` | the keys of the instance's `properties` | `live-preview` is left out, as the editor leaves it out |
| `instance-variable` | the keys of `instanceVariables` | written as `{ iv, state }` records |
| `behavior` | one entry per key of `behaviors` | lists that behavior's own property keys, without `live-preview` |
| `effect` | one entry per key of `effects` | lists the effect's parameters, then `<<effect-template-enable>>` |
| `world-instance` | a fixed list of 24 keys, in the order the editor saves them | `x` and `y` are `false`, every other key `true` |

### `list_templates`

List every template instance in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectType` | string | No | Only list templates of this object type (as registered, in that letter case) |

Returns `templates`, one row per template instance with `templateName`, `objectType`, `layout`, `uid` and `replicaCount`, and `count`. A replica names its template, not the template's UID, so the count is the number of replicas of the same object type whose `sourceTemplateName` equals the name exactly. A replica whose template is in none of the layouts that could be read is listed under `orphanedReplicas` (`objectType`, `layout`, `uid`, `sourceTemplateName`), with `orphanedReplicaCount`. Construct 3 r506-2 (Free edition, guest) opened a project with such a replica without a message, showed its Template source blank and kept the source name through a save. At most 50 orphaned replicas are listed; when there are more, `orphanedReplicasTruncated` is `true` and a warning gives the total.

Layouts that could not be parsed are not searched. When there are any, the result carries `complete: false`, `unscannedFiles` (`file` and `reason`, for example `layouts/Level 2` and `not valid JSON`) and a warning that counts and orphans may be wrong. Error text carries no absolute path.

### `set_instance_template`

Make a layout instance a template, a replica of a named template, or neither.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout holding the instance (as registered, in that letter case) |
| `uid` | number | Yes | Instance UID (found on every layer and sub-layer, and among the non-world instances; `template` and `replica` are refused for a non-world instance) |
| `mode` | enum | Yes | `none`, `template` or `replica` |
| `templateName` | string | For `template` | Template name |
| `sourceTemplateName` | string | For `replica` | Name of the template to follow |

- `none` removes the `template` block. An instance with no block is refused.
- `template` builds the block with `mode: "template"`. A name that another instance of the same object type already has as a template, in any readable layout, is refused: `Instance UID 7 in layout "Level 2" is already a template named "T" for object type "Player". Template names must be unique per object type.`
- `replica` builds the block with `mode: "replica"` and the source name. It is written even when no instance of the object type is a template of that name, with a warning. An instance that is itself the template of that name is refused.
- A non-world instance is refused for `template` and `replica`, before anything is written: Construct 3 r506-2 (Free edition, guest) refused to open a project with a template block (and again with a replica block) on the non-world instance of an Array object type, in 2 of 2 attempts ("Failed to open project"); it opened the same project with those blocks removed, and with only the blocks on world instances kept. `none` is not affected.
- A layout that cannot be parsed, an unknown layout and an unknown UID are refused. A missing `templateName` or `sourceTemplateName` is refused before anything is read.
- The layout is written once and backed up to `<file>.bak` (`backupFile`). If the write or its read-back fails, the layout is put back as it was before the call and the error says what is on disk.

The result is `success`, `entity` (`<layout>#<uid>`), `category: "template"`, `action` (`template removed`, `template created` or `replica linked`), `warnings` and `backupFile`. The warnings, in the wording of the tool:

| When | Warning |
|---|---|
| a replica names a template that no instance of the object type has | `No instance of "Player" is a template named "T". The replica is written anyway; it has no template to follow until one of that name exists.` |
| the instance already had a block of the same mode | `The instance's existing template block was rebuilt from its current properties, instance variables, behaviors and effects; sync settings changed in the editor were reset.` (`replica` for a replica) |
| the call removes a template, renames it or turns it into a replica, and replicas follow the old name | `2 replica(s) of "Player" follow the template "T", which no instance is any more; list_templates lists them as orphanedReplicas.` |
| the same call, and the object type's default template is the old name | `Object type "Player" creates new instances from the template "T"; clear or change it with set_default_template.` (`Whether object type "Player" creates new instances from "T" could not be checked (...)` when the object type cannot be read) |
| layouts could not be parsed | the consequence, then the layouts, for example `Whether another instance of "Player" is already a template named "T" could not be checked in every layout. Layouts that could not be parsed: layouts/Level 2 (not valid JSON).` |

Construct 3 r506-2 (Free edition, guest) also offered no template properties on the Array object type and saved its non-world instance with no `template` key. Other non-world plugin types, other tiers and r495 were not checked.

### `set_default_template`

Set or clear the template a new instance of an object type is created from.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type name (as registered, in that letter case) |
| `templateName` | string \| null | Yes | Template to create new instances from, or `null` to clear it. An empty string is rejected |

Setting a name writes `editorNewInstanceIsReplica: true` and `editorNewInstanceTemplateName` on the object type. Construct 3 r506-2 (Free edition, guest) saved a cleared default as `editorNewInstanceIsReplica: true` with no `editorNewInstanceTemplateName`, and `null` writes exactly that. If no instance of the object type is a template of that name, in a layout that could be read, the name is saved as given with the warning `No instance of "Player" is a template named "T". Create one with set_instance_template first.`; layouts that could not be parsed are named in a second warning. An object type file that cannot be parsed is refused. Only the object type file is written, with a `.bak` backup; a failed write or read-back puts it back and the error says what is on disk. The result is `success`, `entity`, `category: "objecttype"`, `action` (`default template set` or `default template cleared`), `warnings` and `backupFile`.

### Find and replace

Two tools change the event sheets by name. `replace_object_in_events` swaps one object type or family for another, event by event, and leaves what the replacement cannot serve. `replace_in_expressions` finds and replaces text in the parameter values of conditions and actions. Both decide every change in memory first and write the changed sheets together; a refusal before the first write changes nothing and ends "Nothing was changed.", and a write that fails puts back the sheets the call had already written (the message says what is on disk). Event sheet names are taken as the project registers them, in that letter case. Layouts are not changed.

#### `replace_object_in_events`

Construct's event-sheet Replace object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromObject` | string | Yes | Object type or family to replace, as registered (letter case included) |
| `toObject` | string | Yes | Replacement of the same plugin, as registered |
| `sheetName` | string | No | Limit the swap to this event sheet, as registered (default: every event sheet) |
| `dryRun` | boolean | No | Report what would be swapped and skipped, and write nothing (default: `false`) |

**What a swap rewrites.** The references the rename tools rewrite ([`rename_object_type`](#rename_object_type)): the `objectClass` of conditions and actions, the owner of custom action blocks, the family of a custom action call, the object parameters (`object`, `object-to-create`, `pin-to` and `child` always; any other parameter whose whole value is the name only when it is the name exactly as registered and the reference index counts it as the object), the `objectClass` of an object-valued `instance-variable` parameter (`{ name, objectClass }`; Construct 3 r506-2, Free edition, opened and saved it on System Sort Z order, and `set-instvar-value` takes the string form, a project with the object form on it did not open), and expressions that use the name as an object (`Name.X`, `Name(0).X`). A whole value that differs from the name only in letter case, a string literal, a script line and the initial value of an event variable are never changed. They are counted in `notChanged` and named in one warning.

**What it needs from the replacement.** The unit of a swap is a branch: an event that references the replaced object together with all its sub-events, which share its picked instances. A branch is swapped whole or not at all, and the reason of a sub-event is reported as `sub-event <path>: ...` on the branch's top event. A branch is left alone when a condition or action on the replaced object uses a behavior (`behaviorType`) or an effect (an `effect` parameter holding a quoted name, checked only when the replaced object has that effect) that the replacement lacks, or when its `instance-variable` parameter names an instance variable the replacement lacks (a plain name, or a record whose `objectClass` is the replaced object; a record naming another object is not about it) (an object type has the behaviors, instance variables and effects of its families too), when an expression reads `From.Member` (or `Self.Member` in a condition or action on the replaced object) for such a behavior or instance variable, when the replacement has a behavior of the same name but of another behavior type, and when a condition or action calls a custom action (whether the replacement has it is not checked). Behavior, instance variable and effect names are compared exactly, letter case included. A custom action definition owned by the replaced object is left whole with the events inside it. A branch nested deeper than 60 levels is left alone and listed. A named animation that the replacement lacks does not stop a swap; it draws a warning.

**Sheets that cannot be parsed.** A registered event sheet over the 10MB read limit or not valid JSON is never read as events and never changed. In a call without `sheetName` it is listed in `unscannedFiles` (`{ file, reason, textSearch, names? }`) with `complete: false` and a warning; the file is searched as text for `fromObject`, and `textSearch` says what that found (`possible-use`, `no-match` or `unreadable`). A global variable declared in such a sheet is not known to the swap. A call that names such a sheet in `sheetName` is refused. A family file that cannot be parsed refuses the call, since what it gives its members is unknown.

**Refused, changing nothing:** a name that is not registered, or is given in another letter case than registered (the message gives the registered one); the same object for both; objects of different plugins; an object type or family file that cannot be parsed; an unknown `sheetName`; a `sheetName` whose file cannot be read; and, in a call without `sheetName`, a registered event sheet that has no file.

**Result.** `{ success, entity (toObject), category ("object" or "family", of fromObject), action ("replaced" or "dry-run"), fromObject, toObject, sheetsScanned, references, skippedEvents, notChanged, filesWritten, dryRun, complete?, warnings?, unscannedFiles? }`. `references` is `{ total, byKind, byFile }` with the swapped uses counted by kind (`objectClass`, `custom action owner`, `custom action family`, `object parameter`, `instance-variable object`, `expression`) and by file. `skippedEvents` is `[{ file, path, eventSid, references, reasons }]`. `notChanged` is `{ total, byKind }` over the kinds the swap never changes (`possible expression`, `string literal`, `script`, `variable value`). `filesWritten` lists the sheets written, which is empty for a dry run.

#### `replace_in_expressions`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `find` | string | Yes | Text, or a regular expression when `regex` is true |
| `replace` | string | Yes | Replacement; `$1`-style groups are expanded only with `regex`, and in plain text `$` is literal |
| `regex` | boolean | No | Treat `find` as a JavaScript regular expression (default `false`) |
| `caseSensitive` | boolean | No | Default `true` |
| `wholeWord` | boolean | No | Match whole words only (default `false`) |
| `sheets` | string[] | No | Limit to these event sheets, as registered (default: every event sheet) |
| `parameterKeys` | string[] | No | Only parameters with these keys; positional custom action and function call arguments use `"0"`, `"1"`, ... |
| `dryRun` | boolean | No | Report the changes and write nothing (default: `false`) |
| `maxReported` | number | No | Individual changes listed in `changes` (default 100, at most 1000); the counts are always complete |

Only the string values of condition and action parameters are visited, never comments, scripts or variable declarations. Parameters that hold a name are skipped unless `parameterKeys` names their key: `variable`, `instance-variable`, `object`, `object-to-create`, `parent`, `child`, `instance`, `layout`, `timeline`, `property`, `object-class`, `pin-to`, `target`, `function`, `file` and `audio-file`. So are combo choices (a bare lower-case ID such as `enabled` under keys like `state`, `mode`, `ease` or `visibility`). Matches in skipped parameters are counted in one warning that names the keys. Naming a key in `parameterKeys` makes it replaceable. A sheet named twice in `sheets` is scanned once.

**Refused, changing nothing:** an invalid regular expression; a sheet that is not registered (a case variant is named in the message); a sheet in `sheets` that cannot be read, or, in a call without `sheets`, a registered sheet that has no file; a pattern that matches zero characters anywhere (for example `a?`), since the replacement would be inserted between characters; and a pattern that does not finish in time. All matching of one call runs in a `vm` script limited to 2000 ms in total, and V8 enforces the limit inside regular expression execution, so a catastrophically backtracking pattern fails the call instead of hanging the server.

**Sheets that cannot be parsed.** In a call without `sheets`, a registered event sheet that cannot be parsed is not changed. It is listed in `unscannedFiles` with `complete: false` and a warning. When `find` is a plain name (not `regex`, letters, digits and underscores, not starting with a digit) the file is searched as text for it, and `textSearch` says what that found. For any other `find` the file is not searched: `textSearch` is `not-searched`. A call that names such a sheet in `sheets` is refused.

**Result.** `{ success, action ("replaced" or "dry-run"), find, replace, sheetsScanned, totalMatches, parametersChanged, bySheet, changes, changesTruncated, filesWritten, dryRun, complete?, warnings?, unscannedFiles? }`. `bySheet` is `[{ sheet, parameters, matches }]` for the sheets with changes. `changes` is `[{ sheet, eventSid, path, key, before, after }]`, up to `maxReported`, in the order of the sheet: the sheets in the order scanned, and within a sheet each event's conditions, then its actions, then its sub-events, each in index order (a positional argument by its index as a number, the parameters of one condition or action by key name). `path` is the JSON path of the parameter, such as `events[0].actions[1].parameters.value` or `events[3].conditions[0].parameters[0]`. `changesTruncated` is true when `changes` lists fewer parameters than `parametersChanged`.

### Project Bar structure

`move_project_item` moves an item to another Project Bar folder together with its files. `duplicate_layout`, `duplicate_layer`, `duplicate_event_sheet`, `duplicate_object_type` and `duplicate_timeline` copy an entity under a new name. All six take names as the project registers them, in that letter case; the refusal of another spelling of an object type, family, layout, layer, event sheet or flowchart name gives the registered one. A refusal before the first write changes nothing and ends "Nothing was changed."; a call that fails after it wrote something is rolled back, and its message says what is on disk (see Failures, below).

**Project Bar folders.** `project.c3proj` stores each tree as `{ "items": [...], "subfolders": [...] }` and each folder as `{ "items", "subfolders", "name" }`, in that key order. The tools keep an item's file path in step with its folder: an item in folder `Enemies/Bosses` has its entity file at `<category folder>/Enemies/Bosses/<name>.json`, with `<name>.uistate.json` beside it for a layout, an event sheet or a flowchart, `layouts/uistate/Enemies/Bosses/<name>.instancesBar.json` for a layout, and an object type's tilemap brush file at `tilemapBrushes/objectTypes/Enemies/Bosses/<name>.brush.json`. Scripts and imported project files follow the same rule under `scripts/` and `files/`. This is the layout of files the tools produce. In a live check, Construct 3 r506-2 (Free edition, guest) opened a project laid out this way after moves and copies by these tools, listed the folders with the items in them, and wrote its own save at the same paths (entity files, `.uistate.json`, `.instancesBar.json` and images). Not checked: the editor moving an item itself, and moved flowcharts, families, scripts, imported project files and tilemap brush files. Folders keep their order; a folder the call creates is appended after its siblings, and a moved item is appended to its destination folder.

#### `move_project_item`

Move an existing item to another folder, or to the root.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | enum | Yes | `objectType`, `family`, `layout`, `eventSheet`, `flowchart`, `script` or `file` (an imported project file under `files/`) |
| `name` | string | Yes | Item name, as registered; for scripts and files, the file name (`main.js`) |
| `folder` | string | No | Destination path such as `Enemies/Bosses`, spelled as an existing folder is; empty (default) moves to the root |
| `sourceFolder` | string | No | Scripts and files: the current folder, when the file name exists in more than one folder |
| `createFolders` | boolean | No | Create a missing destination path (default `true`) |

**What moves.** The entity file; for a layout, an event sheet or a flowchart its `<name>.uistate.json`; for a layout also its `.instancesBar.json`; for an object type its tilemap brush file when one exists at the object type's own folder (a Tilemap object type without one draws a warning, and the move goes on); for a script or an imported project file, the file. The view-state files (`.uistate.json`, `.instancesBar.json`) are moved after `project.c3proj` was updated and the old files were deleted, and a failure to move one is a warning: the call is not rolled back for it. A view-state file that already exists at the new place with other content is left as it is, with a warning. A view-state file is moved as bytes and is not read: in the live check on Construct 3 r506-2 (Free edition, guest), the editor read three moved view-state files at their new paths and kept their values, but refused to open a project whose layout `.uistate.json` had no `grid` object (2 of 2 attempts).

**Order of writes.** The files are created at their new paths first, each as a file of the call and refused when a file is already there, in any letter case. Every source is then checked once more for a change since it was read. `project.c3proj` is updated next: the item leaves its old folder and is appended to the destination, with any missing folders created. The old files are deleted next (the view-state files are moved after that), each kept as `<file>.bak` and named in `oldFilesKeptAs`. An old file that changed after the call copied it is not deleted: the result warns and says that the new file holds it as it was before that change. An old file that cannot be deleted is a warning too, because the project already names the new place. The emptied source folder is kept, with a warning. Moving a script warns that import statements naming its path are not rewritten. Timelines cannot be moved.

**Refused, changing nothing:** an item that is not registered, or is registered in another letter case; an item that exists in more than one folder when `sourceFolder` does not choose one; a destination that is the folder the item is in; a destination folder that differs from a sibling only in letter case (the message names the existing spelling, because on Windows and macOS the two are one directory); a folder segment Windows cannot store (a leading space, a trailing space or dot, `< > : " | ? *` or a control character, a reserved device name such as `CON` or `LPT1`, `..`); a missing destination with `createFolders: false`; a script or file whose name is already in the destination folder; a destination file that already exists; a registered file that is missing on disk; a file that cannot be read (the message gives the reason, never a path); and a project with no tree for the category.

**Result.** `{ success, entity, category, action ("moved"), from, to, foldersCreated, filesMoved, oldFilesKeptAs, warnings?, backupFile }`. `filesMoved` is `[{ from, to }]` with project-relative paths, the view-state files included once they moved.

#### Duplicates

A copy gets fresh SIDs throughout: every `sid` in it is new, and one old SID maps to the same new SID everywhere inside the copy. The new name must be usable (it must start with a letter or underscore, as for the create tools) and is compared with the names in use without regard to letter case (a layout, event sheet, object type or timeline name becomes a file name; a layer name is compared among the layers of its layout). A file already at the target path, in any letter case and registered or not, refuses the call. The editor's view-state files (`*.uistate.json`, `*.instancesBar.json`) are never copied; in the live check on Construct 3 r506-2 (Free edition, guest) the editor opened the copies without them, used view settings of its own and wrote such files beside each copy when it saved. A copy is written through the same check as every entity the writer writes: JSON generated for it over 5MB is refused before anything is changed (`Generated JSON for "<name>" is too large`). A copy that cannot be made faithful is refused with the reason.

The copy's entity file is created first and registered right after its source, in the source's folder (`duplicate_layer` instead writes the layout that holds the layer). An object type's image files and tilemap brush file are created after that. The new JSON files are written with the line endings of the project.

**Failures.** This applies to `duplicate_layout`, `duplicate_event_sheet`, `duplicate_object_type`, `duplicate_timeline` and `move_project_item`. `duplicate_layer` writes one file, the layout, and puts the layout back when its write fails and says so, as the other layout tools do (the message ends "The call was rolled back: layouts/<layout>.json is as before the call."). If a step fails after the first write, the call puts back `project.c3proj` and then removes the files it created, but only once `project.c3proj` no longer names the copy. If `project.c3proj` still names it, the created files are kept and named ("kept: project.c3proj still registers what this call added, so the file stays"), so that the project never names a file the rollback removed. The message ends with the form `The call was rolled back: <files> is/are as before the call.` when everything was put back (a created file is listed as `removed: the call had created it`). When the rollback itself fails, the message says the writes could not be undone and names the files that may be left as the call wrote them. Folders the call made for new files may remain after a rollback. `move_project_item` uses the same rollback; it also keeps the copies of a move that fails while `project.c3proj` still names the new folder.

#### `duplicate_layout`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout to copy, as registered |
| `newName` | string | Yes | Name of the copy |

Every layer and instance, world and non-world, is copied. Instances get UIDs above the highest UID in the project, and `sceneGraphData.uid`, `parent-uid`, `children[].uid` and a replica list are remapped through the same map; the `instanceFolderItem` and `scene-graphs-folder-root` entries that address an instance by SID, where the layout file has them, follow their instance's new SID (Construct 3 r506-2, Free edition, guest, saved neither key in the live check, so the layouts it saves have none; the hierarchy remap was confirmed there: the editor showed and saved the copy's link on the copy's UIDs). The copy keeps the source's `eventSheet`.

Refused, changing nothing: a layout that holds a template instance (`template.mode: "template"`, since a template name can exist only once per object type; replicas copy normally); hierarchy links to instances outside the layout; a name another layout has, ignoring case; a layout that cannot be read; and a project whose files cannot all be scanned for UIDs (the message gives the UID generator's reason and names the files).

Warnings: the layout places a global object type (the copy places another instance of it); an object type could not be read, so that was not checked; a timeline addresses an instance of the source by UID (it still addresses the original and was not duplicated); an event sheet picks an instance of the source by a fixed `unique-id` (it still picks the original); a timeline or event sheet could not be read or parsed, so the check for those two could not be made, and it is named. The check looks at every timeline file (to a depth of 64 levels) and every event sheet (to a depth of 128 levels).

#### `duplicate_layer`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout that owns the layer, as registered |
| `layerName` | string | Yes | Layer to copy, as registered |
| `newName` | string | Yes | Name of the new layer, unique in the layout ignoring case |

The copy is inserted directly after the source layer in its sibling list. Its instances get new UIDs and SIDs, and each `scene-graphs-folder-root` entry of a copied instance, where the layout file has them, gets a copy after it (Construct 3 r506-2, Free edition, guest, saves no such entries). The layout file is written once, with a backup, and a failed write puts it back. Timelines and event sheets that address the original layer's instances by UID are not scanned: they keep addressing the originals.

Refused, changing nothing: a layer with sub-layers (their names would repeat in the layout); template instances; hierarchy links to instances on other layers; a name another layer of the layout has, ignoring case; a layout that cannot be read; and a project whose files cannot all be scanned for UIDs. Warnings: the same global object type warnings as `duplicate_layout`.

#### `duplicate_event_sheet`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet to copy, as registered |
| `newName` | string | Yes | Name of the copy |

Refused, changing nothing: a sheet that declares a group, a function, a custom action or a global (top-level) variable, since the copy would declare the name twice (the first ten are named in the message); events nested deeper than 64 levels, which the scan for those names does not follow; a name another event sheet has, ignoring case; a sheet that cannot be read. The copy is attached to no layout and included by no sheet; the result says so in a warning.

#### `duplicate_object_type`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type to copy, as registered |
| `newName` | string | Yes | Name of the copy; an object type or a family with that name, ignoring case, refuses the call |

Behaviors, instance variables, effects and animations are copied with fresh SIDs, and every animation frame gets a fresh `imageSpriteId`. The frames' image files in `images/` are copied under the lower-case name of the same frame of the copy, keeping the extension, and a tilemap brush file at the object type's folder is copied beside the original. No instance is placed. A copied object type keeps the source's default template (`editorNewInstanceIsReplica` and `editorNewInstanceTemplateName`), and the result warns when it names a template, which belongs to the source. Family and container membership is not copied; the result warns and names the families.

Refused, changing nothing: a single-global object type (Keyboard, Mouse, ...); a target in `images/` that already exists or that two files would share; a brush file that already exists at the new name; an image, brush or object file that cannot be read (the message gives the reason, never a path). A frame with no image file is a warning, and the copy has no file for it.

#### `duplicate_timeline`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timelineName` | string | Yes | Timeline at the root of the timelines tree, as registered |
| `newName` | string | Yes | Name of the copy |

Writes `timelines/<newName>.json`, the source with only `name` changed, and registers it right after the source. The copy's tracks address the same instances by UID, so a warning says that playing both at once makes them compete (not given for a timeline without tracks).

Refused, changing nothing: a timeline in a folder; a custom ease (a transition); a name another timeline or transition has, ignoring case; a file at the target that is not registered, in any letter case; a source file that cannot be read or is not a JSON object.

---

## Runtime Tools

These tools drive a running game through an injected bridge script, `scripts/c3-runtime-bridge.js`, exposed as `globalThis.__c3bridge`. The server reaches it over the Chrome DevTools Protocol (CDP): `connect_to_game` opens a connection to the game's browser tab, and `call_bridge`, `wait_for_condition`, the event tools, `simulate_input`, `get_canvas_size` and `screenshot_game` use it. `serve_preview` serves an exported game on this machine and can launch a browser for it. A typical run:

1. `inject_runtime_bridge`, then reload the project in the editor.
2. Preview in a browser started with `--remote-debugging-port`, or export (Menu > Project > Export > Web (HTML5)) and `serve_preview` the exported folder with `launchBrowser: true`.
3. `connect_to_game`, then `call_bridge`, `wait_for_condition`, `subscribe_events` / `read_events`, `simulate_input`, `screenshot_game`.
4. `disconnect_from_game`, `stop_preview`, and `remove_runtime_bridge` before shipping.

The connection tools need Node.js 22 or later (its built-in WebSocket client); on an older Node.js they say so, and the rest of the server works as before. Two settings belong to whoever starts the server, not to a tool call: `C3MCP_ALLOW_EVAL=1` allows `wait_for_condition` conditions of type `"expression"` (JavaScript in the game page), and `C3MCP_ALLOW_REMOTE_CDP=1` allows `connect_to_game` to reach a browser on another machine. `CHROME_PATH` names the browser `serve_preview` launches.

### `inject_runtime_bridge`

Write the bridge script and register it so Construct loads it. Construct loads only the main script on its own; other scripts run only when the main script imports them (manual, "Script files"). So in a project with a main script, one marked line goes at the top of that script (`import "./c3-runtime-bridge.js"; // construct3-mcp runtime bridge (...)`, with the relative path from the main script's folder; line endings and BOM kept), and the bridge is listed with `"script-info": {"purpose": "none"}`, under a SID from the project's ID generator (no other SID of the project has it). A project without a main script gets the bridge as its main script (`"purpose": "main"`). An entry an earlier version wrote (`"file-info"`, purpose none, loaded by nothing) is replaced in place. Projects whose `scriptsType` property is `"classic"` get the entry without an import (a classic script cannot hold one), with a warning. Called again, it leaves the entry where it is and writes `project.c3proj` only when the registration changed. Each bridge file is backed up once per call (`<file>.bak`), right before its own write. It reads the main script and the bridge file before it writes anything: when `project.c3proj` names a main script that is missing or cannot be read, or a folder is where the bridge script goes, it refuses and changes nothing, and when one of its writes fails, it puts back the files it wrote before (the same holds for `export_for_preview` and `pack_project` when they add the bridge). A `project.c3proj` that changed on disk during the call (saved in the editor) is refused before the first write and again right before `project.c3proj` is written, which puts back the files written before (see [Error Response](#error-response)). The next tool call works with the new script list. No parameters.

Returns `success`, `injected`, `path`, `registered` (whether `project.c3proj` changed), `loadedAs` (`"import"`, `"main"` or `"classic"`), for `"import"` also `mainScript` (path under `scripts/`) and `importAdded`, and `message`.

The script starts through `runOnStartup()` and processes commands each tick, on the page or, with *Use worker* on, in the runtime's worker. When it runs, the console shows `[c3-bridge] Runtime bridge initialized. Access via globalThis.__c3bridge`. `submit(type, args)` returns a command id; `getResult(id)` returns `{ ok, value }` or `{ ok: false, error }` once, after the next tick (`null` before); `cancel(id)` withdraws a command (`"queued"`: removed before it ran, `"result"`: its result dropped, `false`: unknown). Results nobody collects expire after 60 seconds. `emit(name, data)` feeds custom events to subscriptions.

### `remove_runtime_bridge`

Delete the bridge script, remove its entries from `project.c3proj`, and remove every line in the project's scripts (`.js`, `.mjs`, `.ts` under `scripts/`) that only imports the bridge, with at most a comment after it: the marked line `inject_runtime_bridge` added, after which the main script is byte for byte as before (BOM and line endings included), and a line typed by hand, such as the `import "./c3-runtime-bridge.js";` the v1.9.2 instructions had you add. A script that uses the bridge in another way (`import * as bridge from "./c3-runtime-bridge.js"`, `export ... from`, `import(...)`) makes the tool refuse before it changes anything, naming the script: without the bridge file the game would not load. So does a script or folder under `scripts/` that cannot be read (held open by another program, no read access), which could import the bridge. It works out every change before its first write, refuses a `project.c3proj` that changed on disk during the call as `inject_runtime_bridge` does, and when one of its writes fails, it puts back the files it wrote before (the scripts and `project.c3proj`). Each bridge file it writes is backed up once per call (`<file>.bak`), right before its own write. A folder where the bridge script would be is not the bridge and is left as it is. No parameters. Returns `entriesRemoved`, `importRemoved` and `scriptsChanged` (paths under `scripts/`).

### `get_bridge_commands`

List the commands `call_bridge` runs, with their arguments: `ping`, `callFunction`, `getGlobalVar`, `setGlobalVar`, `getObjectState`, `getAllInstances`, `getLayout`, `goToLayout`, `evaluateExpression`, `listObjects`, `listGlobalVars`, `layerToCssPx`, `cssPxToLayer`, `subscribeEvents`, `readEvents`, `unsubscribeEvents`. No parameters.

### `connect_to_game`

Open a CDP connection to the game's page and keep it for the other runtime tools. With `host` and `port`, the pages the browser lists (narrowed by `pageUrl` and `urlContains`) are tried at once and the one whose bridge answers ready is kept. When several pages have a ready bridge (two games, or another site that defines a `globalThis.__c3bridge` of its own), the call fails and lists their URLs instead of guessing; once one page answered, the others get 1.5 seconds to finish their first check. With `cdpEndpoint`, that page only. The bridge is looked for on the page and in the page's dedicated workers (reached through `Target.setAutoAttach`), so games with *Use worker* on work too. The tab is brought to the front (`Page.bringToFront`); a hidden page runs no ticks, so bridge calls would time out.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cdpEndpoint` | string | No | A page's CDP WebSocket endpoint (`ws://` or `wss://`), e.g. `browser.pageEndpoint` from `serve_preview` |
| `host` | string | No | Browser debugging host (default: `127.0.0.1`) |
| `port` | integer | No | Browser debugging port (default: 9222) |
| `pageUrl` | string | No | With `host`/`port`: only pages of this URL's origin whose path starts with its path, e.g. the `url` from `serve_preview` (`http://127.0.0.1:53817/`) |
| `urlContains` | string | No | With `host`/`port`: only pages whose origin and path contain this text; the query and fragment do not count |
| `timeoutMs` | integer | No | Time for the whole connection, 100 to 60000 (default: 10000) |

Only hosts on this machine (`localhost`, `127.x.x.x`, `::1`) are allowed unless the server runs with `C3MCP_ALLOW_REMOTE_CDP=1`; that includes the page endpoints a debugging port on this machine lists, which are refused when they name another host. The connection lasts as long as the page: after a reload or a navigation the game starts over (its state and subscriptions are gone), so the connection is closed, and every call with its `connectionId` fails with an error that says the page reloaded; the same happens when the bridge's worker ends. Connect again. Returns `connectionId`, `bridgeReady`, `bridgeContext` (`"page"` or `"worker"`), `pageVisible` (with a `warning` when the page stayed hidden), `gameState` (`ready`, `layoutName`, `tickCount`, `gameTime`, `dt`, `objectCount`) and, after discovery, `target` (`id`, `title`, `url`). When no page's bridge answers in time, the error lists the pages tried.

### `disconnect_from_game`

Close a connection. Subscriptions stay in the page until `unsubscribe_events` or a reload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |

### `call_bridge`

Submit a bridge command, poll for its result and return it: `commandId`, `result`, `elapsedMs`. A command the bridge rejects (`{ ok: false }`) is an error. On a timeout the command is withdrawn (`cancel`), and the error says whether it had not run and will not, ran after all, or, with an older bridge, may still run.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `command` | string | Yes | One of the commands `get_bridge_commands` lists |
| `args` | object | No | Command arguments (max 100 keys, depth 6); `getObjectState` takes `objectName` |
| `pollIntervalMs` | integer | No | 10 to 1000 (default: 50) |
| `timeoutMs` | integer | No | 100 to 60000 (default: 5000) |

### `wait_for_condition`

Check a condition at once and then every `pollIntervalMs` until it holds or `timeoutMs` ends. Returns `met`, `elapsedMs` and `finalValue` (the last value read); not meeting the condition is not an error.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `condition` | object | Yes | One of the shapes below |
| `pollIntervalMs` | integer | No | 10 to 5000 (default: 100) |
| `timeoutMs` | integer | No | 100 to 120000 (default: 30000) |

Conditions: `{ type: "globalVar", name, operator, value }`, `{ type: "objectProperty", objectType, property, operator, value }` (a property of the first instance, or one of its instance variables), `{ type: "layout", name }`, and `{ type: "expression", expr, operator, value }`. Operators: `eq`, `neq` (strict, `Object.is`), `gt`, `lt`, `gte`, `lte` (two numbers or two strings) and `contains` (substring or array element). An `expression` is JavaScript evaluated where the bridge runs, with the page's full rights; it is refused unless the server runs with `C3MCP_ALLOW_EVAL=1`.

### `subscribe_events`

Buffer events in the bridge between polls, for [`read_events`](#read_events). Custom events come from the game's own script: `globalThis.__c3bridge.emit(name, data)`. Changes are found by comparing values once per tick, so a change and its reversal within one tick are not seen. There is no generic event-sheet signal subscription: no documented interface reports them. A subscription lives in the page: it stays after `disconnect_from_game` and ends with [`unsubscribe_events`](#unsubscribe_events) or a reload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `eventType` | string | Yes | `"globalVarChange"` (changes of one global variable), `"layoutChange"` (changes of the current layout) or `"custom"` (events the game emits) |
| `filter` | object | No | `variable`: the global variable to watch, required for `"globalVarChange"`; `name`: for `"custom"`, only events emitted with this name (default: every custom event) |
| `bufferSize` | integer | No | Events kept, 1 to 1000 (default: 100); the oldest event is dropped when full |

Returns `subscriptionId`, `eventType`, `filter` and `bufferSize`.

### `read_events`

Read the events a subscription buffered since the last read.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `subscriptionId` | string | Yes | From `subscribe_events` |
| `clear` | boolean | No | Empty the buffer after reading (default: true); `false` leaves the events for a later read |

Returns `events` (`type`, `name`, `value`, `previousValue` for changes, `timestamp`, `tick`, oldest first) and `count`.

### `unsubscribe_events`

Stop a subscription and release its buffer. An unknown subscription is an error.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `subscriptionId` | string | Yes | From `subscribe_events` |

Returns `subscriptionId` and `unsubscribed`.

### `simulate_input`

Send input through the CDP Input domain.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `action` | object | Yes | One of the actions below |
| `delayMs` | integer | No | Wait before the input, 0 to 60000 (default: 0) |
| `coordinateSpace` | string | No | `"viewport"` (page CSS pixels, default), `"canvas"` (CSS pixels from the canvas's top left) or `"layout"` (layout coordinates, converted by the game through `layerToCssPx`) |
| `layer` | string or integer | No | For `"layout"`: the layer name or index (default: 0) |

Actions: `{ type: "click", x, y, button?, clickCount? }`, `{ type: "mouseMove", x, y }`, `{ type: "touch", x, y, gesture: "tap" | "longPress" | "swipe", endX?, endY? }` (touch emulation is on for the gesture only), `{ type: "key", key, modifiers? }` and `{ type: "type", text, mode? }`. A `key` is a key name (`Enter`, `Escape`, `Space`, `ArrowLeft`, `Tab`, `Backspace`, `Insert`, `F1` to `F24`, ...) or one character; characters get the code and keyCode of the US keyboard key that types them (`.` is `Period`, 190; `!` is `Digit1`, 49, with Shift). `type` presses one key per character (keyDown with its text, keyUp), so a game reading the keyboard sees it; `mode: "insertText"` inserts the text at once into a focused text field instead, without key events.

### `get_canvas_size`

The game canvas's position and CSS size in the viewport (`left`, `top`, `cssWidth`, `cssHeight`), its backing-store size (`backingWidth`, `backingHeight`), `devicePixelRatio` and the viewport size. Takes `connectionId`.

### `screenshot_game`

Capture the page, or only the canvas, as a PNG or JPEG file. The file is checked before the capture: an absolute path outside the open project's folder (junctions resolved), ending in `.png` for PNG or `.jpg`/`.jpeg` for JPEG. Missing folders are created, and an existing file is replaced only with `overwrite: true`. The runtime tools leave the project as it is, so a screenshot never lands there.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | From `connect_to_game` |
| `outputPath` | string | Yes | Absolute path of the image file, outside the project folder |
| `format` | string | No | `"png"` (default) or `"jpeg"` |
| `quality` | integer | No | JPEG quality 0 to 100 |
| `canvasOnly` | boolean | No | Only the canvas rectangle (default: the whole viewport) |
| `overwrite` | boolean | No | Replace an existing file (default: false, which makes an existing file an error) |
| `timeoutMs` | integer | No | Time for the capture, 1000 to 120000 (default: 30000; a large canvas takes seconds) |

Returns `success`, `path`, `bytes`, `format` and, for the canvas, `clip`. The image has no size limit of its own.

### `serve_preview`

Serve an exported game folder (the one holding `index.html`) at `http://127.0.0.1:<port>/`, and optionally launch Chrome or Edge on it. A source project folder or a `.c3p` is refused: Construct exports only from its editor.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | Yes | The exported game folder |
| `port` | integer | No | HTTP port on 127.0.0.1 (default: 0, any free port). A port another program answers on is refused |
| `crossOriginIsolated` | boolean | No | Send COOP `same-origin`, COEP `require-corp` and CORP `same-origin`, for `SharedArrayBuffer` (default: false; `require-corp` blocks resources from other origins that do not allow it, such as a CDN script) |
| `launchBrowser` | boolean | No | Launch a browser on the served URL (default: false) |
| `headless` | boolean | No | Headless, with software WebGL (default: false) |
| `windowWidth`, `windowHeight` | integer | No | Browser window size |
| `readyTimeoutMs` | integer | No | Wait for the browser's debugging port, 1000 to 120000 (default: 15000) |

The server listens on 127.0.0.1 only, answers only requests whose `Host` names this machine (127.0.0.1, localhost, [::1]; others get 403), serves only files whose real path lies in the folder (no junction or link out of it), GET and HEAD only, with `cache-control: no-store` and the usual content types (`.wasm` as `application/wasm`). A file is opened once per request: one that disappears meanwhile (a new export into the folder) is a 404, and a download the browser aborts closes its file. The browser comes from `CHROME_PATH` (which must name a file) or the usual Chrome and Edge install locations; the tool takes no browser path, host or interface, and refuses such parameters. A browser that cannot be started is an error of the call, and its fresh profile is removed. It starts with a fresh profile and `--remote-debugging-port=0`: it picks a free port itself and writes it into that profile, so the port is never another program's. Returns `serverId`, `url`, `host`, `port`, `folder`, `crossOriginIsolated`, `requests`, for a launched browser `browser` (`pid`, `executable`, `cdpPort`, `pageEndpoint`, `headless`), and `next`.

### `stop_preview`

Stop one preview server (`serverId`) or all of them, ending the browsers they launched and removing their profiles. Only the launched child process is ended. Profiles left over by an earlier run whose server and browser have ended are removed at the next launch. All preview servers and connections also end when the MCP server shuts down.

### `generate_bridge_eval_script`

Generate a Python script and manual console steps that submit a bridge command and poll for its result, for use without `connect_to_game`. The Python script only prints the JavaScript lines (`js_submit`, `js_poll_template`) to run in the preview's browser console; it does not connect to the browser. The console steps (`manualUsage`) name the Firefox DevTools console, but they are plain JavaScript for the developer tools console of the preview window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Bridge command (e.g. `"callFunction"`, `"getGlobalVar"`) |
| `args` | object | No | Command arguments (max 100 keys, depth 6) |

### `export_for_preview`

Pre-flight check for runtime testing: reports where the runtime runs (`workerMode`, from *Use worker*; `"dom"`/`"no"` or `false` in older files: on the page, `"worker"`/`"yes"` or `true`: in a worker, which `connect_to_game` reaches; `"auto"`: on the page once the project uses scripts, as it does with the bridge) and, by default, injects the bridge like `inject_runtime_bridge`, returning its `loadedAs`, `mainScript` and `importAdded`. It does not change `useWorker`. The `nextSteps` name `serve_preview` and `connect_to_game`. With `injectBridge: false` nothing is written.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `injectBridge` | boolean | No | Inject the runtime bridge (default: true) |

### `clone_project`

Copy the project folder to a new directory, optionally with the bridge injected into the copy the same way as `inject_runtime_bridge`. The original project is not modified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `targetDir` | string | Yes | Target directory for the copy |
| `includeBridge` | boolean | No | Inject the bridge into the copy (default: true) |

### `pack_project`

Pack the project folder into a `.c3p` file (ZIP archive) that the Construct 3 editor can open. Skips `.git`, `node_modules`, `.bak` files, `.DS_Store` and `Thumbs.db`. Entries are stored without compression, and names with characters outside ASCII are marked as UTF-8. Unless `injectBridge` is false, it first adds the bridge **to the project itself**, as `inject_runtime_bridge` does (the bridge file, its entry and the marked import line in the main script), so the packed game loads the bridge. To pack a game for players, call `remove_runtime_bridge` and pack with `injectBridge: false`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `outputPath` | string | Yes | Output path for the `.c3p` file |
| `injectBridge` | boolean | No | Inject the bridge into the project before packing (default: true) |

Returns `success`, `packed`, `outputPath`, `fileCount`, `sizeBytes`, `sizeMB` and `bridgeInjected`; with the bridge also `loadedAs`, `mainScript` and `importAdded` (as `inject_runtime_bridge` returns them) and a `warning` that the packed game exposes `globalThis.__c3bridge`.

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
  "content": [{ "type": "text", "text": "Object \"Player\" already exists. Use update_object_properties to modify it." }],
  "isError": true
}
```

The text is a plain message (some start with `Error ...`, e.g. `Error creating object: ...`). Arguments that do not match a tool's input schema are refused the same way, with a text that starts `MCP error -32602: Input validation error: Invalid arguments for tool <name>: [...]`.

A write that would replace a change made on disk outside the tool call is an error: when an event sheet, layout, object type or family file changed after the call read it (saved in the Construct 3 editor, restored with git, or written by a tool call running in parallel on the same file), or, for the timeline, addon and runtime-bridge tools, `project.c3proj` changed during the call, the text says `<file> was changed on disk after this server read it (...). It was not written, so that change is kept. Run the tool again: it reads the file as it is now.` When the call had already written other files, they are put back first and the text goes on `The files this tool call had already changed were put back as they were before the call (<files>), so the call changed nothing.`; a file that changed on disk again meanwhile is left as it is and named with its `.bak` (`... left as they are (...): <file> (its state from before the call is in <file>.bak). Check the project (validate_project, git diff) before you run the tool again.`). The server's own `project.c3proj` updates (registering or removing an entity, addon auto-registration, `update_project_metadata`) keep a change made on disk and are not refused for it. Of two parallel create calls for the same name, the second fails with `Refusing to create "<name>": the file ... already exists`. A tool call whose `project.c3proj` changed on disk and is not valid JSON at the moment (still being written) fails with `project.c3proj changed on disk and could not be read again (...)`. Changes made on disk between tool calls need no reconnect: each call checks `project.c3proj`, and the files the server's caches hold when the call first uses them, and reads again what changed.

Refusals by the reference checks are **not** errors: `delete_object`, `update_object_properties`, `move_events_between_sheets`, `move_event_block`, `update_event_variable` (`rename_blocked`) and similar tools return a normal response with `"success": false`, `"action": "delete_blocked"`, `"update_blocked"`, `"move_blocked"` or `"rename_blocked"`, a `message` and the `references` found, and `unscannedFiles` when files that could not be parsed possibly hold uses. Nothing is written in either case.

### WriteResult

Mutation tools return this structure on success:

```typescript
interface WriteResult {
  success: boolean;
  entity: string;        // name of the entity
  category: string;      // "object" | "family" | "eventsheet" | "layout" | "timeline" | "tilemapbrush" | "project" | "addon"
  action: string;        // "created" | "updated" | "deleted" | "renamed" (also "unchanged" for an `update_tilemap_brush` that changes nothing, "delete_blocked", "update_blocked", "move_blocked", "rename_blocked", "would_delete", "would_rename", "would_update", "already_registered")
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];   // e.g., "Auto-registered plugin..."
  backupFile?: string;   // path to .bak file
  unscannedFiles?: UnscannedFileReport[];
                         // files the reference check could not parse and searched as text (see Mutation Tools)
  editorNote?: string;   // not in the TypeScript type: toolResult adds it to every completed write
}
```

Some tools add their own fields (for example `deletedSid`, `movedSids`, `backupFiles`). Responses with `success: false` (`action: "delete_blocked"`, `"update_blocked"`, `"move_blocked"` or `"rename_blocked"`), dry runs and no-ops carry no `editorNote`.

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
  unscannedFiles?: UnscannedFileReport[];
}

interface UnscannedFileReport {
  file: string;          // "layouts/Big"
  reason: string;        // "over the 10MB size limit" | "not valid JSON" | "could not be read"
  textSearch: 'possible-use' | 'no-match' | 'unreadable' | 'not-searched';
  names?: string[];      // with possible-use: what the text holds
  searchedFor?: string[]; // with no-match: what the text was searched for
  unchecked?: string;    // with not-searched in a delete: what its own unparsed file keeps from being checked
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

**Last Updated**: 2026-09-29
