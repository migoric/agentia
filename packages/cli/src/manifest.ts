import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTsxCli } from './dev-child.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 真实装配用户的 src/app.ts，但只输出能力契约，不调用模型。 */
export function manifestCommand(): number {
  const cwd = process.cwd();
  const tsx = resolveTsxCli(cwd, join(HERE, 'cli.js'));
  if (!tsx) {
    console.error('错误：找不到 tsx；请在项目 devDependencies 安装 tsx 后重试');
    return 1;
  }
  const result = spawnSync(process.execPath, [tsx, join(HERE, 'manifest-runner.js')], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`错误：能力清单进程启动失败：${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
