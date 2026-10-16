#!/usr/bin/env node
/** agentia CLI 入口：手写参数解析 + 命令分发（零依赖） */
import { createProject } from './create.js';
import { generateCapability } from './generate.js';
import { isCapabilityType, isValidName, CAPABILITY_TYPES } from './templates.js';
import { RegistryError } from './registry.js';
import { devServer } from './dev.js';
import { doctor } from './doctor.js';
import { addPackage } from './add.js';
import { reportCommand, USAGE as REPORT_USAGE } from './report.js';
import { harvestCommand, USAGE as HARVEST_USAGE } from './harvest.js';
import { diffCommand, USAGE as DIFF_USAGE } from './diff.js';
import { exportCommand, USAGE as EXPORT_USAGE } from './export.js';
import { readCliVersion } from './version.js';

const USAGE = `agentia —— Agentia 框架命令行工具

用法：
  agentia create <name> [--dir <parent>]   创建项目脚手架（目录 <parent|当前目录>/<name>/）
  agentia g <type> <name>                  在当前目录生成能力（别名：generate）
                                           type: ${CAPABILITY_TYPES.join(' | ')}
  agentia dev [-- "问题"]                   启动开发模式（常驻 runner + 本地 inspector 面板：
                                           在面板里选能力/工作目录、输入 prompt 驱动一次 run，
                                           并看它的调用树；改代码或 .md 自动重启）
  agentia doctor [--json]                  装配体检（未登记/悬空能力/命名规范/重复条目）
  agentia report <trace.jsonl> [--json]    从 trace 落盘文件生成调优报告（能力耗时/成本/错误率排行）
  agentia harvest <trace.jsonl>            把线上 trace 翻成 eval 用例骨架
                                           （[--out <file.ts>] [--force] [--failed] [--limit N]）
  agentia diff <a.jsonl> <b.jsonl> [--json] 两条 trace 的调用树 A/B 比对（有差异时退出码 1）
  agentia export <trace.jsonl>             trace 落盘文件 → 训练数据集（JSONL，一行一份 messages）
                                           （[--out <file>] [--ok-only] [--min-score n]）
  agentia add <pkg>                        安装第三方能力包并登记到 src/registry.ts
  agentia --help                           显示本帮助
  agentia --version                        显示版本（等价 -v）

--json：report / diff / doctor 的机器可读输出 —— stdout 只有一个 JSON 文档、无人类装饰，
        便于脚本与 CI 串接；出错仍走 stderr + 退出码 1。（harvest / export 没有 --json：它们的 stdout
        本身就是产物 —— eval 文件源码 / 训练数据 JSONL。）
name 规则：小写字母开头的小写 kebab-case（如 hello、doc-reviewer）
`;

// 各子命令自己的用法串 —— 同时供 fail() 与「子命令级 --help」使用（单源，不写两遍）。
// report / harvest / diff 的用法串在各自模块里（那里本来就有），此处 import 复用。
const CREATE_USAGE = '用法：agentia create <name> [--dir <parent>]';
const G_USAGE = `用法：agentia g <type> <name>（type: ${CAPABILITY_TYPES.join(' | ')}）`;
const ADD_USAGE = '用法：agentia add <pkg>（npm 包名或本地包路径）';

/** 子命令 → 自己的用法串。`--help` 落在子命令上时打它。 */
const SUB_USAGE: Record<string, string | undefined> = {
  create: CREATE_USAGE,
  g: G_USAGE,
  generate: G_USAGE,
  dev: '用法：agentia dev [-- "首次 run 的 prompt"]',
  doctor: '用法：agentia doctor [--json]',
  report: REPORT_USAGE,
  harvest: HARVEST_USAGE,
  diff: DIFF_USAGE,
  export: EXPORT_USAGE,
  add: ADD_USAGE,
};

function fail(message: string): number {
  console.error(`错误：${message}`);
  process.exitCode = 1;
  return 1;
}

