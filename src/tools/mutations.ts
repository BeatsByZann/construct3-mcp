/**
 * Mutation tools orchestrator.
 * Delegates to domain-specific modules that register tools on the MCP server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import { registerObjectTools } from './object-tools.js';
import { registerContainerTools } from './container-tools.js';
import { registerEventTools } from './event-tools.js';
import { registerLayerOrderTools } from './layer-order.js';
import { registerLayoutTools } from './layout-tools.js';
import { registerLayerRenameTools } from './layer-rename.js';
import { registerBulkInstanceTools } from './bulk-instance-tools.js';
import { registerProjectTools } from './project-tools.js';
import { registerHierarchyTools } from './hierarchy-tools.js';
import { registerAnimationTools } from './animation-tools.js';
import { registerEffectTools } from './effect-tools.js';
import { registerTimelineTools } from './timeline-tools.js';
import { registerObjectRenameTools } from './object-rename.js';
import { registerEntityRenameTools } from './entity-rename.js';
import { registerFlowchartTools } from './flowchart-tools.js';

export function registerMutationTools(
  server: McpServer,
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  idGen: IdGenerator,
) {
  const deps = { server, reader, writer, idGen };
  registerObjectTools(deps);
  registerContainerTools(deps);
  registerEventTools(deps);
  registerLayerOrderTools(deps);
  registerLayoutTools(deps);
  registerLayerRenameTools(deps);
  registerBulkInstanceTools(deps);
  registerProjectTools(deps);
  registerHierarchyTools(deps);
  registerAnimationTools(deps);
  registerEffectTools(deps);
  registerTimelineTools(deps);
  registerObjectRenameTools(deps);
  registerEntityRenameTools(deps);
  registerFlowchartTools(deps);
}
