/** doctor 命令：静态体检装配健康度（只读文件系统 + src/registry.ts 文本，不 import 用户代码） */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_DIRS, CAPABILITY_DIR_LIST, REGISTRY_PATH, isValidName } from './templates.js';
import { legacyLayout, legacyMigrationHint } from './layout.js';
import { GUIDE_VERSION_RE, readCliVersion } from './version.js';

/** 能力入口候选（须与框架 src/toolkit/discover.ts 的 ENTRY_CANDIDATES 一致） */
const ENTRY_CANDIDATES = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];

interface RegistryEntry {
  token: string;
  ident: string;
}

/**
 * 解析 import 绑定子句，产出本文件内可见的标识符。
 * 覆盖 default / named（含 `as` 别名与 `type` 修饰）/ namespace / 混合形态；
 * 注册表由 codemod 与人工共同维护，named import 等形态此前被静默跳过（悬空条目漏检）。
 */
function boundIdents(clause: string): string[] {
  const idents: string[] = [];
  const brace = clause.match(/\{([\s\S]*)\}/);
  const head = brace ? clause.replace(brace[0], '') : clause;
  // 括号外部分：default 标识符和/或 `* as Ns`
  for (const part of head.split(',')) {
    const p = part.trim().replace(/^type\s+/, '');
    if (!p) continue;
    const ns = p.match(/^\*\s+as\s+(\w+)$/);
    if (ns) idents.push(ns[1]);
    else if (/^\w+$/.test(p)) idents.push(p);
  }
  // 括号内 named 列表：`A`、`A as B`、`type A`
  if (brace) {
    for (const item of brace[1].split(',')) {
      const p = item.trim().replace(/^type\s+/, '');
      if (!p) continue;
      const as = p.match(/^\w+\s+as\s+(\w+)$/);
      if (as) idents.push(as[1]);
      else if (/^\w+$/.test(p)) idents.push(p);
    }
  }
  return idents;
}

/** 解析 src/registry.ts：imports（标识符 → 来源）+ entries（provide token → useClass 标识符） */
function parseRegistry(content: string): {
  imports: Map<string, string>;
  entries: RegistryEntry[];
} {
  const imports = new Map<string, string>();
  // 单/双引号、type 修饰、跨行 named 列表都认；副作用 import（无绑定子句）不产生标识符
  for (const m of content.matchAll(
    /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/gm,
  )) {
    for (const ident of boundIdents(m[1])) imports.set(ident, m[3]);
  }
  const entries: RegistryEntry[] = [];
  for (const m of content.matchAll(/\{\s*provide:\s*'([^']+)'\s*,\s*useClass:\s*(\w+)/g)) {
    entries.push({ token: m[1], ident: m[2] });
  }
  return { imports, entries };
}