function checkName(name: string | undefined): name is string {
  if (name === undefined) return false;
  return isValidName(name);
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  // 版本：`--version` / `-v`。此前只有 `--help`，用户问不出自己装的是哪一版 —— 而本仓库
  // 把版本纪律做到了发布面+闸门，CLI 却报不出自己的版本，是个说不通的缺口（bug 报告第一句
  // 就是「你装的哪一版」）。
  if (command === '--version' || command === '-v') {
    console.log(readCliVersion());
    return 0;
  }

  // 子命令级 --help：此前 `agentia report --help` 会把 --help 当成「要读的文件名」，
  // 用户拿到的是 ENOENT 而不是该命令的用法（report / harvest / diff 尤其需要）。
  const subUsage = SUB_USAGE[command];
  if (subUsage !== undefined && (rest[0] === '--help' || rest[0] === '-h')) {
    console.log(subUsage);
    return 0;
  }

  if (command === 'create') {
    const name = rest[0];
    let parent: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      if (rest[i] === '--dir') {
        parent = rest[i + 1];
        if (parent === undefined) return fail('--dir 需要一个目录参数');
        i += 1;
      } else {
        return fail(`未知参数：${rest[i]}`);
      }
    }
    if (name === undefined) return fail(`缺少项目名，${CREATE_USAGE}`);
    if (!checkName(name)) {
      return fail(`非法项目名「${name}」：需匹配小写 kebab-case（如 my-app）`);
    }
    return createProject(name, parent);
  }

  if (command === 'g' || command === 'generate') {
    const [type, name, ...extra] = rest;
    if (type === undefined || name === undefined || extra.length > 0) {
      return fail(G_USAGE);
    }
    if (!isCapabilityType(type)) {
      return fail(`未知能力类型「${type}」，可选：${CAPABILITY_TYPES.join(' | ')}`);
    }
    if (!checkName(name)) {
      return fail(`非法能力名「${name}」：需匹配小写 kebab-case（如 doc-reviewer）`);
    }
    try {
      return generateCapability(type, name);
    } catch (err) {
      if (err instanceof RegistryError) return fail(err.message);
      throw err;
    }
  }

  if (command === 'dev') {
    // 额外参数透传给用户脚本：脚手架把 `npm run dev` 指向本命令，而工程 README 文档化的
    // 用法是 `npm run dev -- "你的问题"` —— 参数必须原样传下去，不能当未知参数拒掉。
    return devServer(rest);
  }

  if (command === 'doctor') {
    const extra = rest.filter((a) => a !== '--json');
    if (extra.length > 0) return fail(`未知参数：${extra[0]}`);
    return doctor({ json: rest.includes('--json') });
  }

  if (command === 'report') {
    // 异步命令（要 dynamic import 构建期拷进来的聚合实现）：自己设 exitCode，
    // 返回值仅表示「已受理」—— 挂着的 Promise 会让 Node 等到它 settle 再退出。
    void reportCommand(rest).catch((e: unknown) => {
      console.error(`错误：${(e as Error).message}`);
      process.exitCode = 1;
    });
    return 0;
  }

  if (command === 'harvest') {
    // 异步命令（读文件/写文件）：同 report 的受理模式
    void harvestCommand(rest).catch((e: unknown) => {
      console.error(`错误：${(e as Error).message}`);
      process.exitCode = 1;
    });
    return 0;
  }

  if (command === 'diff') {
    // 异步命令（读文件）：同 report 的受理模式
    void diffCommand(rest).catch((e: unknown) => {
      console.error(`错误：${(e as Error).message}`);
      process.exitCode = 1;
    });
    return 0;
  }

  if (command === 'export') {
    // 异步命令（读文件/写文件）：同 report 的受理模式
    void exportCommand(rest).catch((e: unknown) => {
      console.error(`错误：${(e as Error).message}`);
      process.exitCode = 1;
    });
    return 0;
  }

  if (command === 'add') {
    const [pkg, ...extra] = rest;
    if (pkg === undefined || extra.length > 0) {
      return fail(ADD_USAGE);
    }
    try {
      return addPackage(pkg);
    } catch (err) {
      if (err instanceof RegistryError) return fail(err.message);
      throw err;
    }
  }

  const code = fail(`未知命令「${command}」\n`);
  console.error(USAGE);
  return code;
}

process.exitCode = main(process.argv.slice(2));
