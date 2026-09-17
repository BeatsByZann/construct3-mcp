# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Query Tools](#query-tools)
- [Analysis Tools](#analysis-tools)
- [Mutation Tools](#mutation-tools)
- [Timeline Tools](#timeline-tools)
- [Effect Tools](#effect-tools)
- [Flowchart Tools](#flowchart-tools)
- [Structure Tools](#structure-tools)
- [Rename Tools](#rename-tools)
- [Template and Tilemap Brush Tools](#template-and-tilemap-brush-tools)
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

The orphan-file scan covers objectTypes, eventSheets, layouts, and families recursively, comparing project-relative file paths with registrations. It does not follow symbolic links and skips absent or unreadable directories. This additional family orphan check does not change the existing `complete` or file-existence semantics above.

A registered file that does not exist on disk is a `file-existence` error; a file that exists but exceeds the read cap is an `unscanned-file` warning, not an error.

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
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean", description?, showInPropertiesBar? }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |
| `force` | boolean | No | Remove behaviors even when events still use them (default false) |
| `globalInstanceProperties` | object | No | Settings of a single-global object (Keyboard, Touch, Audio, Gamepad, LocalStorage...) merged into `singleglobal-inst.properties` |
| `globalInstanceTags` | string | No | Tags of the single-global instance |

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- `removeBehaviors` is refused with `action: "update_blocked"` and the event references while a condition or action uses the behavior, or an expression names it (`Player.Platform.VectorX`); `force: true` removes it anyway and leaves those events unchanged. Placed instances (every layer depth and non-world) lose their settings for removed behaviors
- `globalInstanceProperties` and `globalInstanceTags` are refused for objects without `singleglobal-inst`; property keys not already stored produce a warning
- A new behavior is refused when a family already gives the object a behavior of that name, or when its addon is neither in `usedAddons` nor a known Scirra behavior (checked before anything is registered)
- If placed instances cannot be updated after the object file is written, the result is `success: false`, `action: "partially_updated"`, with `backupFile` and `writtenLayouts`
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)
- `description` sets C3's `desc` field and `showInPropertiesBar` sets `show` (defaults `""` and `true`). `update_family`'s `addVariables` accepts the same two options
- There is no `initialValue` parameter: a C3 instance-variable definition has no default-value field. A placed instance's starting value lives in that instance's own `instanceVariables` dict, set with `add_instance_to_layout` / `update_instance`
- To rename, retype or re-describe an existing variable, use `update_instance_variable`

### `update_family`

Update a family's members, shared instance variables and shared behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name |
| `addMembers`, `removeMembers` | string[] | No | Object type names |
| `addVariables` | array | No | `[{ name, type, description?, showInPropertiesBar? }]` |
| `removeVariables` | string[] | No | Variable names |
| `addBehaviors` | array | No | `[{ behaviorId, name }]` added to `behaviorTypes`; the addon is registered if needed |
| `removeBehaviors` | string[] | No | Family behavior names |
| `force` | boolean | No | Remove behaviors even when events still use them (default false) |

**Notes:**
- Behavior names may use letters, digits (including a leading digit, as in `8Direction`), underscores and spaces
- Every member must be able to carry every family behavior name: a new behavior may not match a behavior of any member or of another family of a member, and a new member may not bring a behavior whose name the family already uses. All checks run before any addon is registered or file written
- Removal checks event references and expressions (`Member.Behavior.`) through the family and every member; it is refused with `action: "update_blocked"` unless `force` is true
- Member instances on every layer depth get a `behaviors` dict; removed behaviors, and all family behaviors on removed members, are deleted from those instances. A failed layout update after the family file is written returns `action: "partially_updated"` with `writtenLayouts`

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
- Checks for references in event sheets, layouts, and families
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info at any subfolder depth if its directory is readable), never a registration that points at nothing; the error names the file to clean up

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
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` \| `"script"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name |
| `functionParams` | array | For functions | `[{ name, type }]` |
| `functionReturnType` | enum | For functions | `"none"` \| `"number"` \| `"string"` \| `"any"` (default: none) |
| `functionIsAsync` | boolean | For functions | Mark the function async (default: false) |
| `functionCopyPicked` | boolean | For functions | Copy picked instances into the function (default: false) |
| `variableName` | string | For variables | Variable name |
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

Use at most one of `groupPath` or `parentSid`; with neither, the event is added at the event-sheet root (the original behavior). A nested `include` is rejected, because Construct only serializes includes at the sheet root.

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events, else blocks, OR blocks, disabled conditions and actions, function and custom action calls, action comments, and script actions.

An `ease` parameter that names a registered custom ease is stored as Construct r495.2 saves it, `{ "name": "<ease>", "json": [{ "folders": [], "json": <ease file> }] }`, here and in `update_event_block` and `update_event_block_action`. Built-in ease names and other values stay strings (see [Custom eases](#custom-eases)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `conditions` | array | No* | Conditions. Each: `{ id, objectClass, behaviorType?, parameters?, isInverted?, disabled?, isOr? }`. *Required (min 1) unless `isElse` is true. |
| `actions` | array | No | Actions (default: `[]`); see **Action kinds** below |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`) |
| `parentSid` | number | No | Insert as a child of this group, block, or function-block SID |
| `siblingSid` | number | No | Insert beside this event SID; requires `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` for root/group/parent insertion; `"before"` \| `"after"` with `siblingSid` (default: end) |
| `disabled` | boolean | No | Create the block disabled (default: false) |
| `isElse` | boolean | No | Make an else block (default: false). Written as a leading `{ id: "else", objectClass: "System" }` condition; further conditions make an else-if |
| `isOrBlock` | boolean | No | Make an OR block: true when any condition is true (default: false) |
| `children` | array | No | Sub-events nested inside this block (recursive). Each child has the same shape: `{ conditions?, actions?, disabled?, isElse?, isOrBlock?, children? }` |

Use at most one insertion locator: `groupPath`, `parentSid`, or `siblingSid`. Without a locator, the block is inserted at the event-sheet root.

**Condition fields:**
- `isInverted` — Negate the condition.
- `disabled` — Disable the condition.
- `isOr` — Legacy. Construct r495 has no per-condition OR; OR is the block-level `isOrBlock` key. A condition with `isOr` makes the whole block an OR block, with a warning.

**Action kinds** (each may carry `disabled` except comments):

| Kind | Input | Written as |
|------|-------|------------|
| Standard | `{ id, objectClass, behaviorType?, parameters? }` | `{ id, objectClass, sid, behaviorType?, parameters? }` |
| Function call | `{ callFunction, parameters?: [args] }` | `{ callFunction, sid, parameters?: [args] }`. The older `{ id, objectClass, callFunction, parameters: {...} }` input is converted to this shape (values in key order) with a warning |
| Custom action call | `{ customAction, objectClass, customActionObjectClass?, parameters?: [args] }` | Same keys plus `sid`. `customActionObjectClass` names the family that defines the action when it is called on a member object type |
| Action comment | `{ type: "comment", text, textColor?, backgroundColor? }` | `{ type: "comment", text, text-color?, background-color? }` with no SID |
| Script | `{ type: "script", script }` (string split on newlines, or lines) | `{ type: "script", language: "javascript", script: [lines] }` with no SID |

Call arguments are positional expression strings.

**Sub-events (`children`):**
- Each child is a full block event with its own conditions, actions, and children.
- Children with `isElse: true` act as "Else" branches and don't require conditions.
- Else and OR follow the r495 file format: a leading System `else` condition and a block-level `isOrBlock`. No `isElse` or condition-level `isOr` key is written.
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
4. Builds condition and action objects in the shapes above
5. Recursively builds child sub-events with else and OR support
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
- Removes the name from c3proj first, then backs up and deletes the JSON file. A failure between the two steps leaves an orphaned file (reported by `validate_project` as info at any subfolder depth if its directory is readable), never a registration that points at nothing; the error names the file to clean up

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

Move or reorder existing actions or conditions within one block or between two blocks. Existing SIDs are preserved. With `copy: true` the source block is left unchanged and the selected items are inserted as copies with fresh SIDs (nested `sid` keys included).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sourceBlockSid` | number | Yes | Source block or function-block SID |
| `targetBlockSid` | number | Yes | Target block or function-block SID |
| `itemType` | enum | Yes | `"actions"` or `"conditions"` |
| `indices` | number[] | Yes | Unique source indexes; selected items retain their source order |
| `targetIndex` | number | Yes | Destination index; for same-block reorder this is measured after selected items are removed (a copy removes nothing) |
| `copy` | boolean | No | Copy instead of move (default `false`). The result lists `copiedSids` and `reassignedSids` instead of `movedSids` |

Cross-block moves and all copies enforce the 100-item block limit. Conditions cannot move into an else block, and an else condition can be neither moved nor copied. Moving the last condition out of a non-else source succeeds with an unconditional-block warning.

### `update_event_block`

Update an existing block, function-block or custom action body — modify action parameters, call arguments and comment rows, add/remove actions or conditions, toggle disabled state and OR mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | Yes | SID of the `block`, `function-block` or `custom-ace-block` to update |
| `disabled` | boolean | No | Enable or disable the entire block |
| `isOrBlock` | boolean | No | Make the block an OR block (`true`) or an AND block (`false`) |
| `updateActions` | array | No | `[{ index, parameters?, arguments?, text?, textColor?, backgroundColor?, disabled? }]`. `parameters` merges into a standard action; `arguments` replaces a call's positional arguments; `text` and colors edit an action comment. A field that does not fit the action kind is rejected |
| `updateConditions` | array | No | `[{ index, parameters?, isInverted?, disabled? }]` — update conditions by index |
| `insertActions` | array | No | `[{ index, action }]` — insert at unique indexes measured after removals |
| `insertConditions` | array | No | `[{ index, condition }]` — insert at unique indexes measured after removals |
| `replaceConditions` | array | No | `[{ index, condition }]` — replace a condition in place and mint a fresh SID |
| `addActions` | array | No | Append new actions of any kind listed under `add_event_block` |
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
- Works on `block`, `function-block` and `custom-ace-block` events (not groups, variables, etc.)
- New conditions, standard actions and calls get fresh SIDs via the ID generator (script actions and comments carry no SID, matching C3)
- `objectClass` and `customActionObjectClass` are validated on new conditions and actions
- Duplicate removal indices are automatically deduplicated
- In an else block the `else` condition stays first: inserting at index 0 is rejected, and replacing or removing it warns that the block becomes an ordinary block. Conditions after it (else-if) are allowed
- A block written by an older build with an `isElse` key or condition-level `isOr` is rewritten to the r495 shape, with a warning
- Warns when all conditions are removed from a block (it becomes unconditional), and when an OR block has fewer than two conditions

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
- The definition is created empty. Add its conditions and actions with `update_event_block` using the returned `generatedSid`, and nest sub-events with `add_event_block` and `parentSid`.

### `move_event_block`

Move an existing event to another container in the same event sheet. The event keeps its SID, its conditions and actions with their SIDs, and every descendant.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the event |
| `sid` | number | Yes | SID of the event to move |
| `groupPath` | string | No | Move inside a group by title path (e.g., `"Movement > Collision"`) |
| `parentSid` | number | No | Move inside this group, block, or function-block SID |
| `siblingSid` | number | No | Move beside this event SID; requires `position` `"before"` or `"after"` |
| `position` | enum | No | `"start"` \| `"end"` for root/group/parent destinations; `"before"` \| `"after"` with `siblingSid` (default: end) |

Use at most one destination locator. Without a locator the event moves to the event-sheet root.

**Behavior:**
- Works on any event the SID index can find: `block`, `group`, `variable`, `function-block`, `custom-ace-block`. Construct does not write a `sid` on `comment` or `include` events, so those cannot be addressed here — the not-found error says so.
- Refuses a destination inside the moved event's own subtree (`parentSid`, `groupPath` or `siblingSid` resolving to the event itself or one of its descendants), which would detach the branch from the sheet.
- Refuses `siblingSid` or `parentSid` equal to `sid`.
- The destination is resolved before anything is detached, so a rejected move leaves the file untouched.
- A move within one container is correct for `before`/`after`: the sibling's index is read after the event has been detached.
- A destination container with no `children` array gets one only after every check has passed.
- Cross-sheet moves are **not** supported here; use `move_events_between_sheets`, which copies or moves top-level events between two sheets.

### `update_event_group`

Update a group event in place. Children are untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the group |
| `sid` | number | Yes | SID of the group event |
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
| `layerName` | string | Yes | New layer name (unique across every layer of the layout, sub-layers included) |
| `parentLayer` | string | No | Create the layer inside this layer's `subLayers` (default: top level) |
| `index` | number | No | Position among its siblings, 0 = bottom (default: append to top) |
| `isInitiallyVisible` | boolean | No | Layer starts visible (default: true) |
| `isTransparent` | boolean | No | Layer is transparent (default: true) |
| `parallaxX`, `parallaxY` | number | No | Parallax rates (default: 1) |
| `blendMode` | string | No | Blend mode (default: `normal`) |

**Notes:**
- The parent layer is found at any nesting level; a parent with no `subLayers` array gets one.
- Layer names must be unique across the whole layout, so a name already used by a nested layer is rejected.

### `update_layer`

Update an existing layer, at the top level or nested in another layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer to update (searched at every nesting level) |
| `newName` | string | No | Rename the layer (unique across every layer of the layout) |
| `isInitiallyVisible`, `isInitiallyInteractive`, `isTransparent` | boolean | No | Initial visibility, interactivity, transparency |
| `parallaxX`, `parallaxY`, `scaleRate`, `zElevation` | number | No | Parallax rates, scale rate, Z elevation |
| `blendMode` | string | No | Blend mode |
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

### `replace_object_image`

Replace the image of an object type that has a single `image` (Tiled Background, 9-patch, Particles, Sprite Font, Tilemap).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Object type name (Sprites are refused; use `replace_sprite_image`) |
| `pngBase64` | string | Yes | Base64 PNG data |

Writes `images/<lowercased name>.png`, the naming every single-image object uses in the r495 examples, and sets `image.width`/`image.height` from the PNG header (and `fileType` to `image/png` when the key is present). A Tilemap whose tileset changes size gets a warning, because tile numbers count across the image. If the object type write fails, the previous image is restored.

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

## Timeline Tools

Timelines live in `timelines/[subfolder/]<name>.json` and are registered in the
`timelines` container of `project.c3proj`. The first, nameless subfolder of
that container lists custom eases, whose files live in `timelines/transitions/`
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

List every timeline registered in the project, at the container root and in
every subfolder except the nameless eases folder. Returns
`{ timelines: string[], count: number }`. No parameters.

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

Return the parsed timeline file unchanged, including all tracks, property
tracks and keyframes. A registered name whose file has no `tracks` (an ease
file) is reported as not a timeline.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |

### `create_timeline`

Create an empty timeline file and register it. Duplicate names are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |
| `totalTime` | number | No | Duration in seconds (default: 5) |
| `loop`, `pingPong` | boolean | No | Playback flags (default: false) |
| `repeatCount` | number | No | Repeats when not looping (default: 1) |
| `startOnLayout` | string | No | Layout to auto-start on (default: none) |
| `ignoreSystemTimescale` | boolean | No | Default: true |
| `subfolder` | string | No | Slash-separated folder path under `timelines/`. A path starting with `transitions` (any case) is refused, because Construct keeps custom eases in `timelines/transitions/`. A name already used by a custom ease is refused too |

### `update_timeline`

Update timeline-level properties. At least one is required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |
| `totalTime` | number | No | New duration in seconds |
| `loop`, `pingPong`, `enabled` | boolean | No | Playback flags |
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

Delete the timeline file and its `project.c3proj` registration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name to delete |

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
inside property-track folders are removed with their master keyframe.

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

`sourceAdapter.audioProjectFilePath` follows `audioProjectFile`. A live
r495.2 save of a project whose `exportFileStructure` was `folders` wrote
`media/<file name>` for a music file; the r432.3 sample has no such key. The
tools write `media/<file name>` for every audio file when the project uses
`folders` (sound files and files in subfolders are assumed to follow the
same rule) and write no path otherwise, with a warning. `update_track`
writes the path when `audioFile` changes and removes a path that no longer
applies.

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

Its name is listed in the first, nameless subfolder of the `project.c3proj`
`timelines` container (every sampled project has that folder), and each
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
effects), when an expression reads `From.Member` for such a behavior or
variable, or when it calls a custom action. A custom action definition owned
by the replaced object is skipped with its body. Layouts are not changed. The
result has `references` (as in the rename tools), `skippedEvents`
(`[{ file, path, eventSid, references, reasons }]`) and `filesWritten`.

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

## Template and Tilemap Brush Tools

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
