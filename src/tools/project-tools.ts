/**
 * Project metadata tools: update_project_metadata, list_addons, register_addon, unregister_addon, load_addon_definitions.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Addon } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { KNOWN_SCIRRA_PLUGINS, KNOWN_SCIRRA_BEHAVIORS } from '../construct3/templates.js';
import { withProjectSync } from './project-sync.js';
import { addonDefinitionsOf, type AddonDefinitions } from '../construct3/addon-definitions.js';
import type { AddonDefinition } from '../construct3/ace-types.js';

export function registerProjectTools({ server: mcpServer, reader, writer }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);
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
        const alreadyRegistered = () => toolResult({
          success: true,
          entity: args.id,
          category: 'addon',
          action: 'already_registered',
          warnings: [`Addon "${args.id}" (${args.type}) is already registered in usedAddons.`],
        }, { projectWritten: false });
        if (addons.some(a => a.type === args.type && a.id === args.id)) return alreadyRegistered();

        const newAddon: Addon = {
          type: args.type,
          id: args.id,
          name: args.name,
          author: args.author,
          bundled: args.bundled,
        };
        // Through the writer: backed up once per call, and a change saved on disk meanwhile is merged into
        const backup = await writer.updateProject(project => {
          // Checked again in the file as it is now: the editor may have registered it meanwhile
          if ((project.usedAddons as Addon[]).some(a => a.type === args.type && a.id === args.id)) return false;
          project.usedAddons.push(newAddon);
        });
        // Nothing was written: the editor got there first
        if (backup === undefined) return alreadyRegistered();

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
        const notRegistered = () => toolError(`Addon "${args.id}" (${args.type}) is not registered in this project.`);
        if (!addons.some(a => a.type === args.type && a.id === args.id)) return notRegistered();

        // Warn if removing a known built-in
        const knownMap = args.type === 'plugin' ? KNOWN_SCIRRA_PLUGINS : (args.type === 'behavior' ? KNOWN_SCIRRA_BEHAVIORS : {});
        if (knownMap[args.id] && !args.force) {
          return toolError(`"${args.id}" is a known Scirra built-in ${args.type}. Use force=true if you really want to unregister it.`);
        }

        // Through the writer: backed up once per call, and a change saved on disk meanwhile is merged into
        const backup = await writer.updateProject(project => {
          const projIdx = (project.usedAddons as Addon[]).findIndex(a => a.type === args.type && a.id === args.id);
          if (projIdx === -1) return false;
          project.usedAddons.splice(projIdx, 1);
        });
        // Nothing was written: the editor removed it first
        if (backup === undefined) return notRegistered();

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

  // ─── load_addon_definitions ───────────────────────────────

  server.tool(
    'load_addon_definitions',
    'Load a third-party addon\'s definitions (addon.json and aces.json) so that validate_project and the event tools can check its conditions, actions and expressions. '
      + 'The path is an addon folder, or a folder holding several addon folders; give an absolute path, because a relative one is resolved against the folder the server was started in. '
      + 'The path must lie inside the project folder (for a .c3p project, the folder that holds the .c3p) or inside a root named in the C3_ADDON_DEFINITIONS variable. '
      + 'Call it without a path to list the definitions loaded so far. '
      + 'It changes only what this server checks; it writes nothing to the project.',
    {
      path: z.string().min(1).max(4096).optional().describe('Addon folder, or a folder holding addon folders; omit to list what is loaded'),
    },
    async (args) => {
      try {
        const defs = addonDefinitionsOf(reader);
        if (args.path === undefined) {
          return toolResult({ loaded: defs.list().map(summaryOf), skipped: [], nowLoaded: nowLoaded(defs) });
        }
        const report = await defs.load(args.path);
        if (report.loaded.length === 0) {
          const joined = report.skipped.map(s => `${s.name}: ${s.reason}`).join('; ');
          const text = joined.endsWith('.') ? joined : `${joined}.`;
          return toolError(`Error loading addon definitions: ${text}${text.endsWith('Nothing was loaded.') ? '' : ' Nothing was loaded.'}`);
        }
        return toolResult({ loaded: report.loaded, skipped: report.skipped, nowLoaded: nowLoaded(defs) });
      } catch (error) {
        console.error('[load_addon_definitions] failed:', error);
        return toolError('Error loading addon definitions. Nothing was loaded.');
      }
    }
  );
}

/** A definition without its ACEs, as a load report lists it. */
function summaryOf(definition: AddonDefinition): Omit<AddonDefinition, 'aces'> {
  const { aces: _aces, ...summary } = definition;
  return summary;
}

/** The loaded definitions as "<type>:<id>". */
function nowLoaded(defs: AddonDefinitions): string[] {
  return defs.list().map(d => `${d.type}:${d.id}`);
}
