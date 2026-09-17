# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Query Tools](#query-tools)
- [Analysis Tools](#analysis-tools)
- [Mutation Tools](#mutation-tools)
- [Effect Tools](#effect-tools)
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

### `construct3://docs/manual/{topic}`

Official Construct 3 documentation fetched from construct.net.

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

---

## Analysis Tools

All analysis tools support an optional `detail` parameter: `"summary"`, `"normal"` (default), or `"full"`.

### `get_eventsheet_flow`

Event sheet include hierarchy and layout bindings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Start from a specific sheet (omit for full project) |
| `format` | `"mermaid"` \| `"json"` | No | Output format (default: mermaid) |
| `detail` | string | No | Detail level |

### `get_function_map`

Function definitions and call sites across event sheets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `detail` | string | No | Detail level |

### `get_object_dependencies`

Where objects are used: event sheets, layouts, families, co-occurring objects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object` | string | No | Specific object (omit for project-wide top 20) |
| `detail` | string | No | Detail level |

### `find_orphaned_objects`

Find objects not referenced in any event sheet or placed in any layout. No parameters.

### `get_asset_usage`

Track asset usage across the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"sound"` \| `"music"` \| `"image"` \| `"font"` \| `"video"` \| `"icon"` \| `"general"` \| `"all"` | No | Filter by asset type (default: all) |
| `detail` | string | No | Detail level |

### `analyze_performance`

Heuristic performance audit with categorized issues (info/warning/critical).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | Event sheet or layout name to scope analysis |
| `detail` | string | No | Detail level |

### `validate_project`

Run integrity checks: file existence, required fields, duplicate SIDs/UIDs, broken references, missing addons, orphaned files. No parameters.

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `valid` | boolean | No error-level issues were found in the files that were scanned |
| `complete` | boolean | Every registered object type, event sheet and layout file was read. `false` when any was skipped for exceeding the 10MB read cap (listed in `unscannedFiles`); `valid` then only vouches for the files that were checked. Families are not covered |
| `summary` | object | `{ errors, warnings, info, checksRun, entitiesScanned, unscanned }` |
| `errors` / `warnings` / `info` | `IntegrityIssue[]` | `{ check, entity, message, suggestion? }` |
| `unscannedFiles` | string[] | `category/name` entries the reader could not scan (over the 10MB read cap); each is also an `unscanned-file` warning |

A registered file that does not exist on disk is a `file-existence` error; a file that exists but exceeds the read cap is an `unscanned-file` warning, not an error.

---

## Mutation Tools

All mutation tools follow the safety pipeline: validate → backup → write → verify → invalidate caches. They return a `WriteResult` object on success.

### `create_object`

Create a new object type in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (unique, alphanumeric + underscore + spaces) |
| `pluginId` | string | Yes | Plugin ID: `"Sprite"`, `"Text"`, `"TiledBg"`, `"NinePatch"`, `"Audio"`, etc. |
| `isGlobal` | boolean | No | Auto-detected for known global plugins |
| `subfolder` | string | No | Subfolder path (e.g., `"UI/Buttons"`) |

**What it does:**
1. Validates name (uniqueness, reserved names, format)
2. Ensures plugin is registered in `usedAddons` (auto-adds known Scirra plugins)
3. Generates SID (+ UID for global plugins, + animation SID for Sprite)
4. Builds from plugin-specific template
5. Writes `objectTypes/<name>.json`
6. Adds name to `project.c3proj` objectTypes container

### `update_object_properties`

Update an existing object's instance variables and behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Existing object name |
| `isGlobal` | boolean | No | Change global status |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)

### `delete_object`

Delete an object type from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references in event sheets, layouts, and families
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info when it sits at the category root or one subfolder deep), never a registration that points at nothing; the error names the file to clean up

### `create_event_sheet`

Create a new event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |
| `subfolder` | string | No | Subfolder path |
| `includeSheets` | string[] | No | Sheets to auto-include (validated for existence) |

### `add_event_to_sheet`

Add a structural event to an existing event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name |
| `functionParams` | array | For functions | `[{ name, type }]` |
| `functionReturnType` | enum | For functions | `"none"` \| `"number"` \| `"string"` \| `"any"` (default: none) |
| `functionIsAsync` | boolean | For functions | Mark the function async (default: false) |
| `functionCopyPicked` | boolean | For functions | Copy picked instances into the function (default: false) |
| `variableName` | string | For variables | Variable name |
| `variableType` | enum | For variables | `"number"` \| `"string"` \| `"boolean"` |
| `initialValue` | string | For variables | Initial value |
| `includeSheet` | string | For includes | Sheet to include (validated) |
| `commentText` | string | For comments | Comment text |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events, else blocks, OR conditions, and per-action disabling.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `conditions` | array | No* | Conditions. Each: `{ id, objectClass, behaviorType?, parameters?, isInverted?, isOr? }`. *Required (min 1) unless `isElse` is true. |
| `actions` | array | No | Actions (default: `[]`). Standard: `{ id, objectClass, behaviorType?, parameters?, callFunction?, disabled? }`. Script: `{ type: "script", script, disabled? }` where `script` is a string (split on newlines) or an array of lines; serialized as `{ type, language: "javascript", script: [lines] }`, the shape the C3 editor renders |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`) |
| `parentSid` | number | No | Insert as a child of this group, block, or function-block SID |
| `siblingSid` | number | No | Insert beside this event SID; requires `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` for root/group/parent insertion; `"before"` \| `"after"` with `siblingSid` (default: end) |
| `disabled` | boolean | No | Create the block disabled (default: false) |
| `isElse` | boolean | No | Mark as an else block — conditions become optional (default: false) |
| `children` | array | No | Sub-events nested inside this block (recursive). Each child has the same shape: `{ conditions?, actions?, disabled?, isElse?, children? }` |

Use at most one insertion locator: `groupPath`, `parentSid`, or `siblingSid`. Without a locator, the block is inserted at the event-sheet root.

**Condition fields:**
- `isOr` — OR-combine with the previous condition (default is AND). The first condition's `isOr` is ignored by C3.
- `isInverted` — Negate the condition.

**Action fields:**
- `disabled` — Disable an individual action (the action exists but won't run).

**Sub-events (`children`):**
- Each child is a full block event with its own conditions, actions, and children.
- Children with `isElse: true` act as "Else" branches and don't require conditions.
- Max nesting depth: 5 levels. Max total events (parent + all descendants): 50.

**Validation:**
- `objectClass` is hard-validated against project objects, families, and `"System"` — across the entire tree (parent + all descendants)
- `behaviorType` is soft-validated (warning only, since behaviors may come from families)
- `id` (ACE identifier) is **not** validated — Claude knows the hundreds of C3 ACE IDs
- Script actions (`type: "script"`) skip objectClass validation and SID generation

**What it does:**
1. Reads the target event sheet
2. Validates all `objectClass` references across the entire event tree
3. Recursively generates SIDs for each block, condition, and standard action
4. Builds condition/action objects with optional fields (`behaviorType`, `parameters`, `isInverted`, `isOr`, `callFunction`, `disabled`)
5. Recursively builds child sub-events with `isElse` support
6. Resolves the optional group, parent SID, or sibling SID destination before mutating the event tree
7. Inserts at the requested start/end or before/after position
8. Writes sheet back with backup

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
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info when it sits at the category root or one subfolder deep), never a registration that points at nothing; the error names the file to clean up

### `delete_event_from_sheet`

Delete an event from an event sheet by SID or include name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | No* | SID of the event to delete (block, group, variable, function) |
| `includeSheet` | string | No* | For removing includes: the included sheet name |
| `dryRun` | boolean | No | Preview what would be deleted without deleting (default: false) |
| `force` | boolean | No | Delete function-blocks even if they have callers (default: false) |

*Exactly one of `sid` or `includeSheet` must be provided.

**Behavior:**
- **SID deletion**: Finds the event anywhere in the tree (including nested inside groups) using iterative traversal. Reports children count for groups, checks function callers for function-blocks.
- **Include deletion**: Finds and removes the include event by sheet name. Lists current includes in error messages.
- **Dry run**: Returns a preview of what would be deleted without writing changes.
- **Function safety**: Blocks deletion of function-blocks that have callers (unless `force=true`).
- Error messages include a navigable summary of top-level events with their types and SIDs.

### `move_event_block_items`

Move or reorder existing actions or conditions within one block or between two blocks. Existing SIDs are preserved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sourceBlockSid` | number | Yes | Source block or function-block SID |
| `targetBlockSid` | number | Yes | Target block or function-block SID |
| `itemType` | enum | Yes | `"actions"` or `"conditions"` |
| `indices` | number[] | Yes | Unique source indexes; selected items retain their source order |
| `targetIndex` | number | Yes | Destination index; for same-block reorder this is measured after selected items are removed |

Cross-block moves enforce the 100-item block limit. Conditions cannot move into an else block. Moving the last condition out of a non-else source succeeds with an unconditional-block warning.

### `update_event_block`

Update an existing block event — modify action parameters, add/remove actions or conditions, toggle disabled state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | Yes | SID of the block event to update |
| `disabled` | boolean | No | Enable or disable the entire block |
| `updateActions` | array | No | `[{ index, parameters?, disabled? }]` — update actions by index (merge semantics) |
| `updateConditions` | array | No | `[{ index, parameters?, isInverted? }]` — update conditions by index |
| `insertActions` | array | No | `[{ index, action }]` — insert at unique indexes measured after removals |
| `insertConditions` | array | No | `[{ index, condition }]` — insert at unique indexes measured after removals |
| `replaceConditions` | array | No | `[{ index, condition }]` — replace a condition in place and mint a fresh SID |
| `addActions` | array | No | Append new actions (standard or script; script actions take the same shape as in `add_event_block`) |
| `addConditions` | array | No | Append new conditions |
| `removeActionIndices` | number[] | No | Remove actions by 0-based index |
| `removeConditionIndices` | number[] | No | Remove conditions by 0-based index |

At least one update parameter must be provided.

**Operation ordering:**
1. Updates and condition replacements use original array positions. Replacements mint fresh SIDs.
2. Removals use original positions and are applied descending.
3. Indexed insertions use the post-removal array and are applied descending. Duplicate insertion indexes are rejected.
4. Additions append.
5. Final state checks warn if all conditions were removed.

**Notes:**
- Only works on `block` or `function-block` events (not groups, variables, etc.)
- New standard actions/conditions get fresh SIDs via the ID generator (script actions carry no SID, matching C3)
- `objectClass` is validated on new conditions/actions
- Duplicate removal indices are automatically deduplicated
- Adding, inserting, or replacing conditions on an else block is rejected because Construct ignores them
- Warns when all conditions are removed (block becomes unconditional)

### `create_layout`

Create a new layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |
| `width` | number | No | Width in pixels (default: project viewport width) |
| `height` | number | No | Height in pixels (default: project viewport height) |
| `eventSheet` | string | No | Linked event sheet name (validated) |
| `layers` | string[] | No | Layer names (default: single `"Layer 0"`) |

### `add_instance_to_layout`

Place an object instance on a layout layer. For copying instances between layouts, read the source with `get_layout_details` and pass instance properties here.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout |
| `layerName` | string | Yes | Target layer |
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
| `behaviors` | object | No | Behavior runtime state as `{behaviorName: {prop: val}}` |
| `tags` | string | No | Comma-separated instance tags (alphanumeric only) |
| `showing` | boolean | No | Whether instance is initially visible (default: true) |
| `locked` | boolean | No | Whether instance is locked in the editor (default: false) |

**Notes:**
- Blocks global-only objects (singleglobal-inst) from being placed
- Nonworld-global objects (Array, JSON, Dictionary) are placed in `nonworld-instances` instead of on layers
- Auto-fills default instance properties for Sprite, Text, TiledBg, NinePatch
- Warns on unknown instanceVariable or behavior keys (may be inherited from families)
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
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info when it sits at the category root or one subfolder deep), never a registration that points at nothing; the error names the file to clean up

