/** create --minimal：单文件 + 裸工具的项目生成（与完整服务模板分文件，避免 create.ts 继续膨胀）。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  minimalMainTs,
  minimalReadme,
  projectDotEnv,
  projectDotEnvExample,
  projectGitignore,
  projectPackageJson,
  projectTsconfig,
} from './templates.js';
import { GUIDE_VERSION_MARKER, readCliVersion } from './version.js';

/** 与完整模板共享依赖和版本 pin，只收敛 scripts。 */
export function minimalPackageJson(name: string): string {
  const pkg = JSON.parse(projectPackageJson(name)) as { scripts: Record<string, string> };
  pkg.scripts = {
    ...pkg.scripts,
    dev: 'tsx src/main.ts',
    build: 'tsc -p tsconfig.json',
    start: 'node dist/main.js',
  };
  delete pkg.scripts['start:prod'];
  delete pkg.scripts['start:batch'];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function write(dir: string, rel: string, content: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

export function createMinimalProject(dir: string, name: string, guide: string): number {
  write(dir, 'package.json', minimalPackageJson(name));
  write(dir, 'tsconfig.json', projectTsconfig());
  write(dir, 'src/main.ts', minimalMainTs(name));
  write(dir, 'README.md', minimalReadme(name));
  write(dir, '.gitignore', projectGitignore());
  write(dir, '.env', projectDotEnv());
  write(dir, '.env.example', projectDotEnvExample());
  write(dir, 'AGENTS.md', `${GUIDE_VERSION_MARKER(readCliVersion())}\n${guide}`);

  console.log(`已创建最小项目 ${dir}

后续步骤：
  cd ${dir}
  npm install
  把 API key 填进 .env（已生成，且已被 .gitignore 忽略）
  npm run dev -- "你的问题"   # 一个入口文件 + 一个裸工具，跑一次并退出

构建后运行：npm run typecheck && npm run build && npm start -- "你的问题"

需要 inspector、能力目录/registry 或 HTTP 服务时，用默认完整模板另建项目：
  npx @migor/cli create my-service`);
  return 0;
}
