/**
 * Project integrity validation for Construct 3 projects.
 * Checks file existence, required fields, duplicate IDs, broken references,
 * orphaned files, and more.
 */

import { redactFsPaths } from '../../error-messages.js';
import { readdir, lstat } from 'fs/promises';
import { join } from 'path';
import type { Construct3ProjectReader } from '../project-reader.js';
import type { C3Event, Construct3Project, Layout, ObjectType, EventSheet } from '../types.js';
import { getProjectIndex } from './index-builder.js';
import { findOrphanedObjects } from './object-deps.js';
import { SINGLE_IMAGE_PLUGINS, ANIMATION_PLUGINS } from '../templates.js';
import { getImageFileName } from '../png-generator.js';
import { collectLayers } from '../layout-walk.js';
import { ACE_CATALOG_RELEASE, buildAceContext, checkEventAces, describeEventAceProblem, isBuiltInAddon } from '../ace-catalog.js';
import { addonDefinition } from '../addon-definitions.js';
import { buildExpressionContext, checkEventExpressions, describeEventExpressionProblem } from '../expression-check.js';

/** Image file extensions by declared fileType, from the r495.2 samples. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
};

// ─── Types ───────────────────────────────────────────────────

export interface IntegrityIssue {
  check: string;
  entity: string;
  message: string;
  suggestion?: string;
}

export interface IntegrityResult {
  /** No error-level issues were found in the files that were scanned */
  valid: boolean;
  /**
   * Every registered object type, event sheet and layout file was read.
   * False when any of them was skipped for exceeding the reader's size cap
   * (listed in unscannedFiles); `valid` then only vouches for the files that
   * were checked. Files that exist but cannot be read for another reason are
   * errors, not unscanned entries. Families are not covered by this check.
   */
  complete: boolean;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    checksRun: number;
    entitiesScanned: number;
    /** Files registered in c3proj that could not be scanned (e.g. over the reader's size cap) */
    unscanned: number;
  };
  errors: IntegrityIssue[];
  warnings: IntegrityIssue[];
  info: IntegrityIssue[];
  /** Entities NOT covered by any check below — results are partial wherever these are listed */
  unscannedFiles: string[];
}

// ─── Constants ───────────────────────────────────────────────

const MAX_SID_DEPTH = 50;
const MAX_SID_NODES = 100_000;

// ─── Entry Point ─────────────────────────────────────────────

