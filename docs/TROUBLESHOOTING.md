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

- **GitHub Issues**: [Report a bug](https://github.com/liauw-media/construct3-mcp/issues)
- **GitHub Discussions**: [Ask a question](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Last Updated**: 2026-02-16
