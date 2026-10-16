// Agentia 能力注册表 —— 由 agentia CLI 维护（agentia g 自动更新，也可手工编辑）
// @agentia:imports
// @agentia:imports-end
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider } from '@migor/agentia';

/** 显式装配路线：createApp({ providers, system: ... })（与 discover 目录扫描二选一或混用） */
export const providers: Provider[] = [
  // 「工作目录」以**值**注入给需要它的能力（消费方式见 src/tools/read-file/index.ts）。
  // 项目根按**本文件位置**解析（src/registry.ts → 上一层），与 src/app.ts 那份同值 ——
  // ⚠️ 此前这里是 `process.cwd()`：换目录启动（systemd / 容器 `-w`）时两份 `WORKDIR`
  // 值不同，混用两条装配路线时谁生效取决于拼接顺序（「后注册覆盖先注册」），
  // 而框架现在会对同 token 重复注册出声告警 ⇒ 两份同值之后，混用不再改变语义。
  // resolve 顺手去掉尾斜杠：与 app.ts 的 PROJECT_ROOT **逐字同值**（两份若只差一个尾斜杠，
  // 能力侧拿到的字符串就不一样，而「两份 WORKDIR 值不同」正是最难查的那类差异）
  { provide: 'WORKDIR', useValue: resolve(fileURLToPath(new URL('..', import.meta.url))) },
  // @agentia:entries
  // @agentia:entries-end
];