export async function validateProjectIntegrity(
  reader: Construct3ProjectReader
): Promise<IntegrityResult> {
  const errors: IntegrityIssue[] = [];
  const warnings: IntegrityIssue[] = [];
  const info: IntegrityIssue[] = [];

  // Load all data once
  const project = reader.getProject();
  const objects = await reader.readAllObjectTypes();
  const eventSheets = await reader.readAllEventSheets();
  const layouts = await reader.readAllLayouts();
  const families = await reader.readAllFamilies();

  const registeredObjects = flattenContainer(project.objectTypes);
  const registeredSheets = flattenContainer(project.eventSheets);
  const registeredLayouts = flattenContainer(project.layouts);

  const entitiesScanned =
    registeredObjects.length + registeredSheets.length + registeredLayouts.length;

  const unscannedFiles: string[] = [];

  // Error checks
  checkFileExistence(registeredObjects, objects, 'objectTypes', reader, errors, warnings, unscannedFiles);
  checkFileExistence(registeredSheets, eventSheets, 'eventSheets', reader, errors, warnings, unscannedFiles);
  checkFileExistence(registeredLayouts, layouts, 'layouts', reader, errors, warnings, unscannedFiles);
  checkRequiredFieldsObjects(objects, errors);
  checkRequiredFieldsSheets(eventSheets, errors);
  checkRequiredFieldsLayouts(layouts, errors);
  checkNameConsistency(objects, eventSheets, layouts, errors);
  checkSubfolderStructure(project, errors);
  await checkObjectImages(objects, reader, errors, warnings);

  // Warning checks
  checkDuplicateSids(objects, eventSheets, layouts, families, warnings);
  checkDuplicateUids(layouts, objects, warnings);
  await checkBrokenObjectReferences(reader, families, warnings);
  checkBrokenEventSheetReferences(layouts, eventSheets, warnings);
  checkBrokenIncludes(eventSheets, warnings);
  checkLegacyEventKeys(eventSheets, warnings);
  checkMissingAddons(objects, reader, warnings);
  await checkEventAceDefinitions(reader, eventSheets, warnings);
  await checkEventExpressionText(reader, eventSheets, warnings);

  // Info checks
  await checkOrphanedFiles(reader, registeredObjects, registeredSheets, registeredLayouts, info);
  await checkBackupFiles(reader, info);
  checkAddonDefinitions(reader, info);
  await checkOrphanedObjects(reader, info);

  const checksRun = 18;

  return {
    valid: errors.length === 0,
    complete: unscannedFiles.length === 0,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      info: info.length,
      checksRun,
      entitiesScanned,
      unscanned: unscannedFiles.length,
    },
    errors,
    warnings,
    info,
    unscannedFiles,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function flattenContainer(container: { items: string[]; subfolders: Array<{ items: string[]; subfolders: unknown[]; name: string }> }): string[] {
  const result = [...container.items];
  const walk = (subfolders: Array<{ items: string[]; subfolders: unknown[]; name: string }>) => {
    for (const sf of subfolders) {
      result.push(...sf.items);
      if (Array.isArray(sf.subfolders)) {
        walk(sf.subfolders as Array<{ items: string[]; subfolders: unknown[]; name: string }>);
      }
    }
  };
  walk(container.subfolders);
  return result;
}

// ─── Check 1: File Existence ─────────────────────────────────

function checkFileExistence(
  registered: string[],
  loaded: Map<string, unknown>,
  category: 'objectTypes' | 'eventSheets' | 'layouts',
  reader: Construct3ProjectReader,
  errors: IntegrityIssue[],
  warnings: IntegrityIssue[],
  unscannedFiles: string[]
): void {
  const readFailures = reader.getReadFailures(category);
  for (const name of registered) {
    if (loaded.has(name)) continue;
    const failure = readFailures.get(name);
    if (failure?.code === 'E_FILE_TOO_LARGE') {
      // The file exists but exceeds the reader's size cap — it was NOT
      // scanned, so every check below is blind to its contents. Report it
      // honestly instead of claiming the file is missing or invalid.
      unscannedFiles.push(`${category}/${name}`);
      warnings.push({
        check: 'unscanned-file',
        entity: `${category}/${name}`,
        message: `UNSCANNED: ${failure.message} — integrity checks (duplicate UIDs/SIDs, references) did not cover this file`,
        suggestion: `Validate this file separately; results for this project are partial`,
      });
    } else if (failure?.code === 'E_FILE_NOT_FOUND') {
      // Registered but absent on disk. Say so plainly, with the path the
      // reader actually looked at (subfolder included), rather than echoing
      // the raw stat message, which carries the absolute project path.
      const relPath = reader.getEntityRelativePath(category, name);
      errors.push({
        check: 'file-existence',
        entity: `${category}/${name}`,
        message: `Registered in c3proj but no file exists at ${relPath}`,
        suggestion: `Create ${relPath} or remove "${name}" from project.c3proj`,
      });
    } else if (failure) {
      errors.push({
        check: 'file-existence',
        entity: `${category}/${name}`,
        message: `Registered in c3proj but could not be read: ${redactFsPaths(failure.message)}`,
        suggestion: `Check that ${reader.getEntityRelativePath(category, name)} exists and is valid JSON`,
      });
    } else {
      errors.push({
        check: 'file-existence',
        entity: `${category}/${name}`,
        message: `Registered in c3proj but file is missing or contains invalid JSON`,
        suggestion: `Check that ${category}/${name}.json exists and is valid JSON`,
      });
    }
  }
}

// ─── Check 2: Required Fields ────────────────────────────────

function checkRequiredFieldsObjects(
  objects: Map<string, ObjectType>,
  errors: IntegrityIssue[]
): void {
  for (const [name, obj] of objects) {
    if (!obj.name) {
      errors.push({
        check: 'required-fields',
        entity: `objectTypes/${name}`,
        message: 'Missing required field: name',
      });
    }
    if (!obj['plugin-id']) {
      errors.push({
        check: 'required-fields',
        entity: `objectTypes/${name}`,
        message: 'Missing required field: plugin-id',
      });
    }
    if (obj.sid == null) {
      errors.push({
        check: 'required-fields',
        entity: `objectTypes/${name}`,
        message: 'Missing required field: sid',
      });
    }
  }
}

function checkRequiredFieldsSheets(
  sheets: Map<string, EventSheet>,
  errors: IntegrityIssue[]
): void {
  for (const [name, sheet] of sheets) {
    if (!sheet.name) {
      errors.push({
        check: 'required-fields',
        entity: `eventSheets/${name}`,
        message: 'Missing required field: name',
      });
    }
    if (!Array.isArray(sheet.events)) {
      errors.push({
        check: 'required-fields',
        entity: `eventSheets/${name}`,
        message: 'Missing required field: events (must be an array)',
      });
    }
  }
}

function checkRequiredFieldsLayouts(
  layouts: Map<string, Layout>,
  errors: IntegrityIssue[]
): void {
  for (const [name, layout] of layouts) {
    if (!layout.name) {
      errors.push({
        check: 'required-fields',
        entity: `layouts/${name}`,
        message: 'Missing required field: name',
      });
    }
    if (!Array.isArray(layout.layers)) {
      errors.push({
        check: 'required-fields',
        entity: `layouts/${name}`,
        message: 'Missing required field: layers (must be an array)',
      });
    }
    if (layout.sid == null) {
      errors.push({
        check: 'required-fields',
        entity: `layouts/${name}`,
        message: 'Missing required field: sid',
      });
    }
  }
}

// ─── Check 3: Name Consistency ───────────────────────────────

function checkNameConsistency(
  objects: Map<string, ObjectType>,
  sheets: Map<string, EventSheet>,
  layouts: Map<string, Layout>,
  errors: IntegrityIssue[]
): void {
  for (const [regName, obj] of objects) {
    if (obj.name && obj.name !== regName) {
      errors.push({
        check: 'name-consistency',
        entity: `objectTypes/${regName}`,
        message: `Internal name "${obj.name}" does not match registered name "${regName}"`,
        suggestion: `Rename the internal "name" field to "${regName}" or update the c3proj registration`,
      });
    }
  }
  for (const [regName, sheet] of sheets) {
    if (sheet.name && sheet.name !== regName) {
      errors.push({
        check: 'name-consistency',
        entity: `eventSheets/${regName}`,
        message: `Internal name "${sheet.name}" does not match registered name "${regName}"`,
      });
    }
  }
  for (const [regName, layout] of layouts) {
    if (layout.name && layout.name !== regName) {
      errors.push({
        check: 'name-consistency',
        entity: `layouts/${regName}`,
        message: `Internal name "${layout.name}" does not match registered name "${regName}"`,
      });
    }
  }
}

// ─── Check 3b: Subfolder Structure ───────────────────────────

function checkSubfolderStructure(
  project: Construct3Project,
  errors: IntegrityIssue[]
): void {
  const containers: Array<{ name: string; container: { items: unknown[]; subfolders: unknown[] } }> = [
    { name: 'objectTypes', container: project.objectTypes },
    { name: 'eventSheets', container: project.eventSheets },
    { name: 'layouts', container: project.layouts },
    { name: 'families', container: project.families },
    { name: 'timelines', container: project.timelines },
  ];

  for (const { name, container } of containers) {
    if (!container || !Array.isArray(container.subfolders)) continue;
    validateSubfolders(container.subfolders as Array<Record<string, unknown>>, name, errors);
  }
}

function validateSubfolders(
  subfolders: Array<Record<string, unknown>>,
  path: string,
  errors: IntegrityIssue[]
): void {
  for (let i = 0; i < subfolders.length; i++) {
    const sf = subfolders[i];
    // Construct r495.2 itself saves an unnamed, empty subfolder (seen as
    // `"timelines": { "items": [], "subfolders": [{ "items": [], "subfolders": [] }] }`
    // in an editor-saved example) and reopens the project without complaint,
    // so only a nameless subfolder that holds something is an error. The one
    // exception is the timelines list's first subfolder: Construct registers
    // custom eases there, unnamed (tasty-cappuccino, r495.2).
    const easeFolder = path === 'timelines' && i === 0;
    if ((typeof sf.name !== 'string' || sf.name === '') && !isEmptySubfolder(sf) && !easeFolder) {
      errors.push({
        check: 'subfolder-structure',
        entity: `${path}/subfolders[${i}]`,
        message: `Subfolder at index ${i} is missing required "name" field`,
        suggestion: 'Add a "name" field to the subfolder object in project.c3proj',
      });
    }
    if (!Array.isArray(sf.items)) {
      errors.push({
        check: 'subfolder-structure',
        entity: `${path}/${sf.name || 'subfolders[' + i + ']'}`,
        message: 'Subfolder is missing required "items" array',
        suggestion: 'Add an "items" array to the subfolder object',
      });
    }
    if (Array.isArray(sf.subfolders)) {
      const childPath = sf.name ? `${path}/${sf.name}` : `${path}/subfolders[${i}]`;
      validateSubfolders(sf.subfolders as Array<Record<string, unknown>>, childPath, errors);
    }
  }
}

/** True when a subfolder and all of its descendants hold no items. */
function isEmptySubfolder(sf: Record<string, unknown>): boolean {
  if (!Array.isArray(sf.items) || sf.items.length > 0) return false;
  if (sf.subfolders === undefined) return true;
  if (!Array.isArray(sf.subfolders)) return false;
  return (sf.subfolders as Array<Record<string, unknown>>).every(child => child && typeof child === 'object' && isEmptySubfolder(child));
}

// ─── Check 4: Duplicate SIDs ─────────────────────────────────

function checkDuplicateSids(
  objects: Map<string, ObjectType>,
  sheets: Map<string, EventSheet>,
  layouts: Map<string, Layout>,
  families: Map<string, Record<string, unknown>>,
  warnings: IntegrityIssue[]
): void {
  const sidMap = new Map<number, string[]>(); // sid → [locations]

  const track = (sid: unknown, location: string) => {
    if (typeof sid !== 'number' || sid <= 0) return;
    const locations = sidMap.get(sid) || [];
    locations.push(location);
    sidMap.set(sid, locations);
  };

  // Objects
  for (const [name, obj] of objects) {
    track(obj.sid, `objectTypes/${name}`);
    // Behavior SIDs
    if (Array.isArray(obj.behaviorTypes)) {
      for (const b of obj.behaviorTypes) {
        track(b.sid, `objectTypes/${name}/behavior:${b.name}`);
      }
    }
    // Instance variable SIDs
    if (Array.isArray(obj.instanceVariables)) {
      for (const v of obj.instanceVariables) {
        track(v.sid, `objectTypes/${name}/var:${v.name}`);
      }
    }
    // Animation SIDs
    if (obj.animations && typeof obj.animations === 'object') {
      scanAnimationSidsForDupes(obj.animations as Record<string, unknown>, `objectTypes/${name}`, track);
    }
    // Singleglobal instance
    const sgi = obj['singleglobal-inst'];
    if (sgi) {
      track(sgi.sid, `objectTypes/${name}/singleglobal-inst`);
    }
  }

  // Event sheets
  for (const [name, sheet] of sheets) {
    track(sheet.sid, `eventSheets/${name}`);
    if (Array.isArray(sheet.events)) {
      scanEventSidsForDupes(sheet.events, `eventSheets/${name}`, track);
    }
  }

  // Layouts: every layer at every depth, since sub-layers hold instances too
  for (const [name, layout] of layouts) {
    track(layout.sid, `layouts/${name}`);
    for (const layer of collectLayers(layout)) {
      track(layer.sid, `layouts/${name}/layer:${layer.name}`);
      if (Array.isArray(layer.instances)) {
        for (const inst of layer.instances) {
          track(inst.sid, `layouts/${name}/layer:${layer.name}/inst:${inst.type}:${inst.uid}`);
        }
      }
    }
  }

  // Families
  for (const [name, family] of families) {
    track((family as Record<string, unknown>).sid, `families/${name}`);
  }

  // Report duplicates
  for (const [sid, locations] of sidMap) {
    if (locations.length > 1) {
      warnings.push({
        check: 'duplicate-sid',
        entity: locations[0],
        message: `SID ${sid} is used ${locations.length} times: ${locations.join(', ')}`,
        suggestion: 'Each entity must have a unique SID. Re-save the project in C3 to regenerate IDs.',
      });
    }
  }
}

function scanAnimationSidsForDupes(
  animations: Record<string, unknown>,
  prefix: string,
  track: (sid: unknown, location: string) => void
): void {
  const items = animations.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items)) {
    for (const anim of items) {
      const animName = anim.name || 'unnamed';
      track(anim.sid, `${prefix}/anim:${animName}`);
      const frames = anim.frames as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(frames)) {
        for (let i = 0; i < frames.length; i++) {
          track(frames[i].sid, `${prefix}/anim:${animName}/frame:${i}`);
        }
      }
    }
  }
  const subfolders = animations.subfolders as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(subfolders)) {
    for (const sub of subfolders) {
      scanAnimationSidsForDupes(sub, prefix, track);
    }
  }
}

