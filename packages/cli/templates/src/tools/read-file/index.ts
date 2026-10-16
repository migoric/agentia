import { readdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Tool } from '@migor/agentia';

/** 目录清单的输出上限（条）。截断会在输出里**明示** —— 静默少给等于让模型以为目录里没有 */
const LIST_LIMIT = 200;

/**
 * 工作目录的一对工具：**先看有什么（list_files）→ 再读（read_file）**。
 *
 * 它是脚手架自带的第二个能力，作用是把「工作目录」这条线**接通**：
 * `agentia dev` 的面板上有「工作目录」控件，而只有当**某个能力真的消费它**时，
 * 那个控件才有可观测的效果。做法就是这里 —— 根由 DI 注入（`WORKDIR`），不在代码里写死。
 *
 * ⚠️ **依赖声明就在本类上**（`static readonly deps = ['WORKDIR']`，见下）：`discover`
 * 读到它就会把 deps 带上，所以**装配文件不需要知道这个能力要什么**。
 * 此前（2026-10-16 前）discover 对「类」只产 `useClass`，需要注入的能力只能挪到
 * `app.ts` 的显式 providers 里**再注册一遍** ⇒ 同一 token 出现两份（一份无 deps、
 * 一份有），靠「后注册覆盖先注册」碰巧成立 —— 顺序一变就静默失效。现在没这个必要了。
 *
 * 为什么是一对而不是只有 read_file：换了目录之后，模型既不知道自己此刻在哪个目录、
 * 也不知道里面有什么（run 的 prompt 不会变）⇒ 只能瞎猜文件名，行为看起来「没变」。
 * `list_files` 输出的**第一行就是工作目录的绝对路径** —— 那是模型「知道自己在哪」
 * 的通道；列出来的名字则回答「里面有什么」。
 *
 * 换成别的形态（把 `workdir` 换成某个 API 的 baseUrl、某个数据目录）完全一样：
 * 值从构造器进来，方法里用 `this.root`。
 */
export default class ReadFileTool {
  /**
   * 依赖声明（discover 会读它并带上 deps ⇒ `app.ts` 不必为这个能力再注册一遍）。
   * ⚠️ 必须是**字符串数组**：写成 `deps = 'WORKDIR'` 时 discover 会响亮报错
   * （不当成「没有依赖」去无参构造 —— 那正是要避免的静默失效）。
   */
  static readonly deps = ['WORKDIR'];

  constructor(private readonly root: string) {
    // 兜底：若哪天 deps 被摘掉（或能力被以无 deps 的方式注册），容器会无参构造这个类，
    // root 变成 undefined，工具就会静默地按 cwd 解析。与其静默，不如在这里响亮报错。
    if (typeof root !== 'string' || root.length === 0) {
      throw new Error(
        "ReadFileTool 需要注入工作目录：请在能力类上保留 `static readonly deps = ['WORKDIR']`" +
          "（discover 会带上它），或在显式 providers 里声明 { provide: 'read-file', deps: ['WORKDIR'] }",
      );
    }
    // ⚠️ **归一化**：调用方给的工作目录可能带尾斜杠（面板输入、dev.config 手写、
    // `.../repo/` 粘进来都很常见），而 `safeResolve` 的越界判定是
    // `abs.startsWith(root + sep)` 这类**字符串前缀**比较 —— root 不归一化时
    // 拼接出来的前缀是 `/a/b//`，判定恒为假 ⇒ **每一次** read_file 都报
    // 「路径越出工作目录」。那不是「误报」，是把工具整个变成坏的（且错误归因误导模型）。
    this.root = resolve(root);
  }

  @Tool({
    description:
      '列出工作目录（或其中一个相对子目录）的内容：先看这里有什么，再用 read_file 读具体文件。' +
      '输出第一行是当前工作目录的绝对路径 —— 换过目录后用它确认自己此刻在哪个目录下工作。',
    schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '相对工作目录的子目录路径（缺省 = 工作目录本身）' },
      },
      additionalProperties: false,
    },
    strict: true,
  })
  // 目录名带 `/` 后缀（一眼可辨），目录在前、文件在后。越界判定复用 safeResolve ——
  // 读目录也是读，同一道闸。输出有上限，截断**明示**（不许静默少给）。
  async list_files(input: { dir?: string }): Promise<string> {
    const abs = safeResolve(this.root, input.dir ?? '.');
    const entries = await readdir(abs, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => {
        const dirA = a.endsWith('/') ? 0 : 1;
        const dirB = b.endsWith('/') ? 0 : 1;
        return dirA - dirB || a.localeCompare(b);
      });
    const lines = [`工作目录：${this.root}`];
    if (input.dir !== undefined && input.dir !== '.') lines.push(`所列目录：${abs}`);
    lines.push(...names.slice(0, LIST_LIMIT));
    if (names.length > LIST_LIMIT) {
      lines.push(`（还有 ${names.length - LIST_LIMIT} 条未列出 —— 输出截断在 ${LIST_LIMIT} 条）`);
    }
    return lines.join('\n');
  }

  @Tool({
    description: '读取工作目录下的一个文本文件（给相对路径，如 README.md）；不知道文件名时先用 list_files 看',
    schema: {
      type: 'object',
      properties: { rel: { type: 'string', description: '相对工作目录的文件路径' } },
      required: ['rel'],
      additionalProperties: false,
    },
    strict: true,
  })
  // 方法名 = 模型看到的工具名 ⇒ 与其余模板一律 snake_case（doc_reviewer / note_writer …）。
  // 顺带解掉一个坑：这里若叫 readFile，就与上面 import 进来的 readFile 同名 ——
  // 方法体内 `this.readFile(...)` 会变成自我递归，而裸写 `readFile(...)` 读的是 import 的那个。
  // 分工：list_files 负责「先看有什么」，这里负责「读这个具体文件」。
  async read_file(input: { rel: string }): Promise<string> {
    return readFile(safeResolve(this.root, input.rel), 'utf8');
  }
}

/**
 * 把模型给的路径约束在工作目录内（**越界响亮报错**，错误会作为 is_error 回给模型）。
 *
 * 这条纪律是「可指向任意目录的 agent」活得下去的前提：切目录本身不危险，
 * 危险的是它悄悄跑到工作目录外面去读写。别改成静默截断 / 静默回退。
 *
 * ⚠️ 两端都归一化再比：`root` 由调用方给（可能带尾斜杠），而下面判越界用的是
 * **字符串前缀** —— `resolve(root) + sep` 不归一化时会是 `/a/b//`，于是每一次调用
 * 都误报越界。归一化放在函数内部（不只依赖构造器）：本函数是导出的，调用方可能不止一个。
 *
 * ⚠️ 已知边界：**不解 realpath** —— 工作目录**内**的符号链接可以指到目录外。
 * 它防的是「模型乱给相对路径跑出工作目录」，不是一道安全边界（read-only，危害有限）；
 * 真要拿它当边界用（比如可写工具），先在这里补 realpath 比较。
 */
export function safeResolve(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`路径越出工作目录: "${rel}"（工作目录：${base}）`);
  }
  return abs;
}
