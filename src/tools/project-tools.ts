/**
 * Project metadata tools: update_project_metadata, update_project_properties,
 * list_addons, register_addon, unregister_addon.
 */

import { z } from 'zod';
import { backupOnce, recordWrite } from '../construct3/change-journal.js';
import { upgradeProjectShape } from '../construct3/project-shape.js';
import { readFile, writeFile, rename, unlink } from 'fs/promises';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Addon } from '../construct3/types.js';
import { toolResult, toolError, notFoundError, boundedRecord } from './shared.js';
import { KNOWN_SCIRRA_PLUGINS, KNOWN_SCIRRA_BEHAVIORS } from '../construct3/templates.js';
import { PROJECT_PROPERTY_KEYS, PROJECT_TOP_LEVEL_KEYS } from '../construct3/project-writer.js';
import { loadAddonDefinitions, loadedAddonDefinitions } from '../construct3/addon-definitions.js';

export function registerProjectTools({ server, reader, writer }: MutationToolDeps) {
  server.tool(
    'update_project_metadata',
    'Update project metadata (name, version, author, description)',
    {
      name: z.string().max(200).optional().describe('Project name'),
      version: z.string().max(50).optional().describe('Project version'),
      author: z.string().max(200).optional().describe('Author name'),
      description: z.string().max(1000).optional().describe('Project description'),
    },
    async (args) => {
      try {
        const updates: Record<string, unknown> = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.version !== undefined) updates.version = args.version;
        if (args.author !== undefined) updates.author = args.author;
        if (args.description !== undefined) updates.description = args.description;

        if (Object.keys(updates).length === 0) {
          return toolError('No updates provided. Specify at least one of: name, version, author, description.');
        }

        const backupPath = await writer.updateProjectProperties(updates);

        const result: WriteResult = {
          success: true,
          entity: 'project',
          category: 'project',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_project_metadata] failed:', error);
        return toolError(`Error updating project metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_project_properties ────────────────────────────

  server.tool(
    'update_project_properties',
    'Update project settings: any key of project.properties plus the top-level firstLayout, viewport size, worker mode and functions name. Use update_project_metadata for name, version, author and description.',
    {
      properties: boundedRecord(60, 3).optional().describe('Values merged into project.properties, keyed by Construct property name (e.g. fullscreenMode, sampling, zFar); unknown keys are rejected'),
      firstLayout: z.string().max(200).optional().describe('Startup layout name (validated for existence)'),
      viewportWidth: z.number().int().positive().max(100_000).optional().describe('Project viewport width in pixels'),
      viewportHeight: z.number().int().positive().max(100_000).optional().describe('Project viewport height in pixels'),
      useWorker: z.string().max(50).optional().describe('Worker mode; Construct writes values such as "dom" or "auto"'),
      functionsName: z.string().max(200).optional().describe('Script-interface name for functions (a JavaScript identifier, e.g. "Fn")'),
    },
    async (args) => {
      try {
        const updates: Record<string, unknown> = {};

        if (args.properties !== undefined) {
          // The writer routes any non-top-level key into project.properties;
          // validate here so the caller gets the key list instead of a throw.
          const invalid = Object.keys(args.properties).filter(k => !PROJECT_PROPERTY_KEYS.includes(k));
          if (invalid.length > 0) {
            return toolError(
              `Unknown project property key(s): ${invalid.join(', ')}. ` +
              `Valid keys for "properties" are: ${PROJECT_PROPERTY_KEYS.join(', ')}. ` +
              `Top-level settings (${PROJECT_TOP_LEVEL_KEYS.join(', ')}) have their own parameters here or in update_project_metadata.`
            );
          }
          Object.assign(updates, args.properties);
        }

        if (args.firstLayout !== undefined) {
          const layouts = await reader.listLayouts();
          if (!layouts.includes(args.firstLayout)) {
            return notFoundError('Layout', args.firstLayout, reader.findNearestName(args.firstLayout, 'layouts'), 'list_layouts');
          }
          updates.firstLayout = args.firstLayout;
        }

        if (args.viewportWidth !== undefined) updates.viewportWidth = args.viewportWidth;
        if (args.viewportHeight !== undefined) updates.viewportHeight = args.viewportHeight;
        if (args.useWorker !== undefined) updates.useWorker = args.useWorker;

        if (args.functionsName !== undefined) {
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(args.functionsName)) {
            return toolError(`functionsName "${args.functionsName}" is not a valid JavaScript identifier; scripts address functions through this name.`);
          }
          updates.functionsName = args.functionsName;
        }

        if (Object.keys(updates).length === 0) {
          return toolError('No updates provided. Specify at least one of: properties, firstLayout, viewportWidth, viewportHeight, useWorker, functionsName.');
        }

        const backupPath = await writer.updateProjectProperties(updates);

        const result: WriteResult = {
          success: true,
          entity: 'project',
          category: 'project',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_project_properties] failed:', error);
        return toolError(`Error updating project properties: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── list_addons ──────────────────────────────────────────

  server.tool(
    'list_addons',
    'List all addons (plugins, behaviors, effects) registered in the project',
    {
      type: z.enum(['plugin', 'behavior', 'effect', 'all']).optional().default('all').describe('Filter by addon type (default: all)'),
    },
    async (args) => {
      try {
        const addons = reader.getUsedAddons();
        const filtered = args.type === 'all' ? addons : addons.filter(a => a.type === args.type);
        return toolResult({
          addons: filtered,
          count: filtered.length,
        });
      } catch (error) {
        console.error('[list_addons] failed:', error);
        return toolError(`Error listing addons: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── load_addon_definitions ───────────────────────────────
  server.tool(
    'load_addon_definitions',
    'Load a third-party addon\'s conditions and actions (its addon.json and aces.json) so validate_project and the event tools check that addon\'s ACEs like the built-in ones. Without a path, list the definitions loaded so far.',
    {
      path: z.string().min(1).max(4096).optional().describe('An unpacked addon folder, a .c3addon file, or a folder holding several of either'),
    },
    async ({ path }) => {
      try {
        const summary = (d: ReturnType<typeof loadedAddonDefinitions>[number]) => ({
          id: d.id, type: d.type, name: d.name, version: d.version, source: d.source, counts: d.counts,
        });
        if (path === undefined) {
          return toolResult({ success: true, loaded: loadedAddonDefinitions().map(summary) });
        }
        const report = await loadAddonDefinitions(path);
        const warnings = report.skipped.map(s => `${s.path}: ${s.reason}`);
        return toolResult({
          success: report.loaded.length > 0,
          loaded: report.loaded,
          nowLoaded: loadedAddonDefinitions().map(d => `${d.type}:${d.id}`),
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[load_addon_definitions] failed:', error);
        return toolError(`Error loading addon definitions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── register_addon ───────────────────────────────────────

  server.tool(
    'register_addon',
    'Register an addon (plugin, behavior, or effect) in the project usedAddons list. For effects, use this before add_effect since effects are not auto-registered.',
    {
      type: z.enum(['plugin', 'behavior', 'effect']).describe('Addon type'),
      id: z.string().max(200).describe('Addon ID (e.g. "Sprite", "Tween", "hsladjust")'),
      name: z.string().max(200).describe('Human-readable display name'),
      author: z.string().max(200).optional().default('Scirra').describe('Addon author (default: Scirra)'),
      bundled: z.boolean().optional().default(false).describe('Whether the addon is bundled with C3 (default: false)'),
    },
    async (args) => {
      try {
        const addons = reader.getUsedAddons();
        const already = addons.some(a => a.type === args.type && a.id === args.id);
        if (already) {
          return toolResult({
            success: true,
            entity: args.id,
            category: 'addon',
            action: 'already_registered',
            warnings: [`Addon "${args.id}" (${args.type}) is already registered in usedAddons.`],
          });
        }

        const projectPath = reader.getProjectPath();
        const content = await readFile(projectPath, 'utf-8');
        const project = JSON.parse(content);

        const newAddon: Addon = {
          type: args.type,
          id: args.id,
          name: args.name,
          author: args.author,
          bundled: args.bundled,
        };
        project.usedAddons.push(newAddon);

        upgradeProjectShape(project);
        await backupOnce(projectPath);
        const tmpPath = projectPath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
        try {
          await rename(tmpPath, projectPath);
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
            await unlink(projectPath);
            await rename(tmpPath, projectPath);
          } else {
            try { await unlink(tmpPath); } catch { /* best-effort */ }
            throw e;
          }
        }
        await recordWrite(projectPath, true);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.id,
          category: 'addon',
          action: 'created',
        };
        return toolResult(result);
      } catch (error) {
        console.error('[register_addon] failed:', error);
        return toolError(`Error registering addon: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── unregister_addon ─────────────────────────────────────

  server.tool(
    'unregister_addon',
    'Remove an addon from the project usedAddons list. Use with caution — removing an addon that is still used will cause C3 to error on load.',
    {
      type: z.enum(['plugin', 'behavior', 'effect']).describe('Addon type'),
      id: z.string().max(200).describe('Addon ID to remove'),
      force: z.boolean().optional().default(false).describe('Remove even if the addon is a known built-in (default: false — requires force=true for built-ins)'),
    },
    async (args) => {
      try {
        const addons = reader.getUsedAddons();
        const idx = addons.findIndex(a => a.type === args.type && a.id === args.id);
        if (idx === -1) {
          return toolError(`Addon "${args.id}" (${args.type}) is not registered in this project.`);
        }

        // Warn if removing a known built-in
        const knownMap = args.type === 'plugin' ? KNOWN_SCIRRA_PLUGINS : (args.type === 'behavior' ? KNOWN_SCIRRA_BEHAVIORS : {});
        if (knownMap[args.id] && !args.force) {
          return toolError(`"${args.id}" is a known Scirra built-in ${args.type}. Use force=true if you really want to unregister it.`);
        }

        const projectPath = reader.getProjectPath();
        const content = await readFile(projectPath, 'utf-8');
        const project = JSON.parse(content);

        const projIdx = (project.usedAddons as Addon[]).findIndex(a => a.type === args.type && a.id === args.id);
        if (projIdx !== -1) {
          project.usedAddons.splice(projIdx, 1);
        }

        upgradeProjectShape(project);
        await backupOnce(projectPath);
        const tmpPath = projectPath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
        try {
          await rename(tmpPath, projectPath);
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
            await unlink(projectPath);
            await rename(tmpPath, projectPath);
          } else {
            try { await unlink(tmpPath); } catch { /* best-effort */ }
            throw e;
          }
        }
        await recordWrite(projectPath, true);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.id,
          category: 'addon',
          action: 'deleted',
          warnings: [`Addon "${args.id}" removed from usedAddons. If any objects/behaviors still reference it, C3 will error on load.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[unregister_addon] failed:', error);
        return toolError(`Error unregistering addon: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