function scanEventSidsForDupes(
  events: C3Event[],
  prefix: string,
  track: (sid: unknown, location: string) => void
): void {
  const stack: Array<{ event: C3Event; depth: number }> = [];
  let nodeCount = 0;

  for (let i = events.length - 1; i >= 0; i--) {
    stack.push({ event: events[i], depth: 0 });
  }

  while (stack.length > 0) {
    if (nodeCount++ > MAX_SID_NODES) break;
    const { event, depth } = stack.pop()!;
    if (depth > MAX_SID_DEPTH) continue;

    const rec = event as Record<string, unknown>;
    track(rec.sid, `${prefix}/event`);

    // Conditions & actions
    if ('conditions' in event && Array.isArray(event.conditions)) {
      for (const c of event.conditions) {
        track(c.sid, `${prefix}/condition`);
      }
    }
    if ('actions' in event && Array.isArray(event.actions)) {
      for (const a of event.actions) {
        track((a as Record<string, unknown>).sid, `${prefix}/action`);
      }
    }

    // Function parameters
    if ('functionParameters' in event && Array.isArray(rec.functionParameters)) {
      for (const p of rec.functionParameters as Array<Record<string, unknown>>) {
        track(p.sid, `${prefix}/funcParam`);
      }
    }
    if ('parameters' in event && Array.isArray(rec.parameters)) {
      for (const p of rec.parameters as Array<Record<string, unknown>>) {
        track(p.sid, `${prefix}/param`);
      }
    }

    // Children
    if ('children' in event && Array.isArray(event.children)) {
      for (let i = event.children.length - 1; i >= 0; i--) {
        stack.push({ event: event.children[i], depth: depth + 1 });
      }
    }
  }
}

