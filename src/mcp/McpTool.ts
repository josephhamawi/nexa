import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from '../tools/Tool';
import { contentToText, type McpClient, type McpToolDefinition } from './McpClient';

/**
 * Presents one MCP server tool as a Nexa tool.
 *
 * The important part is what does NOT change: an MCP tool goes through the same
 * permission check and the same approval gate as a built-in one. Borrowing a
 * capability never widens what a task is allowed to do.
 */
export class McpTool implements Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly permissions: Permission[];
  readonly mutating: boolean;

  constructor(
    private readonly client: McpClient,
    private readonly definition: McpToolDefinition,
    grantedPermissions: Permission[],
  ) {
    this.name = qualifiedName(client.id, definition.name);
    this.description = `[${client.id}] ${definition.description ?? definition.name}`;
    this.inputSchema = schemaFor(definition);
    this.permissions = grantedPermissions;
    // Assume a tool writes unless the server explicitly says it only reads.
    // Guessing "read-only" would quietly skip the approval prompt.
    this.mutating = definition.annotations?.readOnlyHint !== true;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    context.report(`${this.client.id}: ${this.definition.name}`);

    try {
      const result = await this.client.call(this.definition.name, input);
      const text = contentToText(result.content);

      if (result.isError) {
        return {
          ok: false,
          summary: `${this.definition.name} reported an error`,
          error: text.slice(0, 500) || 'the server returned an error with no message',
        };
      }

      context.addEvidence({
        kind: 'data',
        title: `${this.client.id}: ${this.definition.name}`,
        summary: text.slice(0, 200).replace(/\s+/g, ' '),
      });

      return {
        ok: true,
        summary: `${this.definition.name} returned ${text.length} characters`,
        data: { text, items: asItems(text) },
      };
    } catch (err) {
      return {
        ok: false,
        summary: `${this.client.id} could not run ${this.definition.name}`,
        error: (err as Error).message,
      };
    }
  }
}

/** Namespaced so two servers exposing "search" cannot collide. */
export function qualifiedName(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Converts an MCP JSON Schema into a Zod schema good enough to validate and
 * default step input. Only the shapes servers actually use are handled; the
 * rest passes through, because rejecting a valid call on a schema technicality
 * is worse than letting the server validate it.
 */
export function schemaFor(definition: McpToolDefinition): z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown> {
  const raw = definition.inputSchema;
  if (!raw || typeof raw !== 'object' || raw.type !== 'object') {
    return z.record(z.unknown());
  }

  const properties = (raw.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set((raw.required as string[]) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, property] of Object.entries(properties)) {
    let field: z.ZodTypeAny;
    switch (property?.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
      case 'integer':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.unknown());
        break;
      default:
        field = z.unknown();
    }
    shape[key] = required.has(key) ? field : field.optional();
  }

  // passthrough: servers accept fields their schema does not always declare.
  return z.object(shape).passthrough() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
}

/** Many servers return a list as lines; give the analysis step something to rank. */
function asItems(text: string): { title: string; summary: string; score: number }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 3)
    .slice(0, 50)
    .map((line) => ({ title: line.slice(0, 120), summary: line, score: 50 }));
}
