/**
 * Runs before every test file: the suite does not inherit the size limit
 * setting from the shell that runs it, so a developer who set
 * C3MCP_MAX_FILE_MB for their own server gets the same results. Tests that
 * need it set it with vi.stubEnv.
 */
delete process.env.C3MCP_MAX_FILE_MB;
