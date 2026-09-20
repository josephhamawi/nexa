import { describe, expect, it, vi } from 'vitest';
import { McpTool, qualifiedName, schemaFor } from '../src/mcp/McpTool';
import { contentToText, type McpClient, type McpToolDefinition } from '../src/mcp/McpClient';
import { Permission, createTask, makeStep, TaskType } from '../src/tasks/Task';

function fakeClient(result: { content: { type: string; text?: string }[]; isError?: boolean }) {
  return {
    id: 'files',
    connected: true,
    listTools: () => [],
    call: vi.fn(async () => ({ content: result.content, isError: Boolean(result.isError) })),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as McpClient;
}

function context() {
  const task = createTask({ name: 't', naturalLanguageRequest: 'r', type: TaskType.RESEARCH });
  const step = makeStep('x', 'step');
  return { task, step, report: vi.fn(), addEvidence: vi.fn((i) => ({ id: 'e', taskId: 't', stepId: 's', at: '', ...i })) };
}

describe('tool naming', () => {
  it('namespaces by server so two servers cannot collide', () => {
    expect(qualifiedName('files', 'read')).toBe('mcp_files_read');
    expect(qualifiedName('git', 'read')).toBe('mcp_git_read');
    expect(qualifiedName('My Server', 'do-thing')).toBe('mcp_my_server_do_thing');
  });
});

describe('schema conversion', () => {
  it('maps a JSON Schema onto validation with required fields', () => {
    const schema = schemaFor({
      name: 'read_file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'number' } },
        required: ['path'],
      },
    });

    expect(schema.parse({ path: '/tmp/a.txt' })).toMatchObject({ path: '/tmp/a.txt' });
    expect(() => schema.parse({ limit: 3 })).toThrow();
    expect(() => schema.parse({ path: 42 })).toThrow();
  });

  it('passes through fields a server did not declare', () => {
    const schema = schemaFor({
      name: 'x',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: [] },
    });
    expect(schema.parse({ a: 'v', undeclared: true })).toMatchObject({ a: 'v', undeclared: true });
  });

  it('accepts anything when a server gives no schema', () => {
    expect(schemaFor({ name: 'x' }).parse({ whatever: 1 })).toMatchObject({ whatever: 1 });
  });
});

describe('permission and approval inheritance', () => {
  const definition: McpToolDefinition = { name: 'write_file', description: 'writes a file' };

  it('runs under the grant its server was configured with, not a wider one', () => {
    const tool = new McpTool(fakeClient({ content: [] }), definition, [Permission.FILES]);
    expect(tool.permissions).toEqual([Permission.FILES]);
    expect(tool.permissions).not.toContain(Permission.BROWSER);
  });

  it('assumes a tool writes unless the server says otherwise', () => {
    const writes = new McpTool(fakeClient({ content: [] }), definition, [Permission.FILES]);
    expect(writes.mutating).toBe(true);

    const reads = new McpTool(
      fakeClient({ content: [] }),
      { name: 'read_file', annotations: { readOnlyHint: true } },
      [Permission.FILES],
    );
    expect(reads.mutating).toBe(false);
  });
});

describe('calling a tool', () => {
  it('returns the text a server produced', async () => {
    const client = fakeClient({ content: [{ type: 'text', text: 'file one\nfile two' }] });
    const tool = new McpTool(client, { name: 'list_dir' }, [Permission.FILES]);

    const result = await tool.execute({ path: '/tmp' }, context() as never);
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toContain('file two');
    expect((result.data as { items: unknown[] }).items).toHaveLength(2);
    expect(client.call).toHaveBeenCalledWith('list_dir', { path: '/tmp' });
  });

  it('reports a server-side error as a failed step, not a success', async () => {
    const tool = new McpTool(
      fakeClient({ content: [{ type: 'text', text: 'permission denied' }], isError: true }),
      { name: 'read_file' },
      [Permission.FILES],
    );
    const result = await tool.execute({ path: '/etc/shadow' }, context() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('permission denied');
  });

  it('survives a transport failure', async () => {
    const client = {
      id: 'files',
      connected: true,
      call: vi.fn(async () => {
        throw new Error('server exited');
      }),
    } as unknown as McpClient;

    const tool = new McpTool(client, { name: 'read_file' }, [Permission.FILES]);
    const result = await tool.execute({ path: '/tmp/a' }, context() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('server exited');
  });
});

describe('content flattening', () => {
  it('joins text blocks and labels the rest', () => {
    expect(
      contentToText([
        { type: 'text', text: 'line one' },
        { type: 'image' },
        { type: 'text', text: 'line two' },
      ]),
    ).toBe('line one\n[image]\nline two');
  });
});
