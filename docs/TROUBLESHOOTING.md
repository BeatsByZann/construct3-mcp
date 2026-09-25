# Troubleshooting

Common issues and solutions for the Construct3 MCP Server.

## Server Won't Start

### "No .c3proj file found in directory"

**Cause**: The path you provided doesn't contain a `.c3proj` file.

**Solutions**:
- Pass the path directly to the `.c3proj` file: `node dist/index.js /path/to/project.c3proj`
- Or pass the directory that contains it: `node dist/index.js /path/to/project-folder/`
- For a single-file project, pass the `.c3p` file itself: `node dist/index.js /path/to/game.c3p`

### "The project was NOT saved to ...: ... was changed by something else"

**Cause**: The server was serving a `.c3p` and something else, usually Construct saving the project, wrote the archive after the server opened it. The server will not overwrite it.

**Solutions**:
- The session's changes are in the working folder the message names; copy out what you need.
- Restart the server to load the archive as it is now.
- Do not save the project in Construct while the server is writing to the same archive.

### "Invalid Construct3 project file"

**Cause**: The `.c3proj` file exists but isn't valid JSON or is missing required fields.

**Solutions**:
- Open the project in Construct 3 editor and re-save it
- Check the file isn't corrupted (open it in a text editor — it should be valid JSON)
- Ensure it has required top-level fields: `name`, `objectTypes`, `eventSheets`, `layouts`

### "Usage: construct3-mcp <project-path>"

**Cause**: No project path was provided.

**Solutions**:
- Pass the path as the first argument: `node dist/index.js /path/to/project`
- Or set the environment variable: `C3_PROJECT_PATH=/path/to/project node dist/index.js`

## Connection Issues

### Server starts but Claude doesn't see the tools

**Solutions**:
- Verify your MCP config JSON is valid (check for trailing commas, etc.)
- Make sure the path to `dist/index.js` is absolute
- Restart Claude Code / Claude Desktop after changing MCP config
- Check stderr output for error messages: `node dist/index.js /path/to/project 2>debug.log`

### "Server disconnected" errors

**Cause**: The server process crashed.

**Solutions**:
- Check if the project files are accessible (not locked by another process)
- Run the server manually to see the error: `node dist/index.js /path/to/project`
- Ensure Node.js >= 18.0.0: `node --version`

## Query Tool Issues

### "Object type X not found"

**Cause**: The name doesn't match exactly (case-sensitive).

**Solutions**:
- Use `list_objects` to see all available names
- Use `search_objects` with a partial name
- The error message includes "Did you mean: ..." suggestions when a close match exists

### "Event sheet X not found" / "Layout X not found"

Same as above — use the corresponding `list_` tool to find the correct name.

### "... changed on disk after this server last read it"

**Cause**: A write started from a copy the server read before Construct or another program saved the file (a bulk read the analyzers cached). Overwriting it would lose that save.

**Solution**: Call `reload_project`, which re-reads the project and lists the files that had changed, then repeat the call. A call that reads the file fresh does not hit this; its result carries a `Note:` naming the file instead.

### "cannot be reverted: later call(s) ... touched the same file(s)"

**Cause**: `revert_last_change` works from the single `.bak` beside each file, and a later call (even one already reverted) rewrote that backup.

**Solution**: Revert the later calls first, one at a time, or restore the `.bak` files by hand; `list_changes` shows which files each call touched.

### Stale data after editing in C3 editor

**Cause**: The reader caches project data at startup.

**Solution**: Restart the MCP server to pick up changes made in the C3 editor. The server caches data for performance — external changes aren't detected automatically.

## Mutation Tool Issues

### "Object X already exists"

**Cause**: Trying to create an object with a name that's already taken.

**Solution**: Use `update_object_properties` to modify the existing object, or choose a different name.

### "Plugin X is not registered in usedAddons"

**Cause**: The plugin is a third-party addon not in the project's `usedAddons` list. The server can only auto-register known Scirra built-in addons.

**Solution**: Open the project in the Construct 3 editor, add an object using that plugin (which registers it), save, then restart the MCP server.

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

### "Object is still referenced"

**Cause**: `delete_object` found references in event sheets, layouts, or families.