// ─── Check 5: Duplicate UIDs ─────────────────────────────────

function checkDuplicateUids(
  layouts: Map<string, Layout>,
  objects: Map<string, ObjectType>,
  warnings: IntegrityIssue[]
): void {
  const uidMap = new Map<number, string[]>();

  const track = (uid: unknown, location: string) => {
    if (typeof uid !== 'number') return;
    const locations = uidMap.get(uid) || [];
    locations.push(location);
    uidMap.set(uid, locations);
  };

  for (const [name, layout] of layouts) {
    for (const layer of collectLayers(layout)) {
      if (Array.isArray(layer.instances)) {
        for (const inst of layer.instances) {
          track(inst.uid, `layouts/${name}/layer:${layer.name}/inst:${inst.type}`);
        }
      }
    }
    // Nonworld instances
    const nonworld = (layout as Record<string, unknown>)['nonworld-instances'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(nonworld)) {
      for (const inst of nonworld) {
        track(inst.uid, `layouts/${name}/nonworld:${inst.type}`);
      }
    }
  }

  // Singleglobal instance UIDs
  for (const [name, obj] of objects) {
    const sgi = obj['singleglobal-inst'];
    if (sgi) {
      track(sgi.uid, `objectTypes/${name}/singleglobal-inst`);
    }
  }

  for (const [uid, locations] of uidMap) {
    if (locations.length > 1) {
      warnings.push({
        check: 'duplicate-uid',
        entity: locations[0],
        message: `UID ${uid} is used ${locations.length} times: ${locations.join(', ')}`,
        suggestion: 'Each instance must have a unique UID. Re-save the project in C3 to fix.',
      });
    }
  }
}

