# Troubleshooting

Common issues and solutions for the Construct3 MCP Server.

## Server Won't Start

### "No .c3proj file found in directory"

**Cause**: The path you provided doesn't contain a `.c3proj` file directly. Only that folder is searched, not its subfolders or parent folders. The same message appears when:
- the path does not exist (a typo),
- the path is a `.c3p` file (single-file projects cannot be opened),
- the path is a subfolder of the project (e.g. `layouts/`) or a parent folder (e.g. a repository root with the game in `game/`),
- no path was given and the server was started in a folder without a `.c3proj`. Without an argument and without `C3_PROJECT_PATH` the server uses its working directory; Claude Code starts it in the folder where you started `claude`.

The server exits with code 1, so the client only reports that the connection closed. Run the command from your MCP config in a terminal to see this message.

**Solutions**:
- Pass the path directly to the `.c3proj` file: `node dist/index.js /path/to/project.c3proj`
- Or pass the directory that contains it: `node dist/index.js /path/to/project-folder/`
- Make sure the project is saved in **folder format**, not as a `.c3p` ZIP file

### "Invalid Construct3 project file"

**Cause**: The path ends in `.c3proj` but the file does not exist, isn't valid JSON, or lacks the top-level fields `projectFormatVersion` and `name`.

**Solutions**:
- Check the path (a missing `.c3proj` file gives this message, not "No .c3proj file found")
- Open the project in Construct 3 editor and re-save it
- Check the file isn't corrupted (open it in a text editor — it should be valid JSON with `projectFormatVersion` and `name`)

A file that passes this check but lacks other parts of a project (e.g. `objectTypes`) fails with `Failed to load Construct3 project: Cannot read properties of undefined (reading 'items')` instead.

### Started without a project path

There is no usage message. Without an argument and without `C3_PROJECT_PATH`, the server looks for a `.c3proj` in its working directory. If there is none, it prints `Failed to start server: No .c3proj file found in directory: <working directory>` and exits with code 1.

**Solutions**:
- Pass the path as the first argument: `node dist/index.js /path/to/project`
- Or set the environment variable: `C3_PROJECT_PATH=/path/to/project node dist/index.js`

## Connection Issues

### Server starts but Claude doesn't see the tools

