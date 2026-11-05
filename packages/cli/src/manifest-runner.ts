import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main(): Promise<void> {
  const entry = resolve(process.cwd(), 'src/app.ts');
  if (!existsSync(entry)) throw new Error('缺少 src/app.ts（需要导出 createAgentApp）');
  const mod = (await import(pathToFileURL(entry).href)) as {
    createAgentApp?: () => unknown | Promise<unknown>;
  };
  if (typeof mod.createAgentApp !== 'function') {
    throw new Error('src/app.ts 必须导出 createAgentApp()');
  }
  const app = (await mod.createAgentApp()) as {
    getCapabilityManifest?: () => unknown;
  };
  if (typeof app.getCapabilityManifest !== 'function') {
    throw new Error(
      'createAgentApp 返回的对象不支持 getCapabilityManifest()；请升级 @migor/agentia',
    );
  }
  process.stdout.write(`${JSON.stringify(app.getCapabilityManifest(), null, 2)}\n`);
}

main().catch((e: unknown) => {
  console.error(`[agentia] 能力清单装配失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
