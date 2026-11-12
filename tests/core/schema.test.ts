import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema } from '../../src/index.js';
import type { JsonSchema } from '../../src/index.js';

const person: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    addr: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  required: ['name'],
  additionalProperties: false,
};

describe('validateJsonSchema（运行时输入校验）', () => {
  it('合法输入返回 null', () => {
    assert.equal(validateJsonSchema(person, { name: 'a' }), null);
    assert.equal(
      validateJsonSchema(person, { name: 'a', age: 3, tags: ['x'], addr: { city: 'sh' } }),
      null,
    );
  });

  it('缺必需属性 / 类型不符 / 未声明属性', () => {
    assert.match(validateJsonSchema(person, {})!, /缺少必需属性 "name"/);
    assert.match(validateJsonSchema(person, { name: 1 })!, /\$\.name: 期望 string/);
    assert.match(validateJsonSchema(person, { name: 'a', x: 1 })!, /未声明的属性 "x"/);
    assert.match(validateJsonSchema(person, { name: 'a', age: 1.5 })!, /\$\.age: 期望 integer/);
  });

  it('原型链键不算数：required 的 constructor 不被放行、additionalProperties:false 拦住 toString', () => {
    // `key in obj` 会命中 Object.prototype —— required:['constructor'] 对 {} 恒通过、
    // additionalProperties:false 时自有 toString 键被当成「已声明」放行；必须用 hasOwn。
    const s: JsonSchema = { type: 'object', properties: {}, required: ['constructor'] };
    assert.match(
      validateJsonSchema(s, {})!,
      /缺少必需属性 "constructor"/,
      '原型链上的 constructor 不算「提供了该属性」',
    );
    assert.match(
      validateJsonSchema(person, { name: 'a', toString: 1 })!,
      /未声明的属性 "toString"/,
      '自有 toString 键不得借原型链混入 properties 被放行',
    );
    // 正向：自有的合法属性不受影响
    assert.equal(validateJsonSchema(person, { name: 'a' }), null);
  });

  it('嵌套对象与数组元素给出路径', () => {
    assert.match(
      validateJsonSchema(person, { name: 'a', addr: {} })!,
      /\$\.addr: 缺少必需属性 "city"/,
    );
    assert.match(
      validateJsonSchema(person, { name: 'a', tags: ['x', 1] })!,
      /\$\.tags\[1\]: 期望 string/,
    );
  });

  it('enum 校验（含对象深比较）', () => {
    const s: JsonSchema = { type: 'object', enum: [{ a: 1 }, { b: [2] }] };
    assert.equal(validateJsonSchema(s, { b: [2] }), null);
    assert.match(validateJsonSchema(s, { a: 2 })!, /enum/);
  });

  it('未覆盖的关键字放行（护栏不是完整校验器）', () => {
    assert.equal(validateJsonSchema({ type: 'string', minLength: 100 } as never, 'x'), null);
    assert.equal(validateJsonSchema({ type: 'unknown-type' } as never, 1), null);
  });

  it('null / boolean / number 类型', () => {
    assert.equal(validateJsonSchema({ type: 'null' }, null), null);
    assert.match(validateJsonSchema({ type: 'null' }, 0)!, /期望 null/);
    assert.match(validateJsonSchema({ type: 'boolean' }, 0)!, /期望 boolean/);
    assert.match(validateJsonSchema({ type: 'number' }, Number.NaN)!, /期望 number/);
  });
});

describe('validateJsonSchema 的 maxItems（2026-11-13 ref-checklist-four）', () => {
  it('超长数组回带路径与长度的错误，模型能据此自我修正', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 2 } },
    };
    assert.equal(validateJsonSchema(s, { tags: ['a', 'b'] }), null);
    assert.match(
      validateJsonSchema(s, { tags: ['a', 'b', 'c'] })!,
      /\$\.tags: 数组长度 3 超过 maxItems 2/,
    );
    // 长度闸在逐项校验之前：模型要修的是「少给几项」，不是第 3 项的类型
    assert.match(validateJsonSchema(s, { tags: ['a', 'b', 7] })!, /数组长度 3 超过 maxItems 2/);
  });

  it('0 = 只许空数组（不是「不限」）', () => {
    const s: JsonSchema = { type: 'array', maxItems: 0 };
    assert.equal(validateJsonSchema(s, []), null);
    assert.match(validateJsonSchema(s, ['x'])!, /超过 maxItems 0/);
  });

  it('坏值一律抛 TypeError，不静默放行（NaN 会让 length > 上限 恒假）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '2', null]) {
      assert.throws(
        () => validateJsonSchema({ type: 'array', maxItems: bad } as never, ['x']),
        (e: unknown) =>
          e instanceof TypeError &&
          /非负安全整数/.test((e as Error).message) &&
          /0 = 一条都不许有/.test((e as Error).message),
        `maxItems=${String(bad)} 必须响亮失败且文案与 limits 表同源`,
      );
    }
  });

  it('这次的值不是数组，坏 maxItems 也照样被拒（不藏在分支后面）', () => {
    assert.throws(
      () => validateJsonSchema({ type: 'array', maxItems: Number.NaN }, 'not-an-array'),
      /非负安全整数/,
      'schema 是静态配置，坏值不该取决于本轮输入走到了哪条分支',
    );
  });

  it('合法的 maxItems 写在非数组 schema 上不生效（按规范只对数组生效）', () => {
    assert.equal(validateJsonSchema({ type: 'string', maxItems: 0 }, 'anything'), null);
  });

  it('嵌套 items 上的 maxItems 同样生效', () => {
    const s: JsonSchema = {
      type: 'array',
      items: { type: 'array', items: { type: 'number' }, maxItems: 1 },
    };
    assert.equal(validateJsonSchema(s, [[1], []]), null);
    assert.match(validateJsonSchema(s, [[1, 2]])!, /\$\[0\]: 数组长度 2 超过 maxItems 1/);
  });
});