// ─── Check 6: Broken Object References ──────────────────────

async function checkBrokenObjectReferences(
  reader: Construct3ProjectReader,
  families: Map<string, Record<string, unknown>>,
  warnings: IntegrityIssue[]
): Promise<void> {
  const index = await getProjectIndex(reader);
  const validNames = new Set<string>([
    ...index.allObjects,
    ...families.keys(),
    'System',
  ]);

  for (const [objName] of index.objectToEventSheets) {
    if (!validNames.has(objName)) {
      warnings.push({
        check: 'broken-object-reference',
        entity: `objectReference/${objName}`,
        message: `Object "${objName}" is referenced in events but does not exist as an object, family, or "System"`,
        suggestion: `Check for typos or deleted objects. Referenced in event sheets.`,
      });
    }
  }
}

// ─── Check 6b: Conditions and Actions Against Construct's Definitions ──

/**
 * Every standard condition and action of a built-in plugin or behavior must be
 * one Construct defines, with the parameter names it defines and, for a combo
 * parameter, one of its choices. ACEs of third-party addons and of objects the
 * project does not declare are skipped.
 */
async function checkEventAceDefinitions(
  reader: Construct3ProjectReader,
  sheets: Map<string, EventSheet>,
  warnings: IntegrityIssue[]
): Promise<void> {
  const context = await buildAceContext(reader);
  for (const [name, sheet] of sheets) {
    for (const problem of checkEventAces(sheet.events, context)) {
      warnings.push({
        check: `ace-${problem.code}`,
        entity: `eventSheets/${name}${problem.sid !== undefined ? `/sid:${problem.sid}` : ''}`,
        message: describeEventAceProblem(problem),
        suggestion: `Compare with the ${problem.kind === 'conditions' ? 'condition' : 'action'} as Construct ${ACE_CATALOG_RELEASE} writes it, or fix it with update_event_block`,
      });
    }
  }
}

// ─── Check: expressions inside parameters ───────────────────

/**
 * Parse every expression-typed parameter and resolve its names against the
 * project and the catalogue: an unknown object, member, function or bare
 * name, a wrong argument count, or text that does not parse.
 */
async function checkEventExpressionText(
  reader: Construct3ProjectReader,
  sheets: Map<string, EventSheet>,
  warnings: IntegrityIssue[]
): Promise<void> {
  const aceContext = await buildAceContext(reader);
  const context = await buildExpressionContext(reader);
  for (const [name, sheet] of sheets) {
    for (const problem of checkEventExpressions(sheet.events, context, aceContext)) {
      warnings.push({
        check: problem.code,
        entity: `eventSheets/${name}${problem.sid !== undefined ? `/sid:${problem.sid}` : ''}`,
        message: describeEventExpressionProblem(problem),
        suggestion: 'Check the name against list_objects, the object\'s instance variables and behaviors, get_function_map and the sheet\'s variables, then fix the parameter with update_event_block or update_event_block_action',
      });
    }
  }
}

// ─── Check 7: Broken Event Sheet References ─────────────────

function checkBrokenEventSheetReferences(
  layouts: Map<string, Layout>,
  sheets: Map<string, EventSheet>,
  warnings: IntegrityIssue[]
): void {
  const sheetNames = new Set(sheets.keys());

  for (const [layoutName, layout] of layouts) {
    const es = (layout as Record<string, unknown>)['eventSheet'] ?? layout['event-sheet'];
    if (typeof es === 'string' && es !== '' && !sheetNames.has(es)) {
      warnings.push({
        check: 'broken-eventsheet-reference',
        entity: `layouts/${layoutName}`,
        message: `Layout references event sheet "${es}" which does not exist`,
        suggestion: `Create the missing event sheet or update the layout's eventSheet field`,
      });
    }
  }
}

// ─── Check 8: Broken Includes ────────────────────────────────

// ─── Check: legacy or misspelt event keys ───────────────────

/** Keys Construct r495 never writes on a block, condition or action, with what it writes instead. */
const LEGACY_EVENT_KEYS: Record<string, string> = {
  'behavior-type': 'behaviorType',
  'object-class': 'objectClass',
  'is-inverted': 'isInverted',
};
const LEGACY_BLOCK_KEYS: Record<string, string> = {
  isElse: 'a leading System "else" condition',
  isOr: 'isOrBlock',
};

/**
 * Warn about keys a hand edit or an older tool wrote in a shape the editor
 * does not read: `behavior-type` instead of `behaviorType` makes Construct
 * report every behavior action as a missing action id (upstream issue 16),
 * and `isElse` / condition-level `isOr` were shapes older builds of this
 * server wrote before the r495 samples were taken.
 */
