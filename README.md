# Construct3 MCP Server

> A Model Context Protocol (MCP) server that enables AI assistants (Claude, Cursor, Antigravity, and any MCP-compatible tool) to safely read, analyze, and modify Construct 3 game engine projects.

> **Fork build 1.9.1** (upstream release 1.9.0 plus the fork's work). See [This is a fork](#this-is-a-fork), [What's new in 1.9.0](#whats-new-in-190), the [Roadmap](#roadmap) and the [CHANGELOG](CHANGELOG.md) for details.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)

---

## This is a fork

This branch is a fork of [liauw-media/construct3-mcp](https://github.com/liauw-media/construct3-mcp)
and has diverged from it: **190 MCP tools instead of upstream's 71**, with 119 added and none
removed or renamed. It includes upstream's release 1.9.0 in full. It adds whole areas upstream does
not cover (flowcharts, timeline tracks and keyframes, custom eases, tilemap data and brushes,
effects, containers, templates, renames with reference rewriting, find and replace, Project Bar
moves and duplicates, script and project file registration) and replaces the generated-script
runtime bridge with live Chrome DevTools Protocol control of a running preview.

It also changes how some upstream tools serialize their output, to match what Construct r495.2
actually writes. **[FORK.md](FORK.md) is the full list of what was added, what was changed, and
how this relates to upstream.** Read it before filing an issue, and note which branch you are on:

| Branch | What it is |
|---|---|
| `claude/w84-editor-gap` | The diverged line described in this README, with upstream 1.9.0 merged in. All 190 tools. |
| `main` | The same commit as `claude/w84-editor-gap`. |

Everything below this notice describes `claude/w84-editor-gap`.

---

## What's new in 1.9.0

Upstream's release 1.9.0, which this fork includes:

- **Editor load-time checks** — `validate_project` checks the rules the Construct 3 editor enforces when it opens a project, and event sheet writes that would add such an error are refused.
- **Behavior conditions and actions the editor reads** — written with `behaviorType`; `fix_legacy_behavior_keys` repairs sheets from older versions (`behavior-type` is still accepted as a deprecated input alias).
- **Find events by editor number** — `locate_event` and `get_eventsheet_outline` turn "sheet, event N, action M" into the event's JSON path.
- **Runtime traps** — `find_runtime_traps`, the `construct3://docs/pitfalls` resource and the `debug_stuck_game` prompt for logic that loads but hangs or fails silently.
- **Editor-faithful event shapes** — else-if and OR blocks, events without conditions, positional function calls, script lines and the Functions object as the editor saves them; `fix_legacy_event_shapes` converts older sheets.
- **Safer deletes and editor name rules** — deletes and removals of used behaviors, instance variables and family members are refused, ambiguous SIDs are refused (pick one with `eventPath`), case-only name clashes are refused, and nested sub-layers are supported everywhere.
- **Accurate reports** — `validate_project`, `find_orphaned_objects`, `get_asset_usage` and `analyze_performance` read editor-saved projects correctly (Transitions folder, animation folders, file assets, non-world instances, sub-layers) instead of reporting false problems.
- **Byte-faithful writes** — line endings, trailing newline, BOM and file-name case are kept; lowercase image file names and per-instance behavior entries match the editor; every write result carries an `editorNote`.

Where the fork and upstream had solved the same problem differently, the merge kept one behavior; the [CHANGELOG](CHANGELOG.md) entry for 1.9.1 lists those decisions.

## Quick Start

```bash
# Install dependencies
npm install

# Build the server
npm run build

# Test with your project (a folder project, or a single-file .c3p)
node dist/index.js /path/to/your/project.c3proj
```

**Add to your MCP config** (Claude Code, Cursor, Antigravity — [see Usage](#usage) for config file locations):
```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js"]
    }
  }
}
```

## Table of Contents

- [This is a fork](#this-is-a-fork)
- [Why This Exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Safety Model](#safety-model)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Why This Exists

**The Problem**: When you ask Claude Code to work on Construct 3 projects, it directly edits JSON files and often breaks:
- Object references and unique IDs (SIDs/UIDs)
- Event sheet dependencies and includes
- Layout and instance relationships
- Plugin and behavior configurations
- The `usedAddons` registry

**The Solution**: This MCP server provides a **structured, validated interface** that:
- Understands Construct 3's internal file format and ID system
- Provides structured access to project data via resources and query tools
- Enables deep analysis (dependency graphs, orphan detection, performance audits)
- Safely creates, updates, and deletes project entities with automatic backup, ID generation, and validation
- Includes access to official Construct 3 documentation

## Features

### Resources (Read-Only Data Access)

| Resource | Description |
|----------|-------------|
| `construct3://project/info` | Project metadata and basic info |
| `construct3://project/structure` | Complete project structure overview |
| `construct3://project/addons` | All plugins, behaviors, and effects |
| `construct3://objects/{name}` | Specific object type details |
| `construct3://eventsheets/{name}` | Specific event sheet details |
| `construct3://layouts/{name}` | Specific layout details |
| `construct3://docs/index` | Index of documentation categories and popular topics |
| `construct3://docs/manual/{topic}` | Official Construct 3 documentation |
| `construct3://docs/pitfalls` | Curated Construct 3 pitfalls (signals, scripts, picking, expressions), each tagged with its source |

### Query Tools (Read-Only)

| Tool | Description |
|------|-------------|
| `list_objects` | List all object types with optional name filtering |
| `list_eventsheets` | List all event sheets |
| `list_layouts` | List all layouts |
| `list_families` | List all object families |
| `list_timelines` | List all timelines (root and subfolders); transitions are listed separately |
| `list_addons` | List addons in `usedAddons`, optionally filtered by type |
| `get_object_details` | Get detailed info about a specific object |
| `get_eventsheet_details` | Get detailed info about an event sheet |
| `get_layout_details` | Get detailed info about a layout |
| `get_timeline_details` | Get a timeline's full JSON (tracks and settings) |
| `search_objects` | Search objects by name pattern |
| `get_project_summary` | Get comprehensive project summary |

### Project Session Tools

| Tool | Description |
|------|-------------|
| `get_open_project` | Report the project the server serves: name, `.c3proj` path, and for a `.c3p` the archive and its working folder |
| `open_project` | Switch to another project folder, `.c3proj` or `.c3p` while the server runs; see [Single-file (.c3p) projects](#single-file-c3p-projects) |
| `reload_project` | Re-read the project after Construct or another program saved it, and report which files had changed on disk |
| `list_changes` | What recent tool calls wrote, created, deleted or moved, with the `.bak` backup each write left |
| `revert_last_change` | Undo the most recent tool call that changed files, from those backups |

### Analysis Tools

| Tool | Description |
|------|-------------|
| `get_eventsheet_flow` | Event sheet include hierarchy and layout bindings (Mermaid or JSON) |
| `get_function_map` | Function definitions and call sites across event sheets (Call function actions, `Functions.Name(...)` expression calls, function map registrations) |
| `get_object_dependencies` | Where objects are used (event sheets, layouts including sub-layers, families) |
| `find_orphaned_objects` | Find objects not used by any event (including object parameters, expressions and script actions) or layout (including sub-layers, non-world instances and object properties of other instances) |
| `get_asset_usage` | Track sound, image, font, video and project file usage (used, unused or not analysed) |
| `analyze_performance` | Heuristic performance audit with categorized issues |
| `validate_project` | 30 integrity checks: missing files, required fields, duplicate SIDs/UIDs, repeated layer names, broken references and includes, behaviors and instance variables that events use but their object lacks, missing addons, legacy `"behavior-type"` keys and other keys Construct does not read, layout instances without behavior entries, event shapes older versions wrote that the editor never writes, scripts in the one-string shape of older Construct 3 releases, object images, conditions and actions against Construct r495.2's own definitions or a loaded addon's, expressions inside parameters, addons without definitions, orphaned and backup files, plus the rules the C3 editor enforces at load (trigger and else placement, expression syntax, empty expressions, duplicate names/SIDs, family plugins). Rules verified only in part are reported as warnings; `complete` says whether every object type, event sheet and layout was scanned (details in [API.md](docs/API.md#validate_project)) |
| `load_addon_definitions` | Load a third-party addon's conditions and actions (addon.json and aces.json, unpacked or as a .c3addon) so its ACEs are checked like the built-in ones; without a path, list what is loaded |
| `get_group_settings` | Event group settings (`isActiveOnStart`, disabled) across sheets, filterable by sheet and active state |
| `locate_event` | Map an editor event number ("es_game, event 72, action 1") to its JSON path, sid, content and neighbouring events |
| `get_eventsheet_outline` | Readable, paged event sheet outline with editor event numbers (IF/DO/CALL/SCRIPT/GROUP/FUNCTION/VAR) |
| `find_runtime_traps` | Runtime traps: Wait for signal tags nothing signals, waits that start after a call already raised their tag, unused/dynamic signal tags, scripts using function parameters without `localVars` |
| `get_project_properties` | Every project setting: the full `properties` bag and top-level settings such as `bundleAddons` |
| `search_project` | Find text or a regular expression across event sheets, script files and layout instance values |
| `find_behavior_usage` | Declarations, event references and per-instance settings of a behavior |
| `find_effect_usage` | Object types, families, layouts, layers and instances that use an effect |
| `find_instance_variable_references` | Event references (ACE parameters, expressions, call arguments) and stored values of an instance variable |
| `get_instance_counts` | Placed instances per object type and layout, including sub-layers and non-world instances |

### Mutation Tools (Safe Write Operations)

**Objects and families**

| Tool | Description |
|------|-------------|
| `create_object` | Create a new object type (Sprite, Text, TiledBg, global plugins, etc.); refuses names that clash with an object type, a family, System or the Functions object, ignoring case |
| `update_object_properties` | Add/remove instance variables and behaviors, change global status, edit a single-global object's settings; removing one that events still use is refused, listing the uses, unless forced |
| `update_instance_variable` | Rename, retype or describe an instance variable, keeping placed instances and event references in step |
| `reorder_behaviors` | Reorder the behaviors of an object type or family |
| `replace_object_image` | Replace the image of a Tiled Background, 9-patch, Particles, Sprite Font or Tilemap object |
| `delete_object` | Delete an object; refused while anything uses it (events, instances on any layer or sub-layer, families), listing where, unless forced |
| `create_family` | Create a family; refuses name clashes and members of mixed plugins (load-time checked) |
| `update_family` | Add/remove members, shared instance variables and shared behaviors; refuses member changes that mix plugins (load-time checked), and removing an instance variable, behavior or member through which events still use them, unless forced |
| `delete_family` | Delete a family; refused while events or object properties name it or events use its instance variables or behaviors through a member, listing where, unless forced |
| `list_containers` / `create_container` / `update_container` / `delete_container` | Object containers, whose members Construct creates, picks and destroys together |

**Event sheets**

| Tool | Description |
|------|-------------|
| `create_event_sheet` | Create a new event sheet with optional includes; refuses names that differ from an existing sheet only in case |
| `add_event_to_sheet` | Add a group, function, variable, include, comment or script block to a sheet, at the root or inside a group or event (load-time checked); the names of a new variable and of function parameters are checked like in the editor |
| `add_event_block` | Add a block event with conditions + actions (gameplay logic) at the sheet root, under a parent SID or beside a sibling SID, written in the editor's own shapes: sub-events (also without conditions), else/else-if blocks, OR blocks, function and custom action calls, script actions, comment rows; refuses writes that break the checked editor load-time rules (expression syntax, empty expressions, trigger placement) |
| `update_event_block` | Update an existing block, function or custom action body: modify, insert, replace, add or remove actions and conditions, make it an else or OR block (load-time checked) |
| `update_event_block_action` | Replace the parameters of one action in a block (by block SID and action index; function call arguments as an array; load-time checked) |
| `move_event_block_items` | Reorder or move actions/conditions within or between blocks while preserving SIDs, or copy them with fresh SIDs (`copy: true`) |
| `move_event_block` | Move an event to another container in the same sheet, keeping its SID and every descendant |
| `move_events_between_sheets` | Copy or move top-level events between sheets by SID (optionally into a group); a move keeps SIDs, a copy gets fresh ones; load-time checked, and a copy or move that would clash event variable names is refused |
| `add_custom_action` | Add a custom action definition owned by an object type or family |
| `update_function` | Update a function or custom action definition; a rename rewrites every call when `renameCallers` is set |
| `update_event_group` | Update a group in place: title, description, active on start, disabled, colors |
| `update_event_variable` | Rename a variable or change its type, initial value, static or constant flag or comment; a new name is checked like in the editor |
| `update_comment` | Update a comment, addressed by its index in its container |
| `update_script_event` | Replace the JavaScript of a standalone script block, or remove the block |
| `delete_event_from_sheet` | Delete an event from a sheet by SID or include name (dry-run, force); refuses while functions or event variables it removes are still referenced elsewhere (by calls, function maps, System variable ACEs or by name in expressions); warns about an else block the delete leaves behind |
| `remove_event_from_sheet` | Remove an include from a sheet by included sheet name |
| `delete_event_sheet` | Delete an event sheet (with reference checking and optional force) |
| `fix_legacy_behavior_keys` | Rename legacy `"behavior-type"` keys (written by older versions) to `"behaviorType"` in all event sheets, checking each name against the object's behaviors (dry-run by default) |
| `fix_legacy_event_shapes` | Convert event shapes written by older versions into the editor's own (block `isElse` to a System else condition, condition `isOr` to `isOrBlock`, old-shape function calls to positional arguments, one-string scripts, as older Construct 3 releases also saved them, to lines) where the result is unambiguous; reports the rest and which conversions can change how an event runs (dry-run by default) |

Event SIDs are not always unique in editor-saved sheets. The tools that find an event by SID refuse a SID shared by several events in the sheet and list the candidates; pass `eventPath` (the JSON path that `locate_event` returns, e.g. `events[3].children[1]`) to pick one. `move_events_between_sheets` keeps SIDs on a move and warns when a moved event leaves such a shared SID in the target sheet. See [API.md](docs/API.md#mutation-tools).

**Layouts, layers and instances**

| Tool | Description |
|------|-------------|
| `create_layout` | Create a new layout with configurable layers; refuses names that differ from an existing layout only in case |
| `update_layout` | Update layout event sheet binding, dimensions, scrolling, sampling, projection and viewport anchor |
| `delete_layout` | Delete a layout (blocks startup layout, checks references) |
| `add_layer` | Add a layer, at the top level or as a sub-layer (position, visibility, transparency, parallax, blend mode); refuses a name any layer or sub-layer of the layout uses, ignoring case |
| `update_layer` | Rename a layer or sub-layer or change visibility, interactivity, parallax, blend mode, scale rate, Z elevation, color, sampling and render settings; refuses a new name used by another layer or sub-layer, ignoring case |
| `delete_layer` | Delete a layer or sub-layer with its sub-layers (never the last top-level one; blocked while it holds instances or has sub-layers, unless forced) |
| `reorder_layers` / `move_layer` | Reorder one nesting level, or move a layer to another nesting level |
| `add_instance_to_layout` | Place an object instance on a layout layer or sub-layer with full property control |
| `update_instance` | Update a placed instance by UID on any layer or sub-layer (position, size, angle, color, origin, blend mode, depth, visibility, tags, instance variables, plugin properties, behaviors, effects) |
| `move_instance` | Move a placed instance to another layer or change its Z order |
| `delete_instance_from_layout` | Remove a placed instance by UID (layers, sub-layers and non-world instances) |
| `add_instances_to_layout` | Place up to 500 instances on one layout in one call; if any item fails, nothing is written (`dryRun`) |
| `update_instances` | Update up to 500 placed instances of one layout in one call, all or nothing (`dryRun`) |
| `move_instances` | Move up to 500 world instances of one layout between layers or Z positions in one call, applied in list order, all or nothing (`dryRun`) |
| `delete_instances_from_layout` | Remove up to 500 instances of one layout by UID in one call, detaching hierarchy links, all or nothing (`dryRun`) |
| `set_instance_parent` / `remove_instance_children` | Attach an instance to a hierarchy parent or detach it, or detach all of its children |

**Sprite animations**

| Tool | Description |
|------|-------------|
| `add_animation_to_sprite` | Add a new animation to a Sprite object |
| `update_animation_properties` | Update animation speed, looping, ping-pong, repeat count |
| `rename_animation` | Rename an animation with its frame image files and the layout instances starting with it |
| `delete_animation` | Delete an animation (never the last one) |
| `add_frame_to_animation` | Add a blank frame (placeholder PNG) at an index |
| `update_frame` | Per-frame duration, size, origin, tag, image points and collision polygon |
| `delete_frame_from_animation` | Delete a frame by index (never the last one) |
| `duplicate_frame` | Copy a frame with its image |
| `replace_sprite_image` | Replace a frame's image with base64 PNG data |
| `reorder_frames` / `reverse_frames` | Reorder or reverse the frames, renaming their image files to match |
| `create_animation_folder` / `move_animation_to_folder` | Organize animations in subfolders |

**Timelines**

| Tool | Description |
|------|-------------|
| `create_timeline` | Create a timeline (duration, loop, ping-pong, repeat count, start-on-layout); refuses a case variant of a timeline in the same folder |
| `update_timeline` | Update timeline settings, playback modes, or enable/disable it |
| `delete_timeline` | Delete a timeline (backs up exactly the file it deletes; a registered timeline whose file is missing is only deregistered) |
| `list_timeline_tracks` | Summarize a timeline's tracks by kind, including untyped tracks from older releases |
| `add_timeline_track` / `remove_timeline_track` | Add an instance track for a placed instance, or remove any track with its keyframes |
| `add_property_track` / `remove_property_track` | Add or remove one property track of an instance track |
| `add_value_track` / `add_audio_track` | Add a value track or an audio track playing a registered sound or music file |
| `set_keyframe` / `delete_keyframe` | Create, update or delete the keyframes at a time on a track |
| `update_track` | A track's playback properties; value and audio tracks can also be renamed |
| `add_timeline_folder` / `rename_timeline_folder` / `delete_timeline_folder` / `move_timeline_track` | Organize timeline tracks in track folders |
| `list_eases` / `create_ease` / `update_ease` / `delete_ease` | Custom ease curves in `timelines/transitions/`, kept in step with the timelines that use them |

**Project, addons and files**

| Tool | Description |
|------|-------------|
| `update_project_metadata` | Update project name, version, author, or description |
| `update_project_properties` | Any project setting, plus the first layout, viewport size, worker mode and functions name |
| `register_addon` | Add a plugin, behavior or effect to `usedAddons` |
| `unregister_addon` | Remove an addon from `usedAddons` (built-ins need `force`) |
| `register_script_file` | Register a script in `rootFileFolders.script` with `script-info` metadata and a collision-safe SID |
| `deregister_script_file` | Remove a script registration while preserving the script file |
| `set_main_script` | Mark one registered script as the main script |
| `register_project_file` | Copy a file into `files/` and register it in the general, sound, music, video, or font family |
| `deregister_project_file` | Deregister a Project File and remove its file under `files/` |
| `create_data_file` | Create an Array, Dictionary, JSON or text data file and register it |

### More Mutation Tools, by Area

The tables above cover the general write tools. The tools below complete the set, grouped by what they edit; [docs/API.md](docs/API.md) gives the parameters of every one.

#### Flowcharts

| Tool | Description |
|------|-------------|
| `list_flowcharts` / `get_flowchart_details` | List flowcharts, or read one's nodes, outputs and connections |
| `create_flowchart` / `delete_flowchart` | Create an empty flowchart and register it, or delete one |
| `add_flowchart_node` / `update_flowchart_node` / `delete_flowchart_node` | Add, update or delete a node; a delete removes every reference to it |
| `add_flowchart_output` / `update_flowchart_output` / `delete_flowchart_output` | Add, update or delete a node's output pins |
| `reorder_flowchart_outputs` | Reorder a node's outputs, which is their execution order |
| `connect_flowchart_nodes` / `disconnect_flowchart_nodes` | Wire an output to a node, or unwire it |

#### Effects

| Tool | Description |
|------|-------------|
| `list_effects` | The effects on an object type, family, layer or layout, and the registered effect addons |
| `add_effect` / `update_effect` / `remove_effect` / `reorder_effects` | Attach, change, detach or reorder effects; an effect addon must be registered (`register_addon`) before `add_effect` |

#### Tilemaps

| Tool | Description |
|------|-------------|
| `get_tilemap_data` | Read a placed Tilemap's cells, including flips |
| `set_tilemap_tiles` | Paint or erase cells, or fill a rectangle, keeping the rest |
| `set_tilemap_data` | Replace all of a Tilemap's cells, by default resizing the instance to match |
| `list_tilemap_brushes` / `add_tilemap_brush` / `update_tilemap_brush` / `delete_tilemap_brush` | The editor brushes stored for a Tilemap object type |

#### Instance Templates

| Tool | Description |
|------|-------------|
| `list_templates` | Every template instance and how many replicas point at it |
| `set_instance_template` | Make an instance a template, a replica of a template, or neither |
| `set_default_template` | Set or clear the template new instances of an object type are created from |

#### Project Bar Moves and Duplicates

| Tool | Description |
|------|-------------|
| `move_project_item` | Move an object type, family, layout, event sheet, flowchart, script or project file to another Project Bar folder, moving its files with it |
| `duplicate_layout` | Copy a layout with fresh SIDs, new UIDs and remapped hierarchy links |
| `duplicate_layer` | Copy a layer inside its layout, placed above the source |
| `duplicate_event_sheet` | Copy an event sheet with fresh SIDs (refused when it declares groups, functions, custom actions or global variables) |
| `duplicate_object_type` | Copy an object type with fresh SIDs and image IDs, its image files and its tilemap brush |
| `duplicate_timeline` | Copy a timeline under a new name |

#### Find and Replace

| Tool | Description |
|------|-------------|
| `replace_object_in_events` | Construct's Replace object: swap one object type or family for another in one sheet or all sheets, skipping events the replacement cannot serve (`dryRun`) |
| `replace_in_expressions` | Find and replace text in condition and action parameters, scoped by sheet and parameter key (`dryRun`) |

#### Renames with Reference Rewriting

Each rename rewrites the references to the name across the project, not just the name itself.

| Tool | Description |
|------|-------------|
| `rename_object_type` | Rename an object type, with event, layout, family, container, image and file references |
| `rename_family` | Rename a family, with event, project tree and file references |
| `rename_layout` / `rename_event_sheet` | Rename a layout or event sheet, with every binding, include and file reference |
| `rename_layer` | Rename a layer and the layer names written in event sheets |
| `rename_event_variable` | Rename an event variable and every reference in its scope |

### Runtime Tools (Live Game Control)

| Tool | Description |
|------|-------------|
| `inject_runtime_bridge` | Inject a bridge script into the C3 project that exposes the runtime via `globalThis.__c3bridge` |
| `remove_runtime_bridge` | Remove the bridge script and clean up the project |
| `get_bridge_commands` | List all commands the bridge supports (callFunction, getGlobalVar, getObjectState, etc.) |
| `connect_to_game` | Open a persistent CDP connection to a running game and wait for its injected bridge |
| `disconnect_from_game` | Close a persistent game connection |
| `call_bridge` | Execute any supported bridge command over a persistent game connection |
| `wait_for_condition` | Poll a global variable, object property, layout, or page expression until a condition is met |
| `simulate_input` | Send mouse, touch, keyboard, and text input through CDP, in viewport, canvas or layout coordinates |
| `get_canvas_size` | Read the game canvas position, CSS size, backing size, and device pixel ratio |
| `screenshot_game` | Save the connected page, or only its canvas, as a PNG or JPEG file |
| `subscribe_events` | Observe a global variable, the current layout, or custom events the game emits, into a bounded buffer |
| `read_events` | Read a subscription's buffered events, clearing them unless asked not to |
| `unsubscribe_events` | Stop a subscription and release its buffer |
| `serve_preview` | Serve an exported game folder over loopback HTTP and optionally launch Chrome on it with a debugging port |
| `stop_preview` | Stop a preview server and the browser it launched |
| `generate_bridge_eval_script` | Generate a curl/python script to execute a bridge command via browser remote debugging |
| `export_for_preview` | Pre-flight checks (worker mode, bridge injection) for preview testing |
| `clone_project` | Deep-copy the project with optional bridge injection |
| `pack_project` | Pack the project folder into a `.c3p` file that Construct 3 can open (optionally injects the bridge first) |

The runtime bridge enables the built-in CDP tools or external tools (Playwright, browser console, curl) to control a running C3 game. Once injected and the game is previewed, you can:

```javascript
// From the browser console, or use connect_to_game + call_bridge through MCP
globalThis.__c3bridge.submit("callFunction", { name: "StartGame", params: [] });
globalThis.__c3bridge.submit("getGlobalVar", { name: "Score" });
globalThis.__c3bridge.submit("getObjectState", { objectName: "Player" });
```

### Prompts (Workflow Templates)

| Prompt | Purpose |
|--------|---------|
| `analyze_project` | Analyze project structure and organization |
| `find_object_usage` | Find where a specific object is used |
| `explain_eventsheet` | Explain how an event sheet works |
| `review_game_logic` | Review overall game logic architecture |
| `document_object` | Generate documentation for an object |
| `optimize_project` | Get optimization suggestions |
| `debug_stuck_game` | Diagnose soft-locks and silently dead features (runs `find_runtime_traps`, uses the pitfalls doc) |

## Safety Model

Mutation tools follow a strict safety protocol (exceptions below):

1. **Validation** — Names checked for reserved words, path traversal, format. Plugin/behavior IDs validated against `usedAddons`.
2. **Backup** — JSON files are backed up to `<filename>.bak` before modification.
3. **ID Generation** — SIDs (15-digit random), UIDs (sequential), and imageSpriteIds (7-digit) are collision-checked against the entire project.
4. **Write** — JSON is pre-validated (round-trip test, size limit), then written to a temp file and renamed into place. Files keep their text style (see below). `project.c3proj` is first put in the shape Construct r495.2 saves (script metadata key, `models3d`, and for older releases the property order and `zAxisScale`), without pruning `usedAddons`; see `src/construct3/project-shape.ts`.
5. **Verify** — Files are read back, compared with what was written, and re-parsed to confirm integrity.
6. **Cache Invalidation** — All reader caches and indexes are cleared so subsequent reads see fresh data.

Steps 2, 4 and 5 apply in full to writes that go through the project writer: objects, families, event sheets, layouts, animations, project metadata, addon auto-registration, script and project file registration, and the runtime bridge's registration in `project.c3proj`. The other write paths do less:
- The tools that write their own files (timelines and eases, flowcharts, containers, tilemap brushes, `register_addon` / `unregister_addon`, the rename and duplicate tools) back each file up to `<file>.bak` once per call and write it through a temp file, but do not read the result back.
- The runtime tools (`inject_runtime_bridge`, `remove_runtime_bridge`, and `export_for_preview` / `pack_project` when they inject the bridge) back up the bridge script and `scripts/main.js` and write them in place, with no read-back check.
- A replaced image is backed up; a placeholder PNG is written without a backup.

**Change journal.** Every result ends with the files the call changed. `list_changes` shows what recent calls wrote, created, deleted or moved, and `revert_last_change` undoes the most recent one from its backups, refusing, and restoring nothing, when a later call or another program changed the same files. A write made from content Construct saved since the server read it is refused until `reload_project`.

**Close and reopen the project in Construct 3 before saving there.** The editor keeps an open project in memory, so saving from a session that was opened before these edits can overwrite them. Its Project Bar reload (F9) re-reads script files only, not event sheets, layouts or `project.c3proj`. Every response that reports a completed write carries this reminder as `editorNote`. Error responses do not, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

Additional safeguards:
- **Reference checking** — `delete_object`, `delete_family`, `delete_event_sheet`, and `delete_layout` scan for references before deleting; `update_object_properties` and `update_family` check the events before removing an instance variable, a behavior or a family member. After the checks, the four delete tools remove the registration from `project.c3proj` before deleting the file, so a failure part way leaves an orphaned file, never a registration without a file.
- **Addon auto-registration** — When creating objects with new plugins or adding behaviors, known Scirra addons are automatically registered in `usedAddons`. Unknown/third-party addons are blocked with an error.
- **Global plugin protection** — Singleglobal-inst objects (Audio, AJAX, etc.) cannot be placed on layouts.
- **Plugin-specific defaults** — Instances are created with correct default properties for each plugin type (Sprite, Text, TiledBg, NinePatch).
- **Image generation** — Sprite and TiledBg creation automatically generates valid placeholder PNGs, named like the editor names them: `images/<object>-<animation>-000.png`, all lowercase. Batch writes roll back on failure.
- **Layout instance sync** — Like the editor, every layout instance carries an entry for each behavior of its object type and of the families it belongs to, with the built-in behaviors' default property values. `add_instance_to_layout` writes these entries; adding or removing a behavior (`update_object_properties`) or changing family membership (`update_family`, `delete_family`) updates the existing instances. Behavior or variable changes also make sure every instance of the object has the `behaviors` and `instanceVariables` dicts C3 expects.
- **Names compared like the editor** — Create and rename tools refuse a name that differs from an existing one only in case where Construct 3 compares names ignoring case: event sheets and layouts (project-wide), object types and families, the layers of one layout (sub-layers included; the editor cannot load a layout with two such layers), the animations of one sprite (in any animation folder), and sibling project-bar folders. Timeline names are compared exactly, as the editor does, but a case variant of a timeline in the same folder is refused because both would share one file on Windows and macOS.
- **Event variable names checked like the editor** — `add_event_to_sheet` and `update_event_variable` refuse the event variable and function parameter names the editor's variable and parameter dialogs refuse: a name that matches, ignoring case, an event variable or function parameter in its scope (for a global variable, any in the project; for a local one or a parameter, the globals, the variables and parameters of its enclosing events and those below its parent event or function), the name of a System expression (e.g. `time`, `random`), and names with whitespace, punctuation such as `-` `.` `:`, a leading underscore or only digits. Names of object types and families are allowed, as in the editor. `move_events_between_sheets` refuses a copy or move that would create such a clash, e.g. a copy of a global variable (the editor renames a pasted variable instead).
- **No overwrite on create** — Create tools refuse to write an entity JSON file (object type, family, event sheet, layout) or a timeline file where one already exists, also one whose name differs only in case (an unregistered file, or one registered under another spelling). Nothing is backed up or replaced. Placeholder PNGs are not covered: `create_object` and the animation tools write them over an image file of the same name in `images/`, e.g. one left behind by a deleted object or animation.
- **File names kept** — Rewriting an existing file keeps its name on disk exactly, including case (e.g. `Layout1.json` registered as `layout1`); the `.bak` backup takes the same name.
- **Text style preserved** — JSON is written the way Construct 3 saves it (tab indent). In writes through the project writer, the timeline and ease tools, addon registration, and the flowchart, container, tilemap brush, rename and duplicate tools, a file that already exists keeps its own line endings (e.g. CRLF from a git `core.autocrlf` checkout), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style (LF, no trailing newline, no BOM). For files in Construct 3's tab layout, diffs show only the lines that changed; files indented another way (e.g. with spaces) are re-indented with tabs in full. Tilemap brush files are the exception in layout: Construct 3 writes them as one line of compact JSON, so a new brush file is written that way and an existing one keeps its own layout (compact, or its indent string) together with its line endings, trailing whitespace and BOM.

## Documentation

Detailed documentation is available in the `/docs` folder:

- [**Architecture**](docs/ARCHITECTURE.md) - System design, components, and data flow
- [**API Reference**](docs/API.md) - Complete reference for all resources, tools, and prompts
- [**Examples**](docs/EXAMPLES.md) - Usage examples and workflows
- [**Development Guide**](docs/DEVELOPMENT.md) - Contributing, adding tools, C3 format notes
- [**Troubleshooting**](docs/TROUBLESHOOTING.md) - Common issues and solutions

## Installation

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** or **yarn**
- A Construct 3 project saved in **folder format** (.c3proj) or as a **single file** (.c3p); see [Single-file (.c3p) projects](#single-file-c3p-projects)

### Install Dependencies

```bash
cd construct3-mcp
npm install
```

### Build

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

## Usage

All MCP-compatible tools use the same JSON configuration format. The server auto-detects `.c3proj` in your working directory, or you can pass an explicit project path.

**MCP config** (same for all tools):
```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js"]
    }
  }
}
```

To target a specific project instead of auto-detecting:
```json
"args": ["/path/to/construct3-mcp/dist/index.js", "/path/to/your-project"]
```

### Environment variables

| Variable | Effect |
|---|---|
| `C3_PROJECT_PATH` | Project folder, `.c3proj` or `.c3p` to serve when no path argument is given (default: the working directory) |
| `C3_ADDON_DEFINITIONS` | Third-party addon definitions to load at startup: `.c3addon` files or unpacked addon folders, separated by `;` on Windows and `:` elsewhere. Same as calling `load_addon_definitions` |
| `CHROME_PATH` | Chrome or Edge executable for `serve_preview` to launch, when it is not in a standard install folder |

### With Claude Code

Add the config above to your project's `.mcp.json` or global `~/.claude/mcp.json`.

1. Open Claude Code inside any Construct 3 project folder
2. The MCP tools appear automatically

### With Claude Desktop

Add the config to your Claude Desktop settings file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Note: Claude Desktop doesn't change working directory per-project, so pass the project path explicitly in `args`.

### With Cursor

Add the config to `.cursor/mcp.json` in your project root (project-specific) or `~/.cursor/mcp.json` (global).

1. Restart Cursor after adding or modifying the config
2. The Construct 3 tools appear in Cursor's AI agent

### With Antigravity

Add the config to Antigravity's MCP configuration:

- **Via UI**: Click the `...` menu in the Agent panel → **MCP Servers** → **Manage MCP Servers** → **View raw config**
- **Direct edit**: `~/.gemini/antigravity/mcp_config.json`

Note: Antigravity doesn't set a working directory per-project, so pass the project path explicitly in `args`.

### Standalone Testing

```bash
# Auto-detect .c3proj in current directory
cd /path/to/project-folder
node /path/to/construct3-mcp/dist/index.js

# Or pass explicit path
node dist/index.js /path/to/project.c3proj
node dist/index.js /path/to/project-folder
node dist/index.js /path/to/game.c3p
```

### Single-file (.c3p) projects

Pass a `.c3p` file instead of a project folder:

```bash
node dist/index.js /path/to/game.c3p
```

Or, from a running server whatever it started on, call `open_project` with the `.c3p` path (or any
other project folder or `.c3proj`). The switch waits for other tool calls to finish and holds new
ones until it is done; a `.c3p` being left is written back first. If the new project cannot be
opened, the server keeps the one it had. `get_open_project` reports which project is served.

The server unpacks the archive into a private working folder under the system temp folder and
loads that. After every tool call that changed a file, it writes the archive back: the new
archive is built in memory, read back as a check, written beside the original and renamed over
it, and the tool result ends with a line saying so. The first write of a session keeps the
archive as it was opened in `game.c3p.bak`. Files that did not change are not compressed again,
so later writes are fast even on a large project (about 0.2 s for 2,286 files).

The archive is never overwritten with content it no longer matches. If something else, usually
Construct saving the project, changed the `.c3p` after the server opened it, the write is
refused, the tool result says so, and this session's changes stay in the working folder, whose
path the result names. Restart the server to load the archive as it is now. Close the project
in Construct, or at least do not save it there, while the server writes to it. The working
folder is deleted when the server exits, unless it holds changes the archive does not.

Tool results and backups name paths inside the working folder, not the archive. Archives
Construct saves are ZIP64 with backslash paths; the server reads both, and writes plain zip
with forward slashes and DEFLATE, which Construct r495.2 opens.

### Example Queries

Once the MCP server is running, ask Claude:

**Project Analysis:**
- "What objects are in my Construct 3 project?"
- "Give me an overview of the project structure"
- "What plugins and behaviors are being used?"
- "Find orphaned objects that aren't used anywhere"
- "Run a performance audit on my project"

**Code Understanding:**
- "Explain how the MainSheet event sheet works"
- "Show me the event sheet include hierarchy"
- "Map all the functions in the project"
- "What objects depend on the Player?"

**Safe Modifications:**
- "Create a new Sprite object called Enemy"
- "Add a health variable to the Player object"
- "Create an event sheet for the menu logic"
- "Add a new layout called LevelSelect with two layers"
- "Place a Player instance at position 100, 200 on the Game layout"

**Documentation:**
- "Show me the Construct 3 documentation for the Sprite plugin"
- "What are the best practices for event sheets?"

## Development

### Project Structure

```
construct3-mcp/
├── src/
│   ├── index.ts                    # Main MCP server entry point
│   ├── error-messages.ts           # Removes filesystem paths from client-visible errors
│   ├── construct3/
│   │   ├── c3p-project.ts          # Serve a .c3p through a working folder, written back after each change
│   │   ├── project-session.ts      # The served project, and switching it at runtime
│   │   ├── project-reader.ts       # Project file parser and cache
│   │   ├── project-writer.ts       # Safe write operations with backup
│   │   ├── project-shape.ts        # project.c3proj in the shape Construct r495.2 saves
│   │   ├── change-journal.ts       # File stamps, per-call change record, revert
│   │   ├── id-generator.ts         # SID/UID generation with collision avoidance
│   │   ├── templates.ts            # Object, event sheet, layout templates
│   │   ├── event-shapes.ts         # The event shapes the editor writes (else, OR, calls, scripts)
│   │   ├── ease-params.ts          # Custom eases embedded in event parameters
│   │   ├── instance-behaviors.ts   # Behavior entries on layout instances
│   │   ├── animation-rename.ts     # Animation lookup in folders; frame image files and layout instances a rename_animation changes
│   │   ├── json-format.ts          # On-disk text style (line endings, trailing newline, BOM)
│   │   ├── layers.ts               # Layer trees: every layer and sub-layer, their instances, layer names
│   │   ├── atomic-write.ts         # Temp-file-and-rename writes that keep file names on disk
│   │   ├── names.ts                # Case-insensitive name and folder comparison
│   │   ├── event-variable-names.ts # Editor name rules for event variables and function parameters
│   │   ├── path-utils.ts           # Path resolution inside the project folder
│   │   ├── png-generator.ts        # Zero-dep placeholder PNG generation
│   │   ├── ace-catalog.ts          # Condition, action and expression lookup
│   │   ├── ace-catalog-data.ts     # Construct r495.2 ACE definitions (generated)
│   │   ├── addon-definitions.ts    # Third-party addon definitions (addon.json, aces.json)
│   │   ├── expression-check.ts     # Expression parser and name resolution
│   │   ├── references.ts           # Reference scanning and rewriting for renames
│   │   ├── file-registration.ts    # Script and project file registration helpers
│   │   ├── tilemap-data.ts         # Tilemap tile data codec
│   │   ├── timeline-folders.ts     # The editor's Transitions folder in the timelines container
│   │   ├── timeline-model.ts       # Track kinds, track folders and custom eases in timeline files
│   │   ├── timeline-properties.ts  # What a property track stores for each property
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/
│   │       ├── index-builder.ts    # Cross-reference index
│   │       ├── event-flow.ts       # Event sheet flow and function map
│   │       ├── object-deps.ts      # Object dependencies and orphaned objects
│   │       ├── asset-usage.ts      # Asset usage tracking
│   │       ├── animations.ts       # Sprite animation trees (items + subfolders)
│   │       ├── event-outline.ts    # Editor event numbers, event sheet outline
│   │       ├── performance.ts      # Performance heuristics
│   │       ├── integrity.ts        # Project integrity checks (validate_project)
│   │       ├── load-rules.ts       # Editor load-time rules (validate_project, pre-write checks)
│   │       ├── legacy-behavior-keys.ts # Legacy "behavior-type" key scan and repair
│   │       ├── legacy-event-shapes.ts # Legacy isElse/isOr/function call/script shape scan and repair
│   │       ├── delete-references.ts # Function and variable names an event delete would leave dangling
│   │       ├── behavior-refs.ts    # Behavior name checks against objects and families
│   │       ├── group-settings.ts   # Event group settings (get_group_settings)
│   │       ├── runtime-traps.ts    # Signal pairing and order, script/parameter traps
│   │       └── script-scan.ts      # Lightweight JS/TS scanner for script actions
│   ├── resources/
│   │   ├── project.ts              # 6 project resources
│   │   ├── docs.ts                 # 3 Construct 3 documentation resources
│   │   └── pitfalls.ts             # Curated pitfalls doc (construct3://docs/pitfalls)
│   ├── runtime/
│   │   ├── bridge.ts               # Injectable C3 runtime bridge script generator
│   │   ├── cdp-client.ts           # Persistent CDP connections and bridge calls
│   │   ├── preview-server.ts       # Serves an exported game and launches Chrome on it
│   │   ├── project-files.ts        # The files a folder project packs into a .c3p
│   │   ├── zip-reader.ts           # Dependency-free .c3p archive reader (ZIP64, DEFLATE)
│   │   └── zip-writer.ts           # Dependency-free .c3p archive writer
│   ├── tools/
│   │   ├── query.ts                # 9 query tools
│   │   ├── analysis.ts             # 11 analysis tools
│   │   ├── usage-tools.ts          # 6 usage and search tools
│   │   ├── session-tools.ts        # 5 project session tools
│   │   ├── shared.ts               # Shared validation, result/error helpers, editor reload note
│   │   ├── mutations.ts            # Registers every mutation tool module
│   │   ├── event-tools.ts          # 19 event sheet tools
│   │   ├── event-helpers.ts        # Event Zod schemas, builders, validators
│   │   ├── layout-tools.ts         # 18 layout, layer and instance tools
│   │   ├── object-tools.ts         # 8 object type and family tools
│   │   ├── container-tools.ts      # 4 container tools
│   │   ├── animation-tools.ts      # 14 Sprite animation tools
│   │   ├── project-tools.ts        # 6 project and addon tools
│   │   ├── file-tools.ts           # 6 script and project file tools
│   │   ├── effect-tools.ts         # 5 effect tools
│   │   ├── timeline-tools.ts       # 12 timeline tools
│   │   ├── timeline-track-tools.ts # 7 timeline track and folder tools
│   │   ├── timeline-ease-tools.ts  # 4 custom ease tools
│   │   ├── flowchart-tools.ts      # 13 flowchart tools
│   │   ├── structure-tools.ts      # 6 Project Bar move and duplicate tools
│   │   ├── replace-tools.ts        # 2 find-and-replace tools
│   │   ├── rename-tools.ts         # 6 rename tools
│   │   ├── template-tools.ts       # 3 instance template tools
│   │   ├── tilemap-brush-tools.ts  # 4 tilemap brush tools
│   │   ├── tilemap-data-tools.ts   # 3 tilemap data tools
│   │   └── runtime-tools.ts        # 19 runtime control tools
│   └── prompts/
│       └── workflows.ts            # 7 workflow prompts
├── test/                           # Vitest suites, mocks and fixtures
├── scripts/                        # ACE catalogue build, editor coverage, fixture tools
├── dist/                           # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── FORK.md
└── README.md
```

### Development Commands

```bash
# Install dependencies
npm install

# Build (compile TypeScript)
npm run build

# Watch mode (auto-rebuild on changes)
npm run dev

# Run the test suite (vitest)
npm test

# Start the server
npm start
```

### Building from Source

```bash
git clone -b claude/w84-editor-gap https://github.com/BeatsByZann/construct3-mcp.git
cd construct3-mcp
npm install
npm run build
```

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**
4. **Build and test**: `npm run build && npm start`
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to your branch**: `git push origin feature/amazing-feature`
7. **Open a Pull Request**

## Roadmap

### Phase 1: Foundation ✅
- [x] Read-only project access
- [x] 7 resources, 9 query tools, 6 prompts
- [x] Project structure parsing
- [x] Official documentation access

### Phase 2: Enhanced Analysis ✅
- [x] Event sheet flow visualization (Mermaid diagrams)
- [x] Object dependency graph
- [x] Performance analysis tools
- [x] Asset usage tracking
- [x] Orphaned object detection
- [x] Function mapping across event sheets

### Phase 3: Safe Modifications ✅
- [x] Object creation with proper SID/UID management
- [x] Instance variable and behavior management
- [x] Event sheet creation and event insertion
- [x] Layout creation and instance placement
- [x] Project metadata updates
- [x] Automatic backup, validation, and verification
- [x] Reference checking before deletion
- [x] Addon auto-registration for known plugins

### Phase 4: Event Blocks & Animation ✅
- [x] Event block creation (conditions + actions) with group path targeting
- [x] Script action support (inline JavaScript)
- [x] Animation management (add/update animations on Sprites)
- [x] Object class validation against project entities

### Phase 5: Event & Layout Operations ✅
- [x] Delete events from sheets by SID or include name (dry-run, force, checks for references to the functions and event variables it removes)
- [x] Update existing event blocks (modify/add/remove conditions and actions)
- [x] Delete layouts (with reference checking, startup layout protection)
- [x] Update layout properties (event sheet binding, dimensions)
- [x] Full instance property overrides (angle, color, instanceVariables, behaviors, tags, etc.)
- [x] 278 tests, type-safe templates, domain-split tool modules

### Phase 6: Runtime Control ✅
- [x] Injectable runtime bridge (runOnStartup, command queue, tick processing)
- [x] Bridge commands: callFunction, get/setGlobalVar, getObjectState, evaluateExpression, etc.
- [x] Project cloning with bridge injection
- [x] Export-for-preview pre-flight checks (worker mode, bridge registration)
- [x] Bridge eval script generation (curl/python for browser CDP)
- [x] Persistent CDP connection discovery and cleanup
- [x] Serve an exported game and launch Chrome on it; screenshots; input in layout coordinates
- [x] Event subscriptions: global-variable changes, layout changes and custom events in bounded buffers
- [x] Direct runtime bridge command execution with bounded polling
- [x] Runtime condition waits with bounded polling and graceful timeout results
- [x] Mouse, touch, keyboard, and text input simulation over CDP

### M1 Primitive Surface ✅ (v1.8)
- [x] Layers, instance updates and instance removal
- [x] Families (create, update members and variables, delete)
- [x] Animation frames (add, update, delete, replace image) and animation rename/delete
- [x] Timelines (create, update, delete, list, details)
- [x] Addon registry tools (`list_addons`, `register_addon`, `unregister_addon`)
- [x] Project integrity validation and event group settings
- [x] `.c3p` packing (`pack_project`) and an end-to-end acceptance test

### Phase 7: Working Beside the Editor and Deeper Validation ✅
- [x] File stamps: a write from content Construct has since saved is refused until `reload_project`
- [x] Change journal: every result names the files it changed; `list_changes` and `revert_last_change`
- [x] `project.c3proj` written in the shape Construct r495.2 saves, without pruning `usedAddons`
- [x] Third-party addon conditions and actions checked from their own definitions
- [x] Expressions inside parameters parsed and their names resolved
- [x] Editor checklist coverage table in [FORK.md](FORK.md)

### Editor Fidelity ✅ (v1.9)
- [x] Editor load-time checks in `validate_project` and before event sheet writes
- [x] Event shapes, names, image file names and instance behavior entries as the editor writes them, with repair tools for older sheets
- [x] Event locator and outline by editor event number, runtime trap analysis and curated pitfalls
- [x] Reference-checked deletes, ambiguous-SID protection and nested sub-layers in every layout tool
- [x] Byte-faithful writes (line endings, BOM, file-name case)

### Phase 8: Advanced Features
- [x] Support for .c3p (zipped) projects: pass a `.c3p` path; see [Single-file (.c3p) projects](#single-file-c3p-projects)
- [x] Rename with reference updates (dry-run preview): the six `rename_*` tools
- [x] Bulk operations: the four bulk instance tools, plus the many-item edits of the event, object, tilemap and timeline tools
- [ ] Plugin development assistance

## Known Limitations

- **One Writer at a Time for a .c3p**: The server writes a `.c3p` back after each change and refuses to overwrite one Construct saved in the meantime. Do not edit the same archive in Construct and through the server at once.
- **Folder projects and the editor**: every tool reads a file fresh before writing it, and a call whose files Construct saved in the meantime says so in its result; a write made from a stale bulk read is refused until `reload_project`. Still, close the project in Construct before editing it here: the editor keeps its own copy and saves over yours.
- **The game must be exported first**: `serve_preview` serves and launches an HTML5 export, and `connect_to_game` reaches any browser started with a remote-debugging port, but Construct exports only from its editor; the tools cannot produce the export, and the editor's own preview is not reachable over CDP.
- **ACE validation needs definitions**: conditions and actions of Construct's built-in plugins and behaviors are checked against the definitions Construct r495.2 ships, and a third-party addon's against its own `aces.json` once loaded (`C3_ADDON_DEFINITIONS` or `load_addon_definitions`); `validate_project` names the addons still unloaded. A problem is a warning, not a refusal. Expressions inside parameter values are parsed and their names resolved against the project ([details](docs/API.md#expression-checking)); the type a parameter expects is not checked against the expression's type
- **Load-time rules are the known ones**: only the editor load-time rules listed under `validate_project` are checked. Triggers are recognised by the `on-` id convention, which third-party addons do not always follow, so their trigger problems are warnings only

## License

MIT License - see [LICENSE](LICENSE) file for details

## Authors

**Contributors**
- Initial development and architecture

## Acknowledgments

- [Anthropic](https://www.anthropic.com/) - For creating the Model Context Protocol
- [Scirra](https://www.construct.net/) - For Construct 3 game engine
- The MCP Community - For inspiration and examples

## Support

This fork and upstream have separate issue trackers. See [FORK.md](FORK.md) for which belongs where.

- **This fork**: [Issues](https://github.com/BeatsByZann/construct3-mcp/issues) - for anything this fork added or changed
- **Upstream**: [Issues](https://github.com/liauw-media/construct3-mcp/issues), [Discussions](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Made with care for the Construct 3 community**

[Back to top](#construct3-mcp-server)
