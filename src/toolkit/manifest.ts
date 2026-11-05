import { createHash } from 'node:crypto';
import type { CapabilityType } from '../core/trace.js';
import type { AgentTool, CapabilityMetadata, JsonSchema } from '../core/tool.js';

export interface CapabilityManifestEntry {
  name: string;
  kind: CapabilityType;
  description: string;
  inputSchema: JsonSchema;
  strict: boolean;
  approvalRequired: boolean;
  owner?: string;
  version?: string;
  risk?: CapabilityMetadata['risk'];
  sideEffect?: CapabilityMetadata['sideEffect'];
}

export interface CapabilityManifest {
  app: string;
  hash: string;
  capabilities: CapabilityManifestEntry[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** 从最终菜单生成团队契约；顺序不影响 hash，函数实现与隐藏校验器不进入产物。 */
export function buildCapabilityManifest(
  app: string,
  tools: readonly AgentTool[],
): CapabilityManifest {
  const capabilities = tools
    .map((tool): CapabilityManifestEntry => {
      const metadata = tool.metadata;
      return {
        name: tool.name,
        kind: tool.capability ?? 'tool',
        description: tool.description,
        inputSchema: tool.inputSchema,
        strict: tool.strict === true,
        approvalRequired: tool.approval === 'required',
        ...(metadata?.owner !== undefined ? { owner: metadata.owner } : {}),
        ...(metadata?.version !== undefined ? { version: metadata.version } : {}),
        ...(metadata?.risk !== undefined ? { risk: metadata.risk } : {}),
        ...(metadata?.sideEffect !== undefined ? { sideEffect: metadata.sideEffect } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  const material = canonical({ app, capabilities });
  return {
    app,
    hash: createHash('sha256').update(material).digest('hex').slice(0, 16),
    capabilities,
  };
}