function checkLegacyEventKeys(eventSheets: Map<string, EventSheet>, warnings: IntegrityIssue[]): void {
  const walk = (events: unknown, sheet: string, depth: number) => {
    if (!Array.isArray(events) || depth > 50) return;
    for (const event of events as Array<Record<string, unknown>>) {
      if (!event || typeof event !== 'object') continue;
      const where = `eventSheets/${sheet}` + (typeof event.sid === 'number' ? ` (event SID ${event.sid})` : '');
      for (const [legacy, correct] of Object.entries(LEGACY_BLOCK_KEYS)) {
        if (legacy in event) {
          warnings.push({
            check: 'event-legacy-key',
            entity: where,
            message: `Event uses "${legacy}", which Construct does not read; it stores this as ${correct}.`,
            suggestion: 'Rewrite the block with update_event_block, which converts the legacy keys, or fix the key by hand.',
          });
        }
      }
      for (const listKey of ['conditions', 'actions'] as const) {
        const aces = event[listKey];
        if (!Array.isArray(aces)) continue;
        for (const ace of aces as Array<Record<string, unknown>>) {
          if (!ace || typeof ace !== 'object') continue;
          for (const [legacy, correct] of Object.entries(LEGACY_EVENT_KEYS)) {
            if (legacy in ace) {
              warnings.push({
                check: 'event-legacy-key',
                entity: where,
                message: `A ${listKey.slice(0, -1)} uses "${legacy}", which Construct does not read; the key is "${correct}". Construct reports such an ACE as a missing action or condition id on load.`,
                suggestion: `Rename the key to "${correct}" (update_event_block rewrites the block with the right keys).`,
              });
            }
          }
          if (listKey === 'conditions' && 'isOr' in ace) {
            warnings.push({
              check: 'event-legacy-key',
              entity: where,
              message: 'A condition carries "isOr"; Construct marks an OR block on the block itself as isOrBlock.',
              suggestion: 'Rewrite the block with update_event_block, which converts condition-level isOr to isOrBlock.',
            });
          }
        }
      }
      walk(event.children, sheet, depth + 1);
    }
  };
  for (const [name, sheet] of eventSheets) walk(sheet.events, name, 0);
}

function checkBrokenIncludes(
  sheets: Map<string, EventSheet>,
  warnings: IntegrityIssue[]
): void {
  const sheetNames = new Set(sheets.keys());

  for (const [sheetName, sheet] of sheets) {
    if (!Array.isArray(sheet.events)) continue;
    walkEventsForIncludes(sheet.events, sheetName, sheetNames, warnings);
  }
}

function walkEventsForIncludes(
  events: C3Event[],
  sheetName: string,
  sheetNames: Set<string>,
  warnings: IntegrityIssue[]
): void {
  const stack = [...events];
  let nodeCount = 0;

  while (stack.length > 0) {
    if (nodeCount++ > MAX_SID_NODES) break;
    const event = stack.pop()!;

    if (event.eventType === 'include') {
      const include = event as { includeSheet: string };
      if (include.includeSheet && !sheetNames.has(include.includeSheet)) {
        warnings.push({
          check: 'broken-include',
          entity: `eventSheets/${sheetName}`,
          message: `Includes event sheet "${include.includeSheet}" which does not exist`,
          suggestion: `Create the missing event sheet or remove the include`,
        });
      }
    }

    if ('children' in event && Array.isArray(event.children)) {
      stack.push(...event.children);
    }
  }
}

// ─── Check 8b: Object Images ─────────────────────────────────

/**
 * An image-bearing object type should have its image record and the PNG on
 * disk. Severity follows the evidence rather than the suspicion:
 *
 * - A single-image object type with no `image` record is an ERROR. r495.2
 *   refuses the whole project ("Failed to open project. Check it is a valid
 *   Construct 3 single-file (.c3p) project.") and names no object, observed on
 *   a package holding one Sprite Font object and isolated against a package
 *   that opens normally.
 * - Everything else here is a WARNING, because it is inferred from the 30
 *   sampled r495.2 projects rather than tested in the editor: all 384
 *   animation object types carry frames and all 505 image-bearing types have
 *   their PNG, but no failing package was built for those shapes.
 *
 * The on-disk half is skipped when the project has no `images` directory,
 * which a partially materialised fixture or an in-memory project has; that
 * absence says nothing about what Construct would do.
 */