/** 分类目录相对注册表的 import 前缀：./tools 等（悬空条目判定用） */
const LOCAL_PREFIXES = CAPABILITY_DIR_LIST.map((p) => './' + p.replace(/^src\//, '') + '/');

export interface DoctorJson {
  ok: string[];
  warnings: string[];
  errors: string[];
  /** 命中老布局时的迁移提示（正常布局下缺席） */
  legacyLayoutHint?: string;
  summary: { errors: number; warnings: number };
}

/**
 * @param opts.json `--json`：机器可读输出（stdout 只有一个 JSON 文档，无人类横幅）。
 *   退出码语义不变 —— 有错误仍退出 1。
 */
export function doctor(opts: { json?: boolean } = {}): number {
  const json = opts.json === true;
  const cwd = process.cwd();

  // 老布局：先给迁移提示再收工 —— 去扫一个还不存在的新布局只会刷一屏无关警告
  const legacy = legacyLayout(cwd);
  if (legacy) {
    const hint = legacyMigrationHint(legacy);
    if (json) {
      const payload: DoctorJson = {
        ok: [],
        warnings: [hint],
        errors: [],
        legacyLayoutHint: hint,
        summary: { errors: 0, warnings: 1 },
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log('agentia doctor —— 装配体检\n');
    console.log(`  警告：${hint}`);
    console.log('\n体检结果：0 错误，1 警告');
    return 0;
  }

  const registryFile = join(cwd, REGISTRY_PATH);

  const content = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : '';
  const { imports, entries } = parseRegistry(content);

  const warnings: string[] = [];
  const errors: string[] = [];
  const oks: string[] = [];

  // 重复 provide 条目 → 错误
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.token, (seen.get(e.token) ?? 0) + 1);
  for (const [token, n] of seen) {
    if (n > 1) errors.push(`${REGISTRY_PATH} 存在 ${n} 条重复 provide: '${token}'，请保留一条`);
  }

  const registeredTokens = new Set(entries.map((e) => e.token));
  /** 文件夹名 → 出现的分类目录列表（跨类型同名会让装配期静默覆盖一个） */
  const whereByName = new Map<string, string[]>();
  const allFolders = new Set<string>();

  // 逐个分类目录体检：命名规范 / 入口文件 / 是否登记
  for (const [type, relDir] of Object.entries(CAPABILITY_DIRS) as [string, string][]) {
    const dir = join(cwd, relDir);
    if (!existsSync(dir)) {
      warnings.push(
        `${relDir}/ 不存在（该类型暂时没有能力；discover 里若仍列着这个路径会启动即报错）`,
      );
      continue;
    }
    const folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const name of folders) {
      allFolders.add(name);
      whereByName.set(name, [...(whereByName.get(name) ?? []), relDir]);
      let broken = false;
      if (!isValidName(name)) {
        errors.push(`能力名「${name}」不符合 kebab-case 规范（${relDir}/${name}/）`);
        broken = true;
      }
      if (!ENTRY_CANDIDATES.some((f) => existsSync(join(dir, name, f)))) {
        errors.push(`能力 ${relDir}/${name}/ 缺少入口文件（${ENTRY_CANDIDATES.join(' / ')}）`);
        broken = true;
      }
      if (!registeredTokens.has(name)) {
        warnings.push(
          `${relDir}/${name}/ 存在但未登记（运行 agentia g ${type} ${name} 或手工登记）`,
        );
      } else if (!broken) {
        oks.push(`${relDir}/${name}：已登记且入口齐全`);
      }
    }
  }

  // 跨分类目录同名 → 错误（四个目录共用一套 token，装配期后者覆盖，菜单只会剩一个）
  for (const [name, dirs] of whereByName) {
    if (dirs.length > 1) {
      errors.push(
        `能力名「${name}」在多个分类目录重复（${dirs.join('、')}）—— DI token 共用，装配期只会保留一个；请改名`,
      );
    }
  }

  // 注册表视角：悬空条目（import 指向本地分类目录但文件夹已不存在；add 引入的包无本地文件夹属正常）
  for (const e of entries) {
    if (!isValidName(e.token)) {
      errors.push(`provide token「${e.token}」不符合 kebab-case 规范`);
    }
    const source = imports.get(e.ident);
    if (source === undefined) continue; // 无法定位 import（可能手工编写），跳过
    const prefix = LOCAL_PREFIXES.find((p) => source.startsWith(p));
    if (prefix === undefined) continue;
    const folder = source.slice(prefix.length).split('/')[0];
    if (folder !== undefined && !allFolders.has(folder)) {
      warnings.push(
        `${REGISTRY_PATH} 条目 { provide: '${e.token}' } 指向 ${source}，但该目录已不存在（悬空条目，请删除条目或恢复目录）`,
      );
    }
  }

  // trace 出口未接 → 警告（2026-10-16 ref-scaffold-observability-gap）。
  // 框架**刻意不内建**任何出口（spec §9.3，出口只有 `sinks` 这条缝），所以「缝在那儿、
  // 没人接」不会有任何报错：同步 `/run` 的 trace 随响应回去了，而异步 `/tasks` 的 trace
  // 落进任务库里**没人导出** —— 等你要查「这个任务为什么慢」时它正好不在。
  // 判据只认**代码里的** `sinks:`：整行注释掉的不算（那种情况下出口确实没接上）。
  const appPath = join(cwd, 'src', 'app.ts');
  if (existsSync(appPath)) {
    const code = readFileSync(appPath, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    if (/sinks\s*:/.test(code)) {
      oks.push('src/app.ts：已配 trace 出口（sinks）');
    } else {
      warnings.push(
        'src/app.ts 未配 sinks ⇒ trace 没有任何出口（异步 /tasks 的 trace 只会躺在任务库里、没人导出）；' +
          '接一行 jsonlTraceSink 即可，配方见框架 docs/observability.md',
      );
    }
  }

  // 项目内 AGENTS.md 的版本漂移（2026-10-16 ref-scaffold-observability-gap）：它是 `create` 时
  // 拷进来的一份**快照**，之后没有任何命令更新它，而 AI 正是照它写代码 ⇒ 框架升级后
  // 「权威入口」静默过期。有版本标记才对得出来；没标记（旧版脚手架 / 手写）也要说一声。
  const agentsFile = join(cwd, 'AGENTS.md');
  if (existsSync(agentsFile)) {
    const agentsSrc = readFileSync(agentsFile, 'utf8');
    const marker = agentsSrc.match(GUIDE_VERSION_RE);
    const current = readCliVersion();
    if (marker === null) {
      warnings.push(
        `AGENTS.md 没有版本标记（旧版脚手架生成或手写）⇒ 无法判断它与当前 CLI（v${current}）` +
          '是否同一版；升级后它可能与框架 API 已经不一致',
      );
    } else if (marker[1] !== current) {
      warnings.push(
        `AGENTS.md 是 v${marker[1]} 写的，当前 CLI 是 v${current} ⇒ 说明可能已过期` +
          '（AI 照它写代码）：重新 create 一份，或对照 docs/usage-guide.md 手工更新',
      );
    } else {
      oks.push(`AGENTS.md：版本标记与 CLI 一致（v${current}）`);
    }
  }

  if (json) {
    const payload: DoctorJson = {
      ok: oks,
      warnings,
      errors,
      summary: { errors: errors.length, warnings: warnings.length },
    };
    console.log(JSON.stringify(payload, null, 2));
    if (errors.length > 0) {
      process.exitCode = 1;
      return 1;
    }
    return 0;
  }

  console.log('agentia doctor —— 装配体检\n');
  for (const msg of oks) console.log(`  ✓ ${msg}`);
  for (const msg of warnings) console.log(`  警告：${msg}`);
  for (const msg of errors) console.log(`  错误：${msg}`);
  console.log(`\n体检结果：${errors.length} 错误，${warnings.length} 警告`);

  if (errors.length > 0) {
    process.exitCode = 1;
    return 1;
  }
  return 0;
}
