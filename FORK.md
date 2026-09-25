# About this fork

This repository is a fork of [liauw-media/construct3-mcp](https://github.com/liauw-media/construct3-mcp).
It is maintained by [@BeatsByZann](https://github.com/BeatsByZann) for a private Construct 3
project that needed the MCP server to write parts of a project the upstream server does not reach.

The fork has diverged substantially. Read this file before assuming that anything here is upstream
behavior, and before filing an issue.

## Where the code is

The default branch is not the interesting one. The work lives on a feature branch.

| Branch | What it is |
|---|---|
| `main` | Upstream `main` plus the seven correctness commits offered upstream as [PR #15](https://github.com/liauw-media/construct3-mcp/pull/15). It is the head of that pull request, so it is kept close to upstream on purpose. The tool surface here is upstream's. |
| `claude/w84-editor-gap` | The diverged line. Everything described below is on this branch. Use it if you came here for the extra tools. |

```bash
git clone -b claude/w84-editor-gap https://github.com/BeatsByZann/construct3-mcp.git
cd construct3-mcp
npm ci
npm run build
node dist/index.js /path/to/your/project.c3proj
```

## How far it has diverged

Measured at `d4eaea4` (2026-09-24) against `upstream/main` (`b6d7d58`).

| Measure | Upstream | This fork |
|---|---|---|
| MCP tools registered | 66 | 185 |
| Source files under `src/` | 32 | 66 |
| Test files | 16 | 71 |
| Tests | not measured here | 1470 passing in 71 files |
| Package version | 1.8.1 | 1.8.2 |

At that commit the branch is 90 commits ahead of upstream and one commit behind it (`b6d7d58`, a
`.gitignore` chore). The common ancestor is `6957fcb` (2026-07-27). The diff is 171 files changed,
79,192 insertions and 1,292 deletions.

No upstream tool was removed or renamed. All 66 upstream tools are still registered under their
upstream names, so an existing configuration keeps working. The fork adds 119 tools alongside them.

## What the fork adds

119 new tools, grouped by the area they cover.

| Area | Tools |
|---|---|
| Flowcharts (new area) | `list_flowcharts`, `get_flowchart_details`, `create_flowchart`, `delete_flowchart`, `add_flowchart_node`, `update_flowchart_node`, `delete_flowchart_node`, `add_flowchart_output`, `update_flowchart_output`, `delete_flowchart_output`, `reorder_flowchart_outputs`, `connect_flowchart_nodes`, `disconnect_flowchart_nodes` |
| Timeline tracks and keyframes (new area) | `add_timeline_track`, `remove_timeline_track`, `add_property_track`, `remove_property_track`, `set_keyframe`, `delete_keyframe`, `update_track`, `add_value_track`, `add_audio_track`, `list_timeline_tracks`, `add_timeline_folder`, `rename_timeline_folder`, `delete_timeline_folder`, `move_timeline_track` |
| Custom eases (new area) | `list_eases`, `create_ease`, `update_ease`, `delete_ease` |
| Tilemaps (new area) | `get_tilemap_data`, `set_tilemap_data`, `set_tilemap_tiles`, `list_tilemap_brushes`, `add_tilemap_brush`, `update_tilemap_brush`, `delete_tilemap_brush` |
| Effects (new area) | `list_effects`, `add_effect`, `update_effect`, `remove_effect`, `reorder_effects` |
| Containers (new area) | `list_containers`, `create_container`, `update_container`, `delete_container` |
| Templates (new area) | `list_templates`, `set_default_template`, `set_instance_template` |
| Rename, with reference rewriting (new area) | `rename_object_type`, `rename_family`, `rename_layout`, `rename_layer`, `rename_event_sheet`, `rename_event_variable` |
| Find and replace (new area) | `replace_object_in_events`, `replace_in_expressions` |
| Project Bar structure (new area) | `move_project_item`, `duplicate_layout`, `duplicate_layer`, `duplicate_event_sheet`, `duplicate_object_type`, `duplicate_timeline` |
| Read-only usage queries (new area) | `get_project_properties`, `search_project`, `find_behavior_usage`, `find_effect_usage`, `find_instance_variable_references`, `get_instance_counts` |
| Script and project files (new area) | `register_script_file`, `deregister_script_file`, `register_project_file`, `deregister_project_file`, `create_data_file`, `set_main_script` |
| Event-sheet authoring | `add_custom_action`, `update_function`, `update_event_group`, `update_comment`, `update_script_event`, `move_event_block`, `move_event_block_items` |
| Layouts, layers and hierarchy | `move_instance`, `add_instances_to_layout`, `update_instances`, `move_instances`, `delete_instances_from_layout`, `move_layer`, `reorder_layers`, `set_instance_parent`, `remove_instance_children` |
| Objects and animation | `reorder_behaviors`, `update_instance_variable`, `replace_object_image`, `create_animation_folder`, `move_animation_to_folder`, `duplicate_frame`, `reorder_frames`, `reverse_frames` |
| Live runtime control over CDP | `connect_to_game`, `disconnect_from_game`, `call_bridge`, `wait_for_condition`, `simulate_input`, `get_canvas_size` |
| Play-testing an exported game (new area) | `serve_preview`, `stop_preview`, `screenshot_game` |
| Runtime event subscriptions (new area) | `subscribe_events`, `read_events`, `unsubscribe_events` |
| Working beside the open editor (new area) | `reload_project`, `list_changes`, `revert_last_change` |
| Single-file projects | `get_open_project`, `open_project` |
| Third-party addon validation | `load_addon_definitions` |
| Project settings | `update_project_properties` |

The largest change in kind is live runtime control. Upstream generates a bridge script and leaves
you to drive it from a browser console or an external tool. This fork serves an exported game over
loopback and launches Chrome or Edge on it, keeps a persistent Chrome DevTools Protocol connection
to the running game, calls bridge commands directly, polls for a condition with a bounded timeout,
buffers global-variable, layout and custom events between calls, sends mouse, touch and keyboard
input in viewport, canvas or layout coordinates, and saves screenshots.

## What the fork changes in existing tools

These are behavior changes, not additions. They matter if you already depend on upstream output.

- Event serialization matches what Construct r495 writes for OR blocks, else blocks and function
  calls. Upstream writes shapes the editor does not round-trip cleanly.
- `add_event_block` and `update_event_block` write nested blocks, action comments, function calls
  and custom action calls, and set `isOrBlock` and per-condition `disabled`.
- Instance origin, blend mode and depth are stored the way r495.2 stores them, and new instances
  can be placed on sub-layers.
- `validate_project` reports a `complete` flag saying whether every object type, event sheet and
  layout was actually scanned, and the orphan scan recurses and skips Construct editor UI-state
  files.
- The UID and SID generator scans sub-layers and single-image IDs, and no longer stops minting
  UIDs when a file is missing.
- Delete tools deregister before removing an entity file, so caches stay consistent when a delete
  fails part way.
- Filesystem paths are redacted out of error messages returned to the client.
- `validate_project`, `add_event_block`, `update_event_block`, `update_event_block_action` and the
  two replace tools check
  built-in conditions and actions against the definitions Construct r495.2 ships, and warn about
  unknown IDs, unknown or missing parameters and invalid combo choices.
- Object types backed by an image or a plugin table (3D Shape, Particles, Sprite Font, Tilemap,
  9-patch) are created with the files and tables Construct needs, so the project still opens.
- Every expression in a parameter is parsed and its names resolved against the project;
  `validate_project` reports `expression-*` warnings and the event tools warn about what they
  write. Conditions and actions of a third-party addon are checked once its definitions are loaded
  (`load_addon_definitions` or `C3_ADDON_DEFINITIONS`); until then `validate_project` lists it as
  `ace-definitions-unavailable` instead of skipping it silently. `validate_project` runs 18 checks,
  including `event-legacy-key` for keys Construct neither writes nor reads.
- Every tool result ends with the files that call changed. A write is refused when the file
  changed on disk since the server read it (Construct saved it, for example) until
  `reload_project` re-reads the project.
- `project.c3proj` is written in the shape Construct r495.2 saves (script metadata key, a
  `models3d` folder and, for older projects, property order and `zAxisScale`), so the editor's
  next save does not show changes the tool did not make. `usedAddons` is never pruned.
- `connect_to_game` accepts only this machine unless `allowRemoteHost` is set, because the bridge
  runs script in whatever page it reaches.
- Renames compare names without case, and a rename that changes only the case of a file-backed
  name is refused: on Windows it overwrote or deleted the file. `delete_layer` counts instances on
  sub-layers, frame tools follow each frame's real file type (GIF included), and
  `rename_event_variable` stays inside the declaring scope.

The per-change detail, including the r495.2 sample sizes the shapes were derived from, is in
[CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`. The per-tool reference is in
[docs/API.md](docs/API.md).

## Relationship to upstream

Seven correctness commits were offered upstream as PR #15 and are on this fork's `main`. The 119
added tools have not been offered upstream and are not scheduled to be; they were built against
the needs of one project and against Construct r495.2 specifically.

This fork does not track upstream automatically. Upstream is the place to file issues about
upstream behavior. File an issue here only about something this fork changed or added, and say
which branch you are on.

- Upstream: <https://github.com/liauw-media/construct3-mcp>
- This fork's issues: <https://github.com/BeatsByZann/construct3-mcp/issues>

## How much of the editor the tools reach

The tools edit project files with the project closed, so the question "which of the editor's
capabilities can an agent reproduce through the tools" has a measurable answer: each item of
the Construct editor acceptance checklist is mapped, in `scripts/editor-coverage.json`, to a
status and the tools that produce the same end state in the files.

| Status | Meaning |
|---|---|
| Covered | A tool writes or reads the same end state in the project files |
| Partial | Part of it; the item's note in the mapping says which part is the caller's |
| Open | The end state lives in project files, but no tool writes it yet |
| Editor-only | No file representation: a menu, dialog, selection gesture, view, preview, debugger, export or drawing operation |

<!-- editor-coverage:start -->
Measured against the 425-item editor acceptance checklist (c3-editor-acceptance version 1, Construct r495.2 (baselines)) by `node scripts/editor-coverage.mjs`.

| Surface | Items | Covered | Partial | Open | Editor-only |
|---|---|---|---|---|---|
| EVC Event sheet conditions | 26 | 17 | 1 | 1 | 7 |
| EVA Event sheet actions and parameters | 22 | 14 | 0 | 1 | 7 |
| EVS Event sheet structure and navigation | 34 | 19 | 0 | 2 | 13 |
| EVV Event variables, functions and custom actions | 15 | 14 | 0 | 0 | 1 |
| PB Project Bar | 24 | 14 | 2 | 1 | 7 |
| PRB Properties Bar | 19 | 10 | 0 | 1 | 8 |
| LVT Layout View tools | 46 | 10 | 5 | 3 | 28 |
| LYR Layers Bar, Z Order Bar and Instances Bar | 17 | 7 | 4 | 1 | 5 |
| ANE Animations Editor | 42 | 11 | 6 | 2 | 23 |
| TMB Tilemap Bar | 24 | 12 | 3 | 0 | 9 |
| TLB Timeline Bar | 29 | 12 | 8 | 3 | 6 |
| FCV Flowchart View | 16 | 15 | 0 | 0 | 1 |
| MEN Main menu, main toolbar, bars and tabs | 25 | 0 | 2 | 0 | 23 |
| DLG Dialogs the editor can raise | 40 | 15 | 7 | 1 | 17 |
| OUT Preview, debug, export, save and backups | 32 | 1 | 2 | 0 | 29 |
| SCR Scripting, code and file editors | 14 | 6 | 5 | 0 | 3 |
| **All** | **425** | **177** | **45** | **16** | **187** |

Of the 238 items that have a file representation, 177 are covered by a tool, 45 partly, and 16 not at all. The 187 editor-only items are menus, dialogs, selection gestures, views, preview, debugging, export and drawing, which no project-file edit can reproduce.

Open items: EVC-23 (breakpoints live in the sheet's uistate file, which no tool writes); EVA-12 (breakpoints live in uistate); EVS-14 (breakpoints live in uistate); EVS-15 (bookmarks live in uistate); PB-15 (icon purpose has no tool); PRB-17 (mesh points have one sample and no tool); LVT-25 (3D models have no sample and no tool); LVT-29 (meshes have one sample and no tool); LVT-30 (meshes have one sample and no tool); LYR-15 (instance folders live in uistate); ANE-40 (3D model textures have no sample and no tool); ANE-41 (per-tile collision polygons have no tool); TLB-17 (swapping the instance a track drives has no tool); TLB-24 (nested timelines have no sample and no tool); TLB-26 (nested timelines have no sample and no tool); DLG-01 (no tool creates a project from scratch).
<!-- editor-coverage:end -->

`node scripts/editor-coverage.mjs --list open` (or `partial`) prints the items of one status
with their notes. A test keeps the table above equal to the mapping and refuses a tool name
that is not registered.

## Caveats

- Verified against Construct 3 r495.2 on folder-format projects. Other releases are untested.
- A `.c3p` is served through a working folder and written back after each change, either from
  the command line or by `open_project`, which switches a running server to another project; see the
  README's "Single-file (.c3p) projects". Construct saving the same archive meanwhile makes the
  server refuse to write, so do not edit one archive in both at once.
- `serve_preview` needs Chrome or Edge installed to launch a browser; it serves an exported game
  (Export > Web (HTML5)), not a source project, because Construct exports only from its editor.
- The feature branch is a working branch, not a release. It is not published to npm and carries no
  compatibility promise.
- MIT licensed, the same as upstream. See [LICENSE](LICENSE).
