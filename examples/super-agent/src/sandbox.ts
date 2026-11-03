/**
 * 内存沙箱 —— 本示例要操作的「那个代码库」。
 *
 * 为什么是内存而不是真文件系统：这个示例要证明的是**编排**（拆单 / 并行 / 审批 / 汇总），
 * 不是「怎么安全地读写磁盘」（那是 ../patrol/ 的题目，它带了 realpath 边界、隔离区与只读面）。
 * 把 IO 换成 Map 之后，`npm run demo` 可以零副作用地跑完一整轮，断言还能精确到「哪一行被改了」。
 *
 * ⚠️ 换成真文件系统时**必须自己补两样东西**（框架不兜，见 usage-guide §7 的已知边界）：
 *   ① 路径边界（`../` 越界、软链真身）—— 参考 patrol 的 `Workspace.resolveReadable`；
 *   ② 写操作的**幂等**：任务重跑是 at-least-once（store 抖动 / 审批崩溃），
 *      同一份 patch 写两次不能产生两次副作用。
 */
export class Sandbox {
  private readonly files = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
  }

  /** 读一个文件；不存在就抛 —— 异常会被框架包成 is_error 的 tool_result 回给模型 */
  read(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`文件不存在：${path}（可读：${[...this.files.keys()].join(', ')}）`);
    }
    return content;
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** 逐行子串搜索（够用即可：示例不引 grep） */
  search(query: string): Array<{ path: string; line: number; text: string }> {
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const [path, content] of this.files) {
      content.split('\n').forEach((text, i) => {
        if (text.includes(query)) hits.push({ path, line: i + 1, text: text.trim() });
      });
    }
    return hits;
  }

  /** 当前全部文件（demo 用来断言「修复真的落地了」） */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}