### `update_instance`

Update a placed instance on a layout. Instances are found by UID in any layer, nested sub-layer, or the layout's non-world instances.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the instance |
| `x`, `y`, `width`, `height`, `angle`, `zElevation`, `color` | number / number[4] | No | World transform and tint (ignored, with a warning, on non-world instances) |
| `showing`, `locked`, `tags` | boolean / string | No | Editor visibility, lock, and tags |
| `instanceVariables` | object | No | Instance variable values to merge |
| `properties` | object | No | Plugin property values to merge, keyed by property ID (Text `text`, iframe `url`, Tilemap `tile-width`, ...) |
| `behaviors` | object | No | Per-instance behavior settings as `{ behaviorName: { properties: { ... } } }`, merged per behavior |
| `effects` | object | No | Per-instance effect state as `{ effectName: { isEnabled?, parameters? } }`, merged per effect |

**Notes:**
- Behavior names not defined on the object type or one of its families produce a warning; effect names not defined there are rejected, because Construct fails to load an instance with an unknown effect key. Attach the effect first with `add_effect`.
- Property keys are not validated against the plugin; use the IDs Construct writes into the layout file.

### `update_layout`

Update layout properties (event sheet binding, dimensions).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to update |
| `eventSheet` | string | No | New event sheet binding (validated for existence) |
| `width` | number | No | New layout width in pixels |
| `height` | number | No | New layout height in pixels |