**Solutions**:
- Remove all references first, then delete
- Use `force: true` to delete anyway (references will NOT be cleaned up — you'll need to fix them manually)
- The error response lists all locations where the object is referenced

### Backup files (.bak)

Every mutation creates `.bak` backup files next to the modified files. If something goes wrong:

1. Find the `.bak` file next to the affected file
2. Delete or rename the corrupted file
3. Rename the `.bak` file to remove the `.bak` extension
4. Restart the MCP server

### "... differs from ... only in case"

**Cause**: `rename_object_type`, `rename_family`, `rename_layout` and `rename_event_sheet` rename files. On a case-insensitive disk (Windows, macOS by default) the new file would replace the old one before the old one is deleted, losing the entity.

**Solution**: Rename to a temporary name first, then to the name you want. The same tools also refuse a new name that matches another entity's name in any case.

### `project.c3proj` changes after the next save in Construct

**Cause**: The tools write `project.c3proj` in the shape Construct r495.2 saves: script entries use `script-info`, a `models3d` folder exists, and for a project an older release saved, `uidAllocationMode` and `scriptsType` sit where r495.2 puts them and a release-44903-or-older `zAxisScale` "normalized" is written as "regular". What the editor still changes on save is its own work: it stamps `savedWithRelease`, removes addons from `usedAddons` that nothing uses (the tools never prune that list), and on an older project may fill defaults such as `fixedFramerate` or change `exportFileStructure`.

**Solution**: Nothing to fix. Commit the editor's save separately from the tool's change if you want the history to show which is which.

## Validation Warnings

### `ace-definitions-unavailable` (info)

**Cause**: A plugin or behavior in `usedAddons` is neither built into Construct r495.2 nor loaded, so its conditions and actions are not checked.

**Solution**: Set `C3_ADDON_DEFINITIONS` to the addon's `.c3addon` file or unpacked folder (several paths separated by `;` on Windows, `:` elsewhere) before starting the server, or call `load_addon_definitions` with that path. The addon's own `addon.json` and `aces.json` are read; nothing is executed.

### `expression-*` warnings

**Cause**: A parameter's expression did not parse (`expression-syntax`) or names something the project and the catalogue do not define (`expression-unknown-object`, `expression-unknown-member`, `expression-unknown-function`, `expression-unknown-name`), or calls a function or custom action with the wrong number of arguments (`expression-argument-count`).

**Solution**: Fix the expression, or load the definitions of the third-party addon it uses. Names match without case, as in Construct. The event is written anyway; the warning does not block the tool.

### `event-legacy-key`

**Cause**: A block, condition or action carries a key Construct neither writes nor reads, such as `object-class` or `behavior-type` (the real keys are `objectClass` and `behaviorType`). Construct then reports the ACE as missing on load.

**Solution**: Delete the event and add it again with `add_event_block`, which writes the correct keys, or rename the key in the sheet file with the project closed in Construct.

## Runtime and Preview Issues

### "No Chrome or Edge executable found in the ... usual locations"

**Cause**: `serve_preview` with `launchBrowser` looked in the standard install folders and found no browser.

**Solution**: Pass `chromePath`, or set `CHROME_PATH` to the browser executable, and call `serve_preview` again. The server log lists the locations it checked.

### "The folder holds a source project (project.c3proj), not an exported game"

**Cause**: `serve_preview` serves an HTML5 export, and Construct exports only from its editor. A source folder or a `.c3p` cannot be served.

**Solution**: In Construct choose Menu > Project > Export > Web (HTML5), then pass the folder that holds the exported `index.html`. To let the tools talk to the game, inject the runtime bridge with `inject_runtime_bridge` before exporting.

### "Refusing to connect to ...: only this machine ... is allowed unless allowRemoteHost is true"

**Cause**: The runtime bridge runs script in whatever page it reaches, so `connect_to_game` and `serve_preview` stay on loopback by default.

**Solution**: Use `localhost` or `127.0.0.1`. Set `allowRemoteHost: true` only for a machine and page you control.

### "Unknown command: layerToCssPx" (or `subscribeEvents`, `readEvents`, `unsubscribeEvents`)

**Cause**: The game was exported with an older bridge script, which does not have the command. `simulate_input` with `coordinateSpace: "layout"` and the event-subscription tools need the current bridge.

**Solution**: Run `inject_runtime_bridge` again on the project, export again, and reconnect. Nothing was dispatched by the failed call.

### "Unknown subscription: sub-N"

**Cause**: The subscription was already removed, or the page reloaded; subscriptions live in the page and end with it.

**Solution**: Call `subscribe_events` again after a reload. `unsubscribe_events` on an unknown id is an error by design, not a silent success.

### "Unknown global variable: ..." from `subscribe_events`

**Cause**: `globalVarChange` subscribes to one global variable, and the running game has none by that name.

**Solution**: Check the name with `call_bridge` and the `listGlobalVars` command. A `globalVarChange` subscription needs `filter.variable`.

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

## Getting Help

- **This fork**: [Report a bug](https://github.com/BeatsByZann/construct3-mcp/issues) in anything the fork changed or added (see [FORK.md](../FORK.md)), saying which branch you are on
- **Upstream**: [Report a bug](https://github.com/liauw-media/construct3-mcp/issues) in upstream behavior
- **GitHub Discussions**: [Ask a question](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Last Updated**: 2026-09-24
