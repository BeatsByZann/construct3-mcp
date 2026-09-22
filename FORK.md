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

Measured at `claude/w84-editor-gap` (`e3e4051`) against `upstream/main` (`b6d7d58`).

| Measure | Upstream | This fork |
|---|---|---|
| MCP tools registered | 66 | 173 |
| Source files under `src/` | 32 | 54 |
| Test files | 16 | 56 |
| Tests | not measured here | 1304 passing in 56 files |
| Package version | 1.8.1 | 1.8.2 |

The branch is 78 commits ahead of upstream and one commit behind it (`b6d7d58`, a `.gitignore`
chore). The common ancestor is `6957fcb` (2026-07-27). The diff is 136 files changed,
42,227 insertions and 1,148 deletions.

No upstream tool was removed or renamed. All 66 upstream tools are still registered under their
upstream names, so an existing configuration keeps working. The fork adds 107 tools alongside them.

## What the fork adds

107 new tools, grouped by the area they cover.

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
| Project settings | `update_project_properties` |

The largest change in kind is the last one. Upstream generates a bridge script and leaves you to
drive it from a browser console or an external tool. This fork keeps a persistent Chrome DevTools
Protocol connection to a running preview, calls bridge commands directly, polls for a condition
with a bounded timeout, and sends mouse, touch and keyboard input in viewport or canvas
coordinates.

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
- Object types backed by an image or a plugin table (3D Shape, Particles, Sprite Font, Tilemap,
  9-patch) are created with the files and tables Construct needs, so the project still opens.

The per-change detail, including the r495.2 sample sizes the shapes were derived from, is in
[CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`. The per-tool reference is in
[docs/API.md](docs/API.md).

## Relationship to upstream

Seven correctness commits were offered upstream as PR #15 and are on this fork's `main`. The 107
added tools have not been offered upstream and are not scheduled to be; they were built against
the needs of one project and against Construct r495.2 specifically.

This fork does not track upstream automatically. Upstream is the place to file issues about
upstream behavior. File an issue here only about something this fork changed or added, and say
which branch you are on.

- Upstream: <https://github.com/liauw-media/construct3-mcp>
- This fork's issues: <https://github.com/BeatsByZann/construct3-mcp/issues>

## Caveats

- Verified against Construct 3 r495.2 on folder-format projects. Other releases are untested.
- Folder format only. `.c3p` archives can be written by `pack_project` but not read as input.
- The feature branch is a working branch, not a release. It is not published to npm and carries no
  compatibility promise.
- MIT licensed, the same as upstream. See [LICENSE](LICENSE).