async function checkObjectImages(
  objects: Map<string, ObjectType>,
  reader: Construct3ProjectReader,
  errors: IntegrityIssue[],
  warnings: IntegrityIssue[]
): Promise<void> {
  const imagesDir = join(reader.getProjectDir(), 'images');
  // Construct saves every image file name in lowercase, and the r495.2
  // samples hold no other case, so the listing is compared in lowercase. That
  // also keeps the check the same on a case-sensitive filesystem, where a
  // lookup under the animation's own case would miss every mixed-case name.
  let imageFiles: Set<string> | undefined;
  try {
    if ((await lstat(imagesDir)).isDirectory()) {
      imageFiles = new Set((await readdir(imagesDir)).map((f) => f.toLowerCase()));
    }
  } catch {
    imageFiles = undefined;
  }

  // The file name follows the fileType the image record declares, not a fixed
  // .png: C3-ACE stores 30 frames as image/gif in images/<name>.gif. png and
  // gif are the only types in the samples. For any other declared type the
  // extension is not guessed, and any file with the same stem counts.
  const imageFile = (
    objectName: string,
    animationName: string,
    frameIndex: number,
    pluginId: string,
    fileType: unknown,
  ): { name: string; present: () => boolean } => {
    const stem = getImageFileName(objectName, animationName, frameIndex, pluginId)
      .replace(/\.png$/, '')
      .toLowerCase();
    const declared = typeof fileType === 'string' ? fileType : 'image/png';
    const ext = IMAGE_EXTENSIONS[declared];
    if (ext !== undefined) {
      const name = `${stem}.${ext}`;
      return { name, present: () => !imageFiles || imageFiles.has(name) };
    }
    return {
      name: `${stem}.*`,
      present: () => !imageFiles || [...imageFiles].some((f) => f.startsWith(`${stem}.`)),
    };
  };

  for (const [name, obj] of objects) {
    const pluginId = obj['plugin-id'];
    if (!pluginId) continue;

    if (SINGLE_IMAGE_PLUGINS.has(pluginId)) {
      const image = (obj as unknown as Record<string, unknown>).image;
      if (!image || typeof image !== 'object') {
        errors.push({
          check: 'object-image',
          entity: `objectTypes/${name}`,
          message: `A ${pluginId} object type has no "image" record, which stops Construct opening the project`,
          suggestion: `Recreate the object with create_object, or add the image record and its PNG`,
        });
        continue;
      }
      const file = imageFile(name, '', 0, pluginId, (image as Record<string, unknown>).fileType);
      if (!file.present()) {
        warnings.push({
          check: 'object-image',
          entity: `objectTypes/${name}`,
          message: `A ${pluginId} object type declares an image but images/${file.name} is missing, which stops Construct opening the project`,
          suggestion: `Restore the file, or replace the image with replace_object_image`,
        });
      }
      continue;
    }

    if (!ANIMATION_PLUGINS.has(pluginId)) continue;

    const animations = (obj as unknown as Record<string, unknown>).animations as
      | { items?: Array<{ name?: string; frames?: unknown[] }> }
      | undefined;
    const items = animations?.items;
    if (!Array.isArray(items) || items.length === 0) {
      warnings.push({
        check: 'object-image',
        entity: `objectTypes/${name}`,
        message: `A ${pluginId} object type has no animation frames, which stops Construct opening the project`,
        suggestion: `Recreate the object with create_object, or add an animation with at least one frame`,
      });
      continue;
    }
    for (const item of items) {
      const frames = Array.isArray(item.frames) ? item.frames : [];
      if (frames.length === 0) {
        warnings.push({
          check: 'object-image',
          entity: `objectTypes/${name}/animation:${item.name ?? ''}`,
          message: `Animation "${item.name ?? ''}" has no frames, which stops Construct opening the project`,
          suggestion: `Add a frame with add_frame_to_animation, or delete the animation`,
        });
        continue;
      }
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const fileType = frame && typeof frame === 'object' ? (frame as Record<string, unknown>).fileType : undefined;
        const file = imageFile(name, item.name ?? '', i, pluginId, fileType);
        if (!file.present()) {
          warnings.push({
            check: 'object-image',
            entity: `objectTypes/${name}/animation:${item.name ?? ''}`,
            message: `Frame ${i} declares images/${file.name}, which is missing, and Construct will not open the project`,
            suggestion: `Restore the file, or replace the frame image with replace_sprite_image`,
          });
        }
      }
    }
  }
}

// ─── Check 9: Missing Addons ─────────────────────────────────

// ─── Check: addons whose ACEs cannot be checked ──────────────

/**
 * Name every used plugin or behavior that is neither a built-in of the
 * catalogue's release nor loaded from its own definitions, because its
 * conditions and actions are silently skipped by the ACE checks until then.
 */
function checkAddonDefinitions(reader: Construct3ProjectReader, info: IntegrityIssue[]): void {
  for (const addon of reader.getUsedAddons()) {
    if (addon.type !== 'plugin' && addon.type !== 'behavior') continue;
    if (isBuiltInAddon(addon.type, addon.id) || addonDefinition(addon.type, addon.id)) continue;
    const version = typeof (addon as { version?: unknown }).version === 'string' ? ` ${(addon as { version: string }).version}` : '';
    info.push({
      check: 'ace-definitions-unavailable',
      entity: `usedAddons/${addon.id}`,
      message: `The ${addon.type} "${addon.id}" (${addon.name}${version}) is not a built-in of Construct ${ACE_CATALOG_RELEASE} and its definitions are not loaded, so its conditions and actions are not checked.`,
      suggestion: 'Point C3_ADDON_DEFINITIONS at its .c3addon file or unpacked folder before starting the server, or call load_addon_definitions with that path.',
    });
  }
}

