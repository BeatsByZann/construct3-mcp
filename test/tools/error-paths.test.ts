import { describe, it, expect, vi, afterEach } from 'vitest';
import { redactFsPaths } from '../../src/error-messages.js';
import { toolError } from '../../src/tools/shared.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { MockServer } from '../mocks/mock-server.js';

afterEach(() => vi.restoreAllMocks());
describe('client error path redaction', () => {
  it.each([
    "ENOENT: no such file, open '/home/private/My Project/secret.json'",
    "EPERM: not permitted, unlink 'C:\\Users\\Private User\\secret.json'",
    "EACCES: denied, copyfile '\\\\server\\private\\source' -> 'D:\\target\\secret'",
    "Cannot access backup: EACCES: denied, open '/home/user\'s private/secret.json'",
    'Cannot copy /home/private/My Project/secret.json',
    'Cannot copy C:\\Users\\Private User\\secret.json',
    'ENOENT: open "C:\\Users\\Private User\\secret.json"',
  ])('removes filesystem locations from %s', message => {
    const result = toolError(message);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/private|secret|Users|server|target/i);
  });
  it('preserves ordinary diagnostics and project-relative recovery paths', () => {
    const message = 'Cannot delete layouts/Outer/Inner/Nested.json: EACCES: permission denied';
    expect(redactFsPaths(message)).toBe(message);
  });
  it('redacts both read and analysis handler errors', async () => {
    const error = new Error("EACCES: permission denied, open '/home/private/project.c3proj'");
    const reader = { listObjectTypes: vi.fn().mockRejectedValue(error), getProject: () => { throw error; } };
    const server = new MockServer();
    registerQueryTools(server as any, reader as any);
    registerAnalysisTools(server as any, reader as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const name of ['list_objects', 'validate_project']) {
      const result = await server.callTool(name);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('EACCES');
      expect(result.content[0].text).not.toContain('/home/private');
    }
  });
});
