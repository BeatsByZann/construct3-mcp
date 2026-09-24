# Construct3 MCP Server

> A Model Context Protocol (MCP) server that enables AI assistants (Claude, Cursor, Antigravity, and any MCP-compatible tool) to safely read, analyze, and modify Construct 3 game engine projects.

> **v1.8.0 (M1 release)** — Full primitive surface complete. See the [Roadmap](#roadmap) and [CHANGELOG](CHANGELOG.md) for details.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)

---

## This is a fork

This branch is a fork of [liauw-media/construct3-mcp](https://github.com/liauw-media/construct3-mcp)
and has diverged from it: **179 MCP tools instead of upstream's 66**, with 113 added and none
removed or renamed. It adds whole areas upstream does not cover (flowcharts, timeline tracks and
keyframes, custom eases, tilemap data and brushes, effects, containers, templates, renames with
reference rewriting, find and replace, Project Bar moves and duplicates, script and project file
registration) and replaces the generated-script runtime bridge with live Chrome DevTools Protocol
control of a running preview.

It also changes how some upstream tools serialize their output, to match what Construct r495.2
actually writes. **[FORK.md](FORK.md) is the full list of what was added, what was changed, and
how this relates to upstream.** Read it before filing an issue, and note which branch you are on:

| Branch | What it is |
|---|---|
| `main` | Close to upstream on purpose. It is the head of upstream [PR #15](https://github.com/liauw-media/construct3-mcp/pull/15), so it carries only those correctness fixes. Upstream's 66 tools. |
| `claude/w84-editor-gap` | The diverged line described in this README. All 179 tools. |

Everything below this notice describes `claude/w84-editor-gap`.

---

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
| `construct3://docs/manual/{topic}` | Official Construct 3 documentation |

### Query Tools (Read-Only)

| Tool | Description |
|------|-------------|
| `list_objects` | List all object types with optional name filtering |
| `list_eventsheets` | List all event sheets |
| `list_layouts` | List all layouts |
| `list_families` | List all object families |
| `get_object_details` | Get detailed info about a specific object |
| `get_eventsheet_details` | Get detailed info about an event sheet |
| `get_layout_details` | Get detailed info about a layout |
| `search_objects` | Search objects by name pattern |
| `get_project_summary` | Get comprehensive project summary |

### Project Session Tools

| Tool | Description |
|------|-------------|
| `get_open_project` | Report the project the server serves: name, `.c3proj` path, and for a `.c3p` the archive and its working folder |
| `open_project` | Switch to another project folder, `.c3proj` or `.c3p` while the server runs; see [Single-file (.c3p) projects](#single-file-c3p-projects) |

### Analysis Tools

| Tool | Description |
|------|-------------|
| `get_eventsheet_flow` | Event sheet include hierarchy and layout bindings (Mermaid or JSON) |
| `get_function_map` | Function definitions and call sites across event sheets |
| `get_object_dependencies` | Where objects are used (event sheets, layouts, families) |
| `find_orphaned_objects` | Find objects not referenced in any event sheet or layout |
| `get_asset_usage` | Track sound, image, font, and video asset usage |
| `load_addon_definitions` | Load a third-party addon's conditions and actions (addon.json and aces.json, unpacked or as a .c3addon) so its ACEs are checked like the built-in ones; without a path, list what is loaded |
| `analyze_performance` | Heuristic performance audit with categorized issues |
| `validate_project` | Integrity checks: file existence, duplicate SIDs/UIDs, broken references, conditions and actions against Construct r495.2's own definitions, orphaned files; `complete` says whether every object type, event sheet and layout was scanned |
| `get_project_properties` | Every project setting: the full `properties` bag and top-level settings such as `bundleAddons` |
| `search_project` | Find text or a regular expression across event sheets, script files and layout instance values |
| `find_behavior_usage` | Declarations, event references and per-instance settings of a behavior |
| `find_effect_usage` | Object types, families, layouts, layers and instances that use an effect |
| `find_instance_variable_references` | Event references (ACE parameters, expressions, call arguments) and stored values of an instance variable |
| `get_instance_counts` | Placed instances per object type and layout, including sub-layers and non-world instances |
| `get_group_settings` | Every event group's active-on-start and disabled settings, optionally for one sheet |

### Mutation Tools (Safe Write Operations)

| Tool | Description |
|------|-------------|
| `create_object` | Create a new object type (Sprite, Text, TiledBg, global plugins, etc.) |
| `update_object_properties` | Add/remove instance variables and behaviors on an object, and edit a single-global object's settings |
| `reorder_behaviors` | Reorder the behaviors of an object type or family |
| `replace_object_image` | Replace the image of a Tiled Background, 9-patch, Particles, Sprite Font or Tilemap object |
| `move_instance` | Move a placed instance to another layer or change its Z order |
| `delete_object` | Delete an object (with reference checking and optional force) |
| `create_event_sheet` | Create a new event sheet with optional includes |
| `add_event_to_sheet` | Add a group, function, variable, include, or comment to a sheet |
| `add_event_block` | Add a block event at the sheet root, under a parent SID, or beside a sibling SID |
| `delete_event_sheet` | Delete an event sheet (with reference checking and optional force) |
| `delete_event_from_sheet` | Delete an event from a sheet by SID or include name (dry-run, force) |
| `move_event_block_items` | Reorder or move actions/conditions within or between blocks while preserving SIDs, or copy them with fresh SIDs (`copy: true`) |
| `move_project_item` | Move an object type, family, layout, event sheet, flowchart, script or project file to another Project Bar folder, moving its files with it |
| `duplicate_layout` | Copy a layout with fresh SIDs, new UIDs and remapped hierarchy links |
| `duplicate_layer` | Copy a layer inside its layout, placed above the source |
| `duplicate_event_sheet` | Copy an event sheet with fresh SIDs (refused when it declares groups, functions, custom actions or global variables) |
| `duplicate_object_type` | Copy an object type with fresh SIDs and image IDs, its image files and its tilemap brush |
| `duplicate_timeline` | Copy a timeline under a new name |
| `replace_object_in_events` | Construct's Replace object: swap one object type or family for another in one sheet or all sheets, skipping events the replacement cannot serve (`dryRun`) |
| `replace_in_expressions` | Find and replace text in condition and action parameters, scoped by sheet and parameter key (`dryRun`) |
| `update_event_block` | Update an existing block: modify, insert, replace, add, or remove actions and conditions |
| `create_layout` | Create a new layout with configurable layers |
| `add_instance_to_layout` | Place an object instance on a layout layer with full property control |
| `delete_layout` | Delete a layout (blocks startup layout, checks references) |
| `update_layout` | Update layout event sheet binding and dimensions |
| `update_project_metadata` | Update project name, version, author, or description |
| `add_animation_to_sprite` | Add a new animation to a Sprite object |
| `update_animation_properties` | Update animation speed, looping, ping-pong on a Sprite |
| `register_script_file` | Register a script in `rootFileFolders.script` with `script-info` metadata and a collision-safe SID |
| `deregister_script_file` | Remove a script registration while preserving the script file |
| `register_project_file` | Copy a file into `files/` and register it in the general, sound, music, video, or font family |
| `deregister_project_file` | Deregister a Project File and remove its file under `files/` |
| `list_timeline_tracks` | Summarize a timeline's tracks by kind, including untyped tracks from older releases |
| `add_value_track` / `add_audio_track` | Add a value track or an audio track playing a registered sound or music file |
| `add_timeline_folder` / `rename_timeline_folder` / `delete_timeline_folder` / `move_timeline_track` | Organize timeline tracks in track folders |
| `list_eases` / `create_ease` / `update_ease` / `delete_ease` | Custom ease curves in `timelines/transitions/`, kept in step with the timelines that use them |

### More Mutation Tools, by Area

The table above covers the general write tools. The tools below complete the set, grouped by what they edit; [docs/API.md](docs/API.md) gives the parameters of every one.

#### Events

| Tool | Description |
|------|-------------|
| `update_event_block_action` | Replace the parameters of one action in a block, by block SID and action index |
| `move_event_block` | Move an event to another container in the same sheet, keeping its SID and every descendant |
| `move_events_between_sheets` | Copy or move top-level events to another sheet; a move keeps SIDs, a copy gets fresh ones |
| `remove_event_from_sheet` | Remove an include from a sheet, by the name of the sheet it includes |
| `add_custom_action` | Add a custom action definition owned by an object type or family |
| `update_function` | Update a function or custom action definition; a rename rewrites every call when `renameCallers` is set |
| `update_event_group` | Update a group in place: title, description, active on start, disabled, colors |
| `update_event_variable` | Change an event variable declaration: name, type, initial value, flags, comment |
| `update_comment` | Update a comment, addressed by its index in its container |
| `update_script_event` | Replace the JavaScript of a standalone script block, or remove the block |

#### Layouts, Layers and Instances

| Tool | Description |
|------|-------------|
| `add_layer` / `delete_layer` | Add a layer, optionally as a sub-layer, or delete one (never the last) |
| `update_layer` | Update a layer: name, visibility, parallax, blend mode, color, sampling, render settings |
| `reorder_layers` / `move_layer` | Reorder one nesting level, or move a layer to another nesting level |
| `update_instance` | Update a placed instance: position, size, angle, visibility and other properties |
| `delete_instance_from_layout` | Remove a placed instance by UID |
| `add_instances_to_layout` | Place up to 500 instances on one layout in one call; if any item fails, nothing is written (`dryRun`) |
| `update_instances` | Update up to 500 placed instances of one layout in one call, all or nothing (`dryRun`) |
| `move_instances` | Move up to 500 world instances of one layout between layers or Z positions in one call, applied in list order, all or nothing (`dryRun`) |
| `delete_instances_from_layout` | Remove up to 500 instances of one layout by UID in one call, detaching hierarchy links, all or nothing (`dryRun`) |
| `set_instance_parent` / `remove_instance_children` | Attach an instance to a hierarchy parent or detach it, or detach all of its children |

#### Object Types, Families and Containers

| Tool | Description |
|------|-------------|
| `update_instance_variable` | Rename, retype or describe an instance variable, keeping placed instances and event references in step |
| `create_family` / `update_family` / `delete_family` | Create a family, change its members, shared variables and behaviors, or delete it |
| `list_containers` / `create_container` / `update_container` / `delete_container` | Object containers, whose members Construct creates, picks and destroys together |

#### Sprite Animations

| Tool | Description |
|------|-------------|
| `rename_animation` / `delete_animation` | Rename an animation, renaming its frame files to match, or delete one (never the last) |
| `add_frame_to_animation` / `delete_frame_from_animation` / `duplicate_frame` | Add a blank frame, delete a frame (never the last), or copy a frame with its image |
| `update_frame` | Per-frame duration, size, origin, tag, image points and collision polygon |
| `replace_sprite_image` | Replace one frame's image with PNG data |
| `reorder_frames` / `reverse_frames` | Reorder or reverse the frames, renaming their image files to match |
| `create_animation_folder` / `move_animation_to_folder` | Organize animations in subfolders |

#### Timelines

Track folders and custom eases are in the table above.

| Tool | Description |
|------|-------------|
| `list_timelines` / `get_timeline_details` | List timelines, or read one in full |
| `create_timeline` / `update_timeline` / `delete_timeline` | Create, update or delete a timeline |
| `add_timeline_track` / `remove_timeline_track` | Add an instance track for a placed instance, or remove any track with its keyframes |
| `add_property_track` / `remove_property_track` | Add or remove one property track of an instance track |
| `set_keyframe` / `delete_keyframe` | Create, update or delete the keyframes at a time on a track |
| `update_track` | A track's playback properties; value and audio tracks can also be renamed |

#### Flowcharts

| Tool | Description |
|------|-------------|
| `list_flowcharts` / `get_flowchart_details` | List flowcharts, or read one's nodes, outputs and connections |
| `create_flowchart` / `delete_flowchart` | Create an empty flowchart and register it, or delete one |
| `add_flowchart_node` / `update_flowchart_node` / `delete_flowchart_node` | Add, update or delete a node; a delete removes every reference to it |
| `add_flowchart_output` / `update_flowchart_output` / `delete_flowchart_output` | Add, update or delete a node's output pins |
| `reorder_flowchart_outputs` | Reorder a node's outputs, which is their execution order |
| `connect_flowchart_nodes` / `disconnect_flowchart_nodes` | Wire an output to a node, or unwire it |

#### Effects and Addons

| Tool | Description |
|------|-------------|
| `list_effects` | The effects on an object type, family, layer or layout, and the registered effect addons |
| `add_effect` / `update_effect` / `remove_effect` / `reorder_effects` | Attach, change, detach or reorder effects |
| `list_addons` / `register_addon` / `unregister_addon` | The project's registered plugins, behaviors and effects; an effect must be registered before `add_effect` |

#### Project Settings and Files

| Tool | Description |
|------|-------------|
| `update_project_properties` | Any project setting, plus the first layout, viewport size, worker mode and functions name |
| `create_data_file` | Create an Array, Dictionary, JSON or text data file and register it |
| `set_main_script` | Mark one registered script as the main script |

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
| `serve_preview` | Serve an exported game folder over loopback HTTP and optionally launch Chrome on it with a debugging port |
| `stop_preview` | Stop a preview server and the browser it launched |
| `generate_bridge_eval_script` | Generate a curl/python script to execute a bridge command via browser remote debugging |
| `export_for_preview` | Pre-flight checks (worker mode, bridge injection) for preview testing |
| `clone_project` | Deep-copy the project with optional bridge injection |
| `pack_project` | Pack the folder-format project as a `.c3p` archive |

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

## Safety Model

All mutation tools follow a strict safety protocol:

1. **Validation** — Names checked for reserved words, path traversal, format. Plugin/behavior IDs validated against `usedAddons`.
2. **Backup** — Every file is backed up to `<filename>.bak` before modification.
3. **ID Generation** — SIDs (15-digit random), UIDs (sequential), and imageSpriteIds (7-digit) are collision-checked against the entire project.
4. **Write** — JSON is pre-validated (round-trip test, size limit) before writing.
5. **Verify** — Files are read back and re-parsed after writing to confirm integrity.
6. **Cache Invalidation** — All reader caches and indexes are cleared so subsequent reads see fresh data.

Additional safeguards:
- **Reference checking** — `delete_object`, `delete_event_sheet`, and `delete_layout` scan for references before deleting.
- **Addon auto-registration** — When creating objects with new plugins or adding behaviors, known Scirra addons are automatically registered in `usedAddons`. Unknown/third-party addons are blocked with an error.
- **Global plugin protection** — Singleglobal-inst objects (Audio, AJAX, etc.) cannot be placed on layouts.
- **Plugin-specific defaults** — Instances are created with correct default properties for each plugin type (Sprite, Text, TiledBg, NinePatch).
- **Image generation** — Sprite and TiledBg creation automatically generates valid placeholder PNGs with correct naming conventions. Batch writes roll back on failure.
- **Layout instance sync** — When behaviors or variables are added to an object type, all layout instances of that object are automatically updated with the required `behaviors` and `instanceVariables` dicts so C3 can load the project correctly.

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
│   ├── construct3/
│   │   ├── c3p-project.ts          # Serve a .c3p through a working folder, written back after each change
│   │   ├── project-session.ts      # The served project, and switching it at runtime
│   │   ├── project-reader.ts       # Project file parser and cache
│   │   ├── project-writer.ts       # Safe write operations with backup
│   │   ├── id-generator.ts         # SID/UID generation with collision avoidance
│   │   ├── templates.ts            # Object, event sheet, layout templates
│   │   ├── png-generator.ts        # Zero-dep placeholder PNG generation
│   │   ├── ace-catalog.ts          # Condition and action validation
│   │   ├── ace-catalog-data.ts     # Construct r495.2 ACE definitions (generated)
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/
│   │       ├── index-builder.ts    # Cross-reference index
│   │       ├── eventsheet-flow.ts  # Event sheet flow analysis
│   │       ├── function-map.ts     # Function mapping
│   │       ├── object-deps.ts      # Object dependency analysis
│   │       ├── orphan-finder.ts    # Orphaned object detection
│   │       ├── asset-usage.ts      # Asset usage tracking
│   │       └── performance.ts      # Performance heuristics
│   ├── resources/
│   │   ├── project.ts              # MCP resources
│   │   └── docs.ts                 # Construct 3 documentation access
│   ├── runtime/
│   │   ├── bridge.ts               # Injectable C3 runtime bridge script generator
│   │   ├── cdp-client.ts           # Persistent CDP connections and bridge calls
│   │   ├── preview-server.ts       # Serves an exported game and launches Chrome on it
│   │   ├── project-files.ts        # The files a folder project packs into a .c3p
│   │   ├── zip-reader.ts           # Dependency-free .c3p archive reader (ZIP64, DEFLATE)
│   │   └── zip-writer.ts           # Dependency-free .c3p archive writer
│   ├── tools/
│   │   ├── query.ts                # 9 query tools
│   │   ├── analysis.ts             # 8 analysis tools
│   │   ├── usage-tools.ts          # 6 usage and search tools
│   │   ├── session-tools.ts        # 2 project session tools
│   │   ├── shared.ts               # Shared validation, error helpers
│   │   ├── mutations.ts            # Registers every mutation tool module
│   │   ├── event-tools.ts          # 17 event sheet tools
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
│   │   └── runtime-tools.ts        # 16 runtime control tools
│   └── prompts/
│       └── workflows.ts            # 6 workflow prompts
├── dist/                           # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── CHANGELOG.md
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
- [x] Delete events from sheets by SID or include name (dry-run, force, function caller checking)
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
- [x] Direct runtime bridge command execution with bounded polling
- [x] Runtime condition waits with bounded polling and graceful timeout results
- [x] Mouse, touch, keyboard, and text input simulation over CDP

### Phase 7: Advanced Features
- [x] Support for .c3p (zipped) projects: pass a `.c3p` path; see [Single-file (.c3p) projects](#single-file-c3p-projects)
- [x] Rename with reference updates (dry-run preview): the six `rename_*` tools
- [x] Bulk operations: the four bulk instance tools, plus the many-item edits of the event, object, tilemap and timeline tools
- [ ] Plugin development assistance

## Known Limitations

- **One Writer at a Time for a .c3p**: The server writes a `.c3p` back after each change and refuses to overwrite one Construct saved in the meantime. Do not edit the same archive in Construct and through the server at once.
- **The game must be exported first**: `serve_preview` serves and launches an HTML5 export, and `connect_to_game` reaches any browser started with a remote-debugging port, but Construct exports only from its editor; the tools cannot produce the export, and the editor's own preview is not reachable over CDP.
- **ACE validation needs definitions**: conditions and actions of Construct's built-in plugins and behaviors are checked against the definitions Construct r495.2 ships, and a third-party addon's against its own `aces.json` once loaded (`C3_ADDON_DEFINITIONS` or `load_addon_definitions`); `validate_project` names the addons still unloaded. A problem is a warning, not a refusal. Expressions inside parameter values are parsed and their names resolved against the project ([details](docs/API.md#expression-checking)); the type a parameter expects is not checked against the expression's type

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