At least one parameter must be provided.

### `update_project_metadata`

Update project-level metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Project name |
| `version` | string | No | Project version |
| `author` | string | No | Author name |
| `description` | string | No | Project description |

At least one parameter must be provided.

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
- Checks animation name uniqueness within the sprite
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

### `reorder_frames`

Reorder the frames of a Sprite animation.

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
| `folder` | enum | No | `general`, `sound`, `music`, `video`, or `font` (default: `general`) |
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
| `folder` | enum | No | Project File family (default: `general`) |
| `subfolder` | string | No | Slash-separated folder path inside the family directory |

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

*Use `cdpEndpoint` alone, or `host`/`port`; do not combine the two routes.

The result contains `connectionId`, `bridgeReady`, `gameState`, and, for a
discovered connection, the selected page target metadata.

### `call_bridge`

Submit one of the 11 commands listed by `get_bridge_commands`, poll the bridge
for its result, and return `commandId`, `result`, and `elapsedMs`.

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
| `coordinateSpace` | string | No | `viewport` (default) or `canvas` |

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
width or height. Neither space converts Construct layout or layer
coordinates; a caller that starts from layout positions must convert them to
canvas CSS pixels first. Long press holds for 500 ms; swipe interpolates eight
move events from the start to the end point. A swipe without both end
coordinates is rejected before any event is dispatched.