**Solutions**:
- Verify your MCP config JSON is valid (check for trailing commas, etc.). On Windows use forward slashes or doubled backslashes in JSON paths
- Make sure the path to `dist/index.js` is absolute
- Restart Claude Code / Claude Desktop after changing MCP config (quit Claude Desktop completely; closing the window is not enough)
- Check stderr output for error messages: `node dist/index.js /path/to/project 2>debug.log`
- Claude Code: run `claude mcp list`. `✘ Failed to connect` means the server exited (run its command in a terminal to see why). `⏸ Pending approval` means a `.mcp.json` server that you still have to approve by starting `claude` in that folder. Claude Code does not read `~/.claude/mcp.json`; add servers with `claude mcp add` or a `.mcp.json` in the project folder. See the [User Guide](USER-GUIDE.md#claude-code)
- VS Code: `.vscode/mcp.json` uses the top-level key `"servers"`, not `"mcpServers"`

### "Server disconnected" errors

**Cause**: The server process crashed.

**Solutions**:
- Check if the project files are accessible (not locked by another process)
- Run the server manually to see the error: `node dist/index.js /path/to/project`
- Ensure Node.js >= 18.0.0: `node --version`

## Query Tool Issues

### "Object type X not found"

**Cause**: The name doesn't match. On Windows, read tools such as `get_object_details` also accept a name that differs only in letter case, because the file is found case-insensitively there; `update_object_properties` and `update_family` do not (see [below](#-not-found-names-are-matched-with-their-letter-case)).

**Solutions**:
- Use `list_objects` to see all available names
- Use `search_objects` with a partial name
- The error message includes "Did you mean: ..." suggestions when a close match exists

### "Event sheet X not found" / "Layout X not found"

Same as above — use the corresponding `list_` tool to find the correct name.

### "File too large (... exceeds 10MB limit)"

**Cause**: The server reads object type, event sheet, layout and family files up to the size limit: 10MB unless the server was started with the environment variable `C3MCP_MAX_FILE_MB` set to another whole number of megabytes (1 to 128). `get_object_details`, `get_eventsheet_details` and `get_layout_details` refuse a larger file (without a "Did you mean" hint, since the name was right), and the cross-reference index leaves it out. The reference checks of the delete and update tools, `find_orphaned_objects` and `get_object_dependencies` search it as text instead (see "Possible uses in files that could not be parsed" below). `validate_project` reports it as an `unscanned-file` warning and returns `complete: false`: duplicate UIDs and SIDs, references and load-time errors inside that file are not reported, and `valid` is `false`, also when `summary.errors` is 0.

New UIDs are still allocated above the UIDs in the file, so `add_instance_to_layout` and `create_object` keep working: the file is scanned as text for its UIDs and SIDs. The scan streams the file, so memory does not grow with its size (beyond the SIDs it finds), and there is no size limit; it reads the whole file on the first new UID or SID and again after each change on disk the server did not make (its own writes add their IDs without a new scan), so the time of such a scan grows with the size. Measured (Node 22, Windows 11, three runs, other processes busy): a 50MB layout with 218,000 instances about 0.2 to 0.4 seconds per scan, a 608MB layout about 1.5 to 1.8 seconds, with a peak of about 100 to 120MB of process memory in both. Version 1.9.2 and older read the file into memory whole (a peak of about 290MB for the 50MB layout) and refused new UIDs next to a file over about 512MB, the most a JavaScript string can hold. The scan reads a file with a UTF-16LE byte order mark as such and leaves out NUL characters, so it also finds the UIDs of a file in UTF-16 without a byte order mark or in UTF-16BE, and of a file whose end is zeros (a save cut short); version 1.9.2 read every file as UTF-8 and missed the UIDs of UTF-16 files, so a new UID could repeat one of them.

Known gap: tools that edit the large file itself, such as `add_instance_to_layout` on that layout, report it as not found and suggest its own name.

To edit such a file, raise the limit in the server's environment (the `env` of its MCP configuration), for example `C3MCP_MAX_FILE_MB=32`, and restart the server; a tool call cannot change it. The same limit applies when the server writes an object type, event sheet, layout, family or `project.c3proj`, counted on the text it writes: tab-indented, in the file's line endings, in UTF-8. A file saved without indentation grows when the server rewrites it, so it can be over the limit once written although it was under it on disk. Images, timelines and scripts are not checked when written. Memory grows with the whole project: the cross-reference index that the delete, update and analysis tools use parses and keeps every layout under the limit, and an `update_layer` rename reads every layout and event sheet under the limit to plan its references. If the process runs out of memory it stops, and the client sees the connection close; a call that was writing several files may then have written only some of them (check with `validate_project` and `git status`).

Measured on whole projects on Node v24.19.0 and Windows 10, with V8's heap capped at half its default (2144MB of 4288MB on the measuring host; a server on the default heap has about twice that headroom). Each run builds seven layouts whose sizes are 1, 0.75, 0.5, 0.35, 0.25, 0.25 and 0.12 of S (the largest exactly S MB) and three event sheets of about 0.1 S each, runs `validate_project`, then renames one layer in all seven layouts with seven `update_layer` calls. A run counts only when the effective limit is S, no layout fails to read, all seven layouts are renamed and no event sheet still names the old layer. The generator factor is the share of each layout aimed at instances; the rest is padding.

| Largest layout S (MB) | Generator factor (padding share) | Counted runs | Result | Highest RSS (MB) | Index build heap (MB) | Heap in use at the end of a writer phase, highest (MB) |
|---|---|---|---|---|---|---|
| 16 | 0.6 (about 23.5%) | 3 of 3, plus one earlier run | pass | 597 | 99-116 | 394 |
| 32 | 0.6 | 3 of 3 | pass | 1407 | 154-475 | 1144 |
| 64 | 0.6 | 3 of 3 | pass | 1816 | 548-802 | 1432 |
| 128 | 0.6 | 3 of 3 | pass | 2447 | 745-1108 | 1403 |
| 128 | 0.7 (about 10%) | 3 of 3 | pass | 2416 | 1150-1204 | 1529 |
| 256 | 0.6 | 0 of 4 | aborted (exit 134, heap at the 2144MB cap) | - | - | - |

The ceiling is 128MB, the largest S at which every counted run passed. 16, 32 and 64MB were run at factor 0.6 only, so their pass at factor 0.7 is inferred from the 128MB pass, not measured. 256MB was run at factor 0.6 only: it ran out of memory in all four runs, and factor 0.7 needs more heap, so it would not pass either. The heap column is sampled at the end of each writer phase, not a peak. RSS sits above the heap cap because file buffers live outside the V8 heap; a host should expect about 2.4GB of process memory for a project whose largest layout is 128MB and whose layouts total about 410MB (plus about 38MB of event sheets).

**Solutions**:
- Check that file in the Construct 3 editor, or split a very large layout

### Construct 3 does not open the project: "cannot find object type name '...'"

**Cause**: a container in `project.c3proj` (`"containers": [ { "members": [...] } ]`) lists an object type that no longer exists, for example one deleted by hand or by `delete_object` of version 1.10.0 or older, which left the name in its container. `validate_project` reports it as a `container-member` error. `create_container` and `update_container` refuse to write a container that Construct 3 would refuse to open.

**Fix**: remove the name from that container's `members` in `project.c3proj` (the error names the container's index and members), or restore the deleted object type from the files `delete_object` keeps. From this version on, `delete_object` takes a deleted object type out of its containers and keeps its files, so steps 1 to 4 restore one:

1. Object file: rename `<name>.json.bak` to `<name>.json` in `objectTypes/`. An object type that sat in a project-bar folder has its file in that folder, as `objectTypes/<folder>/<name>.json.bak` (a folder inside a folder adds one level, `objectTypes/<outer>/<inner>/`): rename it there and keep the folder.
2. Registration: in `project.c3proj`, add the name back to `items` of `objectTypes`, or, for an object type in a folder, to `items` of the matching entry under `objectTypes` `subfolders` (each folder entry has a `name`, and a folder inside a folder is in that entry's own `subfolders`). The folder entry stays when the name is removed, so only the name is added back.
3. Containers: add the name back to the `members` of each container it was taken out of, as the `delete_object` response lists them. `containersUpdated` gives each container's `index` and its members after the change. `containersRemoved` gives a container that was deleted, with its members before the change: recreate it as `{ "members": [...] }` at that index in `containers`. The response does not say where the name sat in `members`. If `project.c3proj.bak` holds the file from before the delete (no tool call has written `project.c3proj` since, and the editor has not saved it), copying its `objectTypes` and `containers` back restores steps 2 and 3 in one go.
4. Images: `delete_object` renames the object's image files in `images/` to `<file>.bak`, and its warning lists them as `"images/<file>"` renamed to `"images/<file>.bak"` (three at most, then how many more; `validate_project` lists the rest as `backup-file` info). Rename each `images/<file>.bak` back to `images/<file>`, dropping the final `.bak` (`<file>.1.bak` goes back to `<file>`). Image files that another object type uses, or that are named after an object type whose file could not be parsed, stay in place and need no step.

Before each rename, check that the target name is free: if `<name>.json` or an image of that name exists again, leave it and check it first. Then run `validate_project`; no `container-member` error should remain.

### Changes made in the C3 editor or with git

Since 1.10.0 the server picks up changes made outside it by itself: each tool call checks `project.c3proj`, and the files its caches hold, against the disk (modification time, size, file id) and reads again what changed. Reconnecting is no longer needed after a save in the editor or `git restore`. Older versions kept the project list from their start and needed a reconnect (Claude Code: `/mcp` > `construct3` > **Reconnect**).

A change that keeps a file's size, modification time and file id (possible on file systems with coarse timestamps, such as FAT32 or some network drives) is not seen; reconnect the server in that case.

### "... was changed on disk after this server read it"

**Cause**: The file changed on disk while the tool call was working with it: saved in the Construct 3 editor, restored with git, written by another program, or by another tool call running at the same time on the same file. Every tool refuses this way for an event sheet, layout, object type or family file; for `project.c3proj` only the timeline, addon and runtime-bridge tools do (the server's other updates of `project.c3proj` keep such a change and go on). The write was refused so that change is not lost; the file was left as it is on disk.

**Solution**: Run the tool again; it reads the file as it is now. If the editor saved the file, check that its version is the one you want to keep. When the tool call had already written other files (for example `move_events_between_sheets` the target sheet, or `update_object_properties` the object and `project.c3proj`), it put them back as they were before the call, so it changed nothing; the error lists them. If one of them had changed on disk again meanwhile, it is left as it is and the error names it with its `.bak`: check the project with `validate_project` and `git diff` before you run the tool again. Image files a call wrote before the refusal (placeholder PNGs) are not removed.

### "project.c3proj changed on disk and could not be read again"

**Cause**: `project.c3proj` changed and is not valid JSON at the moment, typically while the editor or git is still writing it.

**Solution**: Run the tool again once the save or checkout is done. The server keeps trying on every call and does not use the old project meanwhile.

## Mutation Tool Issues

### "Object X already exists"

**Cause**: Trying to create an object with a name that's already taken.

**Solution**: Use `update_object_properties` to modify the existing object, or choose a different name.

### "Plugin X is not registered in usedAddons"

**Cause**: The plugin is a third-party addon not in the project's `usedAddons` list. The server can only auto-register known Scirra built-in addons.

**Solution**: Open the project in the Construct 3 editor, add an object using that plugin (which registers it), save and close it. The server sees the new addon on its next tool call (1.9.2 and older: restart the MCP server first).

### "Behavior X is not registered in usedAddons"

Same as above but for behaviors. Add a behavior of that type to any object in the C3 editor first.

### "Object X is a global plugin and cannot be placed on layouts"

**Cause**: Trying to use `add_instance_to_layout` with a global-only plugin like Audio, AJAX, Mouse, etc.

**Solution**: Global plugins use `singleglobal-inst` and don't have layout instances. They're created once and accessible everywhere. Use `create_object` to add them to the project instead.

### "System is a reserved name"

**Cause**: "System" is used by the C3 engine and can't be used as an object name.

**Solution**: Choose a different name.

### "Path traversal detected"

**Cause**: The name or subfolder contains `..`, `/`, or `\` that would escape the project directory.

**Solution**: Use simple names with letters, numbers, underscores, and spaces only.

### "Unknown key(s) ... in the arguments of add_event_to_sheet"

**Cause**: The call named a top-level key the tool does not take, usually a misspelling such as `varType` for `variableType`. The tool would not write that key, so it refuses the call instead of dropping the key. (Keys inside a `functionParams` entry are not checked this way; they are still dropped.)

**Solution**: Correct the key or remove it, then run the call again. Nothing was written.

### "Object is still referenced"

**Cause**: `delete_object` found references in event sheets, layouts (instances on any layer or sub-layer, non-world instances, object properties of other instances), or families.

**Solutions**:
- Remove all references first, then delete
- Use `force: true` to delete anyway (references will NOT be cleaned up — you'll need to fix them manually; `validate_project` then reports the leftover instances, object parameters, family memberships and Particles object properties as `broken-object-reference`; uses in expressions and scripts are not reported, so fix the ones the force warning lists)
- The error response lists all locations where the object is referenced

### A delete tool's error ends with what is on disk ("project.c3proj still lists ...", "... no longer lists ...", "... is missing")

**Cause**: `delete_object`, `delete_family`, `delete_event_sheet` or `delete_layout` failed after a step, or `project.c3proj` was saved in the Construct 3 editor during the delete. After any undo, the tool reads `project.c3proj` and the entity's file again and says what it found at the end of the error. A refusal because the entity's file changed on disk before the tool wrote anything is a different message: it ends with "Run the tool again: it reads the file as it is now." and changes nothing.

**Solutions**, by the sentence the error ends with (`layouts/Level.json` stands for the entity's file):
- "project.c3proj still lists "Level", and layouts/Level.json is on disk": nothing is left half done. Run the tool again. If the error also names files left as they are, check the project (`validate_project`, `git diff`) first.
- "project.c3proj no longer lists "Level", but layouts/Level.json is still on disk": check the file, then delete it or register it again in the Construct 3 editor. For objects, event sheets and layouts, `validate_project` lists it as `orphaned-file` (info); for families, check the file by hand.
- "layouts/Level.json was deleted, but project.c3proj ... lists "Level" again" or "project.c3proj lists "Level", but layouts/Level.json is missing": put the file back from `layouts/Level.json.bak`, or remove the name in the Construct 3 editor.
- "project.c3proj is missing": put it back from `project.c3proj.bak` (its last backup) before you open the project.
- "project.c3proj could not be read": another program may hold it, or its JSON may be damaged. Check it; if the JSON is damaged, put it back from `project.c3proj.bak` before you open the project.
- "Whether layouts/Level.json is still on disk could not be checked": the file's state could not be read. Check the file and `project.c3proj` by hand before you run the tool again.

### "Family is still referenced"

**Cause**: `delete_family` found events or object properties that name the family, or conditions, actions and expressions that use its instance variables or behaviors through a member object type (`references.memberUses`), or conditions and actions on a member that name one of its effects (`references.effectUses`).

**Solutions**:
- Remove those uses first, then delete
- Use `force: true` to delete anyway (references will NOT be cleaned up; `validate_project` reports the uses through members as `missing-behavior-or-variable`, but not the uses in expressions and scripts and not `Member.name` in expressions, so fix the ones the force warning lists)

### "Events still use what this update removes"

**Cause**: `update_object_properties` (`removeVariables`, `removeBehaviors`) or `update_family` (`removeVariables`, `removeMembers`) would take away an instance variable or behavior that conditions, actions or expressions still use (`references.uses`, each with its event path, the JSON path of its event as `eventPath` and the condition's or action's `sid`). Nothing was changed.

**Solutions**:
- Change or delete those conditions, actions and expressions first, then remove it
- Use `force: true` to remove it anyway (the uses are NOT changed; `validate_project` then reports them as `missing-behavior-or-variable`, except `Object.name` and `Self.name` in expressions, which the force warning lists)

### "Possible uses in files that could not be parsed"

**Cause**: A delete, removal, move or rename (`delete_object`, `delete_family`, `delete_layout`, `delete_event_sheet`, `delete_event_from_sheet`, `move_events_between_sheets`, `update_event_variable`, `update_object_properties`, `update_family`, `rename_animation`, `rename_object_type`, `rename_family`) refused with `delete_blocked`, `move_blocked`, `update_blocked` or `rename_blocked` because a registered layout, event sheet or family file it could not parse (over the size limit (10MB by default), not valid JSON) names what the tool checks for. The cross-reference index cannot see inside such a file, so the tool searched its text for the names instead (whole words, ignoring case; `delete_layout` looks for instances and an event sheet binding in the layout's own file). A match is a *possible* use: the name may just as well be in another string there. `unscannedFiles` lists each file with its reason and `textSearch`: `possible-use` (with the `names` found), `unreadable` (the file exists but cannot be read even as text, e.g. a folder in its place or no read access; this refuses too) or `no-match` (only a warning). A registered name without a file is not listed and does not block.

**Solutions**:
- Open the project in the Construct 3 editor and check the named file for the use; remove it there if it is real
- Fix a file with invalid JSON (`validate_project` names it as a `file-existence` error), or split a very large layout, so the server can read it
- Use `force: true` if the match is a false alarm; the warning names the files again, and nothing in them is changed
- `find_orphaned_objects` and `get_object_dependencies` report such objects as possibly used (`possiblyUsed`, `possiblyUsedObjects`, `possiblyReferencedIn`) instead of unused, for the same reason
- An object whose own object type file is such a file has an unknown SID: `find_orphaned_objects` and `get_object_dependencies` list it in `unanalysedObjects` (with the file and reason) instead of calling it unused, `get_object_dependencies` marks it with `unanalysed`, and `analyze_performance` names it apart
- *Its own file could not be parsed* (`"textSearch": "not-searched"`): `delete_object` or `delete_family` refuses because the object type's or family's own file is over the limit or not valid JSON, so its SID is unknown; `delete_event_sheet` refuses for the sheet's own file, since the functions and global variables it defines are unknown. Fix the file, or delete with `force: true`
- A file saved as UTF-16 without a byte order mark, or in UTF-16BE, cannot be searched and refuses as `unreadable`; save it as UTF-8 (the editor does)
- `rename_object_type` also refuses with `rename_blocked` when any timeline file cannot be read or parsed, or holds more than 200,000 values, whatever it names; the message names the file. Open it in the editor to see whether it has a track of the object type, or use `force: true` (the timeline is not updated)

### "The check ... stopped at its traversal limit"

**Cause**: `delete_event_sheet`, `delete_event_from_sheet`, `move_events_between_sheets` or `update_event_variable` looks for the uses of the functions and event variables it deletes or moves (`update_event_variable`: the uses of the variable it renames) by walking the events of all event sheets, and stops after 100,000 events (sub-events included). In a project that large, the uses beyond that point are unknown, so the tool refuses with `delete_blocked`, `move_blocked` or `rename_blocked`, as it does for a file it could not parse. Nothing was written. A sheet that defines no function or global variable, an event that removes neither, and a move of events that declare no event variable need no such check.

**Solutions**:
- Find the uses yourself: `get_function_map` lists the call sites of a function; for a variable, search the event sheet files for its name
- Then use `force: true`; the warning says again that the check stopped at its limit

### "Cannot generate a safe UID: project file(s) could not be scanned"

**Cause**: `add_instance_to_layout` or `create_object` (for a global plugin) needs a new UID, which must be above every UID in the project. A layout or object type named in the error is registered in `project.c3proj` and exists, but could not be read at all, not even as text, so its UIDs are unknown. The error gives the reason after each name: `a folder in place of the file`, `no read access`, `could not be read (<code>)` for another file system error (such as a lock held by another program, e.g. a virus scanner or sync client), or the message of the path check for a name that leads out of the project folder. Nothing was written. Files over the size limit (10MB by default), whatever their size, and files with invalid JSON do not cause this: they are scanned as text, in any encoding, also when they hold NUL characters (UTF-16, or zeros at the end of a save cut short). A registered name whose file does not exist does not cause it either.

**Solutions**:
- Fix the file named in the error (`validate_project` lists it in `unscannedFiles` and gives the reason), or remove its name from `project.c3proj` if it is not needed
- Then run the tool again: each UID request first scans the files named in the error again, so it works as soon as they can be read (1.9.2 and older: restart the MCP server, or make a write through the tools, so the project is scanned again)

### "... not found: names are matched with their letter case"

**Cause**: `update_object_properties` or `update_family` was given a name that differs from the registered object type or family name only in letter case, or `add_event_to_sheet`, `delete_event_from_sheet`, `update_event_variable` or `move_events_between_sheets` a sheet name that differs from the registered event sheet name only in letter case. On Windows and macOS such a name would open the file too, but the checks and the layout updates know the entity by its registered name only, so the call is refused. (For event sheets, the checks across sheets saw the sheet twice, and a move into the source sheet spelled in another case lost the moved events.)

**Solution**: Use the registered name the error suggests (`list_objects`, `list_families`, `list_eventsheets`).

### Sprite frames show the wrong image, or `validate_project` reports `frame-image`

**Cause**: The editor loads a frame's image from `images/<object>-<animation>-NNN.<ext>`, NNN being the frame's index. In construct3-mcp 1.9.0 and earlier, `add_frame_to_animation` with an `index` wrote its placeholder over the image at that index (without a backup) and did not move the later images, and `delete_frame_from_animation` did not move them either: the frames after the change show their neighbour's image, the last frame after an insert has no image file (`frame-image` warning), and the last file after a delete is left over (`frame-image` info), where a later append wrote its placeholder over it.

**Solution**: Later versions move the image files with their frames and keep replaced or deleted images as `<file>.bak`. For frames changed by an older version, restore the images from version control or a copy of the project, or rename the files in `images/` by hand so that each frame's file carries its index (all lowercase, `.jpg` for a JPEG frame), then run `validate_project` again. An image the old insert wrote over cannot be recovered from the project folder.

### "Could not replace ..."

**Cause**: Writing a file renames a temp copy (`.c3mcp-<16 hex digits>.tmp`, in the same folder) onto it. When that rename fails with `EEXIST`, the server first checks that the folder can make hard links (it links the temp copy to a `.c3mcp-<16 hex digits>.link` name and removes that again), then renames the file aside (`.c3mcp-<16 hex digits>.old`), links the temp copy into its place, and removes its extra names. Links never replace a file, so a file something else put at the name meanwhile is left alone. This error means one of those steps failed; the system's errors in it are the first rename's and the failed step's. The message says what was on disk when the error was raised:
- "Could not replace <name>: <error>, and the way around that error needs a hard link in this folder, which failed (<error>). This write did not change it.": the hard-link check failed, and the file was not moved.
- "Could not replace <name>: <error>. This write did not change it.": the file could not be moved aside (or its aside name could not be checked), and it was not moved.
- "Could not replace <name>: <error>. It was put back, so this write did not change it.": the new content could not be linked into place, and the file was linked back. It is the same file as before.
- "Could not replace <name>: <error>, and <name> is not a regular file. It was put back, so this write did not change it.": something other than a file (a folder) took the file's name during the write; it was moved back, and nothing was put in its place.
- "... <name> was created again while this write had it moved aside (<error>), and that file was left as it is. At that point what was at <name> before this write was in <.old file> and this write's content in <.tmp file>, both in the same folder, and neither was removed.": something else put a file at the name during the write.
- "... Putting it back failed too (<error>). At that point what was at <name> before this write was in <.old file> and this write's content in <.tmp file>, both in the same folder, and neither was removed. If <name> is missing, rename <.old file> to <name> to put it back.": the file could not be linked back.

**Solution**: If the message ends "did not change it", the file is as it was: run the tool again, unless the message says the hard link failed with an error a rerun cannot change, such as a folder that does not support hard links: then the write cannot be made in that folder. In the other two cases, check the file the message names first: a tool that keeps a `.bak` may already have put the file back from it, as the rest of its message then says. If the file is missing, rename the `.old` file back to it (the `.old` file holds the file as it was before the write), then run the tool again. If it is there, keep the version you want; the `.old` and `.tmp` files are then leftovers.

Such files can also stay in other cases, when the server could not remove them or a write was interrupted. Nothing else removes them, and a later write never writes over them. Check each one before you delete it, starting with any `.old` file:
- a `.c3mcp-...old` file, and the file it belonged to missing: the write was interrupted while the file was moved aside, and the `.old` file holds the file as it was before that write. It may be the only copy: do not delete it. Rename it back to the file's name (the file's own content shows which file it is), then run the tool again;
- a `.c3mcp-...old` file next to a file whose write succeeded: it holds the file as it was before that write;
- a `.c3mcp-...old` file next to a file that was put back: it is a second name of that same file;
- a `.c3mcp-...tmp` file: that write's content, possibly incomplete when the write failed while writing it (after a successful write, a second name of the new file);
- a `.c3mcp-...link` file: a second name of that write's content, which is the new file when the write succeeded.

### Backup files (.bak)

Writes through the project writer copy each file to `<file>.bak` next to it before changing or deleting it, once per tool call. Each entity, timeline, script and project file has one `.bak`, which the next tool call that writes the same file overwrites, so it holds the state before the **last tool call** that wrote that file, not the state before your session. Images do not follow this: each backup takes the first free name (`<file>.bak`, `<file>.1.bak`, ...), so an older image backup is never replaced, and image backups accumulate (one more for each call that writes the image, with no bound; nothing removes them). A tool call that writes a file twice (e.g. `create_object` with a new built-in addon writes `project.c3proj` twice) backs it up before its first write (1.9.2 and older backed it up before each write, so the `.bak` could hold the call's own intermediate state). `register_addon`, `unregister_addon`, the timeline tools and the runtime-bridge tools (`inject_runtime_bridge`, `remove_runtime_bridge`, and `export_for_preview` / `pack_project` when they inject the bridge) back up their files too, and so do the PNG image writes (`replace_sprite_image`, `replace_object_image` and the placeholder images), under the free names described above (see [Safety Model](../README.md#safety-model)). A file that did not exist before the call has no `.bak`. Nothing deletes `.bak` files; `validate_project` lists them as `backup-file` info entries.

For undo across several steps, keep the project under git and commit before each session (see the [User Guide](USER-GUIDE.md#the-safe-editing-workflow)). To undo only the last change to one file:

1. Find the `.bak` file next to the affected file
2. Delete or rename the corrupted file
3. Rename the `.bak` file to remove the `.bak` extension
4. Go on: the next tool call sees the restored file (1.9.2 and older: restart the MCP server first)

In `images/`, `add_frame_to_animation`, `delete_frame_from_animation`, `reorder_frames`, `reverse_frames` and `duplicate_frame` keep a deleted frame's image (from `delete_frame_from_animation`) and any file they would otherwise replace as `<file>.bak` (`<file>.1.bak`, … when that name is taken), and `delete_object` keeps the image files of the object it deletes the same way; their `warnings` name these files, and `validate_project` lists them as `backup-file` info. Image files that older versions of `delete_object` left in place are listed as `orphaned-image` info. A file ending in `.reorder` is an image that `reorder_frames` or `reverse_frames` moved under a temporary name and did not rename on to its final name: either the process stopped during the renames, or a rollback could not finish, and then the error names the file. A stop during the renames leaves the object file as it was; restore `images/` from version control or a copy of the project.

## Runtime Tool Issues

### "Runtime bridge was not ready after ... ms"

`connect_to_game` found no page whose `globalThis.__c3bridge` answered ready; the message lists the pages it tried.
- Inject the bridge (`inject_runtime_bridge`), reopen the project in Construct 3, and export or preview again: a build made before the injection has no bridge. The answer's `loadedAs` says how Construct loads it (imported by the main script, or as the main script).
- Check the game has started: the preview's console shows `[c3-bridge] Runtime bridge initialized`.
- With several tabs, pass `pageUrl` (the game's address, such as the `url` from `serve_preview`), `urlContains` (part of the game's address or path; the query does not count) or the tab's `cdpEndpoint` (`serve_preview` returns it as `browser.pageEndpoint`).
- Projects with *Use worker* on work: the bridge is found in the runtime's worker (`bridgeContext: "worker"`).

### "Runtime bridge command timed out ... it had not run yet and was withdrawn"

The game did not tick while `call_bridge` waited. A browser runs no animation frames for a hidden page (a background tab, a minimized window), and the bridge processes commands on ticks. `connect_to_game` brings the tab to the front and warns (`pageVisible: false`) when it stays hidden; show the window, or run the game in a window of its own. The command was withdrawn, so it will not run later. "It may still run later" means the game carries an older bridge without `cancel`: inject the current one.

### "N pages have a ready runtime bridge (...); connect_to_game does not guess which is the game"

More than one tab of the browser has a `globalThis.__c3bridge` that answers ready: two previews of the game, the editor's preview beside an export, or another site that defines such an object. `connect_to_game` does not pick one, since the wrong tab would get your input and answer your commands. Name the game: `pageUrl` with its address (`serve_preview` returns it as `url`), `urlContains` with part of its address or path, or `cdpEndpoint` with the tab's endpoint (`browser.pageEndpoint`). Or close the other tabs.

### "The game page reloaded or navigated since connect_to_game"

The page was reloaded (F5, a new export being served, the game reloading itself) or left for another address. The game started over: its variables are back at their start values, and subscriptions and pending commands are gone. The connection was closed so that no tool drives the new game as if it were the old one. Call `connect_to_game` again, and `subscribe_events` again if you used it.

### "The runtime connection needs the WebSocket client built into Node.js 22 and later"

The connection tools use Node.js's built-in WebSocket client. Start the server with Node.js 22 or later; the other tools work on older versions.

### "No Chrome or Edge executable found" / "CHROME_PATH is set but names no file"

`serve_preview` launches the browser from `CHROME_PATH` or the usual install locations (the log lists the places tried). Set `CHROME_PATH` in the server's environment (the `env` of its MCP configuration) to the browser executable, the file itself (`chrome.exe`, `msedge.exe`), not its folder. A browser path cannot be passed as a tool parameter.

### "The browser could not be started (...)"

The file `CHROME_PATH` (or the install location found) names could not be started: `EFTYPE` or `EACCES` mean it is not an executable, `ENOENT` that it disappeared. The server log names the file. Nothing is left behind: the temporary profile made for the launch is removed.

### "Port N on 127.0.0.1 is in use by another program"

`serve_preview` was given a `port` that something else already answers on. On Windows a second program can listen on the same port for all interfaces, and connections that program already holds would keep reaching it. Choose another port, or leave `port` out for any free one.

### "Condition type "expression" ... is off unless the server was started with C3MCP_ALLOW_EVAL=1"

Expression conditions run JavaScript in the game page. Use a `globalVar`, `objectProperty` or `layout` condition, or set `C3MCP_ALLOW_EVAL=1` in the server's environment if you want to allow page script.

### "Refusing to connect to ...: only this machine ... is allowed" / "The debugging port lists page endpoints on another host"

`connect_to_game` reaches browsers on this machine only, and follows the page endpoints a debugging port on this machine lists only when they are on this machine too. To allow another machine, set `C3MCP_ALLOW_REMOTE_CDP=1` in the server's environment.

### `screenshot_game`: "outputPath must be an absolute path", "must end in .png", "lies inside the open project's folder", "exists already"

`screenshot_game` writes one new image file outside the project: an absolute path (a relative one would land wherever the server was started), with the extension of the format (`.png`, or `.jpg`/`.jpeg` for `format: "jpeg"`), not in the project folder (the runtime tools leave the project as it is), and an existing file only with `overwrite: true`. The checks run before the capture, so nothing was written.

### `remove_runtime_bridge`: "Nothing was changed: scripts/... uses the bridge in a way remove_runtime_bridge cannot take out"

A script imports `c3-runtime-bridge.js` other than with a line of its own (`import "./c3-runtime-bridge.js";`), for example `import * as bridge from "./c3-runtime-bridge.js"` or `import("./c3-runtime-bridge.js")`. Without the bridge file that script would fail and the game would not load, so nothing was removed. Take that use out of the named script, then call `remove_runtime_bridge` again.

### `serve_preview` refuses `host`, `allowRemoteHost`, `chromePath` or `chromeDebuggingPort`

These parameters existed in the BeatsByZann fork this tool was ported from and were not taken over: the server listens on 127.0.0.1 only, the browser comes from `CHROME_PATH`, and it picks its own debugging port (returned as `browser.cdpPort`). Use the address the tool returns (`http://127.0.0.1:<port>/`); requests naming another host get 403.

## Build Issues

### TypeScript compilation errors

```bash
npm run build
```

If you get type errors after modifying the code:
- Ensure you're using TypeScript 5.7+: `npx tsc --version`
- Run `npm install` to ensure dependencies are up to date
- Check that all imports use `.js` extensions (required for ESM)

### "Cannot find module" at runtime

**Cause**: Missing `.js` extension in import or file not compiled.

**Solutions**:
- All imports must end in `.js` (TypeScript ESM convention)
- Run `npm run build` to compile
- Check `dist/` folder has the compiled files

## Performance Issues

### Slow first query after startup

**Cause**: The ID generator scans all project files on first use to collect existing SIDs/UIDs.

**Solution**: This is expected and only happens once per session. Subsequent queries are fast.

### Slow analysis tools

**Cause**: Analysis tools like `get_eventsheet_flow` and `get_object_dependencies` need to read all project files to build the cross-reference index.

**Solution**: The index is cached after first build. Subsequent analysis queries are fast. After a write operation, the cache is cleared and will be rebuilt on next analysis query.

Files over the size limit (10MB by default) or with invalid JSON are not in the index; the reference checks, `find_orphaned_objects` and `get_object_dependencies` search them as text on every call instead, only while there are such files. The search streams the file. Measured on a 50MB layout (Node 22, Windows 11): about 0.1 seconds with one name or with 200, while the names are rare in the text; about 0.2 to 0.3 seconds when a searched name is common inside other names (e.g. `Bullet` in 400,000 `EnemyBullet` instances); about 2 seconds in a constructed worst case of 200 very short names that occur everywhere (`e`, `i`, ...). `find_orphaned_objects` and `get_object_dependencies` with 200 unused objects on such a layout take about 0.1 seconds.

## Getting Help

- **GitHub Issues**: [Report a bug](https://github.com/liauw-media/construct3-mcp/issues)
- **GitHub Discussions**: [Ask a question](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Last Updated**: 2026-09-29
