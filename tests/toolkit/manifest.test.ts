import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Prompt,
  Skill,
  SubAgent,
  Tool,
  buildCapabilityManifest,
  createApp,
  type AgentTool,
} from '../../src/index.js';

const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;

class Capabilities {
  @Tool({
    description: '读订单',
    schema: EMPTY,
    metadata: { owner: 'orders', version: 'v2', risk: 'read', sideEffect: 'none' },
  })
  order() {
    return 'order';
  }

  @Skill({
    description: '写报告',
    schema: EMPTY,
    metadata: { owner: 'reports', risk: 'write', sideEffect: 'idempotent' },
  })
  report() {
    return 'report';
  }

  @SubAgent({
    description: '自主调研',
    schema: EMPTY,
    system: 'research',
    metadata: { owner: 'research', risk: 'external', sideEffect: 'non-idempotent' },
  })
  researcher() {}

  @Prompt({ description: '规范', version: 'v3', metadata: { owner: 'docs' } })
  static style() {
    return 'style';
  }
}

function app(): ReturnType<typeof createApp> {
  return createApp({
    name: 'manifest-app',
    system: 'sys',
    providers: [{ provide: 'caps', useClass: Capabilities }],
    tools: [
      {
        name: 'bare',
        description: '裸工具',
        inputSchema: EMPTY,
        run: () => 'ok',
      },
    ],
  });
}

describe('能力契约 manifest', () => {
  it('从最终菜单收齐四类 + 裸工具，保留 owner/version/risk/sideEffect 与审批形状', () => {
    const manifest = app().getCapabilityManifest();
    assert.equal(manifest.app, 'manifest-app');
    assert.deepEqual(
      manifest.capabilities.map((c) => `${c.kind}:${c.name}`),
      ['tool:bare', 'tool:order', 'skill:report', 'subagent:researcher', 'prompt:style'],
    );
    const order = manifest.capabilities.find((c) => c.name === 'order')!;
    assert.deepEqual(order, {
      name: 'order',
      kind: 'tool',
      description: '读订单',
      inputSchema: EMPTY,
      strict: false,
      approvalRequired: false,
      owner: 'orders',
      version: 'v2',
      risk: 'read',
      sideEffect: 'none',
    });
    const prompt = manifest.capabilities.find((c) => c.name === 'style')!;
    assert.equal(prompt.version, 'v3', 'Prompt 的旧 version 字段进入同一份契约');
    assert.equal(prompt.owner, 'docs');
    assert.equal(manifest.capabilities.find((c) => c.name === 'report')?.risk, 'write');
    assert.equal(
      manifest.capabilities.find((c) => c.name === 'researcher')?.sideEffect,
      'non-idempotent',
    );
  });

  it('hash 与输入顺序无关；description/schema/审批/元数据变化都改变契约', () => {
    const base: AgentTool = {
      name: 'x',
      description: 'x',
      inputSchema: EMPTY,
      capability: 'tool',
      metadata: { owner: 'a', version: '1', risk: 'read', sideEffect: 'none' },
      run: () => 'x',
    };
    const other: AgentTool = { ...base, name: 'y', description: 'y' };
    const first = buildCapabilityManifest('a', [base, other]);
    assert.equal(first.hash, buildCapabilityManifest('a', [other, base]).hash);
    for (const changed of [
      { ...base, description: 'changed' },
      { ...base, inputSchema: { ...EMPTY, required: ['x'] } },
      { ...base, approval: 'required' as const },
      { ...base, metadata: { ...base.metadata, risk: 'write' as const } },
    ]) {
      assert.notEqual(
        buildCapabilityManifest('a', [base, other]).hash,
        buildCapabilityManifest('a', [changed, other]).hash,
      );
    }
    assert.equal(
      buildCapabilityManifest('a', [base]).hash,
      buildCapabilityManifest('a', [base]).hash,
    );
  });
});