### `get_canvas_size`

Read the geometry of the connected page's first `canvas` element. Parameter:
`connectionId` (required UUID). Returns `left` and `top` (CSS pixels in the
viewport), `cssWidth` and `cssHeight`, `backingWidth` and `backingHeight`
(canvas pixel buffer), `devicePixelRatio`, and `viewportWidth` and
`viewportHeight`. The tool returns an error when the page has no canvas.

### `disconnect_from_game`

Close a persistent connection. Parameter: `connectionId` (required UUID).
All remaining connections are terminated when the MCP transport closes or the
server receives SIGINT/SIGTERM.

---

## Prompts

### `analyze_project`

Analyze project structure, naming conventions, and organization.

### `find_object_usage`

Find where a specific object is referenced. Parameter: `objectName`.

### `explain_eventsheet`

Explain how an event sheet works. Parameter: `eventSheetName`.

### `review_game_logic`

Review overall game logic architecture.

### `document_object`

Generate documentation for an object. Parameter: `objectName`.

### `optimize_project`

Get optimization suggestions.

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
  category: string;      // "object" | "eventsheet" | "layout" | "project"
  action: string;        // "created" | "updated" | "deleted"
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];   // e.g., "Auto-registered plugin..."
  backupFile?: string;   // path to .bak file
}
```

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

**Last Updated**: 2026-09-16