function checkMissingAddons(
  objects: Map<string, ObjectType>,
  reader: Construct3ProjectReader,
  warnings: IntegrityIssue[]
): void {
  const addons = reader.getUsedAddons();
  const addonIds = new Set<string>();
  for (const addon of addons) {
    addonIds.add(addon.id);
  }

  for (const [name, obj] of objects) {
    if (obj['plugin-id'] && !addonIds.has(obj['plugin-id'])) {
      warnings.push({
        check: 'missing-addon',
        entity: `objectTypes/${name}`,
        message: `Plugin "${obj['plugin-id']}" is not listed in usedAddons`,
        suggestion: `Add the plugin to the project's usedAddons list`,
      });
    }
    if (Array.isArray(obj.behaviorTypes)) {
      for (const b of obj.behaviorTypes) {
        if (b.behaviorId && !addonIds.has(b.behaviorId)) {
          warnings.push({
            check: 'missing-addon',
            entity: `objectTypes/${name}/behavior:${b.name}`,
            message: `Behavior "${b.behaviorId}" is not listed in usedAddons`,
            suggestion: `Add the behavior to the project's usedAddons list`,
          });
        }
      }
    }
  }
}

// ─── Check 10: Orphaned Files ────────────────────────────────

async function checkOrphanedFiles(
  reader: Construct3ProjectReader,
  registeredObjects: string[],
  registeredSheets: string[],
  registeredLayouts: string[],
  info: IntegrityIssue[]
): Promise<void> {
  const registrations = {
    objectTypes: registeredObjects,
    eventSheets: registeredSheets,
    layouts: registeredLayouts,
    families: flattenContainer(reader.getProject().families),
  };
  for (const category of ['objectTypes', 'eventSheets', 'layouts', 'families'] as const) {
    const registeredPaths = new Set(
      registrations[category].map(name => reader.getEntityRelativePath(category, name))
    );
    await scanDirForOrphans(reader.getProjectDir(), category, registeredPaths, info);
  }
}

// Construct writes per-user editor UI state beside project files: `<name>.uistate.json`
// files, and (r487+) `layouts/uistate/**/<name>.instancesBar.json`. They are never
// registered in project.c3proj and do not affect the project.
function isEditorUiStateFile(relativeDir: string, fileName: string): boolean {
  if (fileName.endsWith('.uistate.json')) return true;
  return fileName.endsWith('.instancesBar.json')
    && (relativeDir === 'layouts/uistate' || relativeDir.startsWith('layouts/uistate/'));
}

async function scanDirForOrphans(
  projectDir: string,
  relativeDir: string,
  registeredPaths: Set<string>,
  info: IntegrityIssue[]
): Promise<void> {
  try {
    const directory = join(projectDir, relativeDir);
    if (!(await lstat(directory)).isDirectory()) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await scanDirForOrphans(projectDir, relativePath, registeredPaths, info);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.json')
        && !isEditorUiStateFile(relativeDir, entry.name)
        && !registeredPaths.has(relativePath)
      ) {
        info.push({
          check: 'orphaned-file',
          entity: relativePath,
          message: `File exists on disk but is not registered in c3proj`,
          suggestion: `Delete the file or register it in the project`,
        });
      }
      // Do not follow symbolic links outside the project or into cycles.
    }
  } catch {
    // Preserve the existing best-effort treatment of absent/unreadable directories.
  }
}

// ─── Check 11: Backup Files ─────────────────────────────────

async function checkBackupFiles(
  reader: Construct3ProjectReader,
  info: IntegrityIssue[]
): Promise<void> {
  const projectDir = reader.getProjectDir();
  const dirs = ['objectTypes', 'eventSheets', 'layouts', 'families'];

  for (const dirName of dirs) {
    try {
      const dirPath = join(projectDir, dirName);
      await scanDirForBackups(dirPath, dirName, info);
    } catch {
      // Skip missing directories
    }
  }
}

async function scanDirForBackups(
  dirPath: string,
  prefix: string,
  info: IntegrityIssue[]
): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.bak')) {
        info.push({
          check: 'backup-file',
          entity: `${prefix}/${entry.name}`,
          message: `Backup file found — may be left over from a failed write operation`,
          suggestion: `Review and delete if no longer needed`,
        });
      }
      if (entry.isDirectory()) {
        await scanDirForBackups(join(dirPath, entry.name), `${prefix}/${entry.name}`, info);
      }
    }
  } catch {
    // Skip unreadable
  }
}

// ─── Check 12: Orphaned Objects ──────────────────────────────

async function checkOrphanedObjects(
  reader: Construct3ProjectReader,
  info: IntegrityIssue[]
): Promise<void> {
  const result = await findOrphanedObjects(reader);
  for (const orphan of result.orphanedObjects) {
    info.push({
      check: 'orphaned-object',
      entity: `objectTypes/${orphan.name}`,
      message: `Object "${orphan.name}" (${orphan.pluginId}) is not referenced in any event sheet or placed in any layout`,
      suggestion: `Remove the object if unused, or add it to a layout/event sheet`,
    });
  }
}
