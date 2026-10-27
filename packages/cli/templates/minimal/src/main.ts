import { createApp, loadEnvFile } from '@migor/agentia';
import type { AgentTool } from '@migor/agentia';

loadEnvFile();

const echo = {
  name: 'echo',
  description: '原样返回输入文本，用来验证模型与工具链路',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  run: (input) => (input as { text: string }).text,
} satisfies AgentTool;

const app = createApp({
  name: '__PROJECT_NAME__',
  system: '你是简洁的助手，需要原样返回文本时调用 echo 工具。',
  tools: [echo],
});

const { result } = await app.run([
  { role: 'user', content: process.argv[2] ?? '用 echo 返回：hello agentia' },
]);

if (result.error) {
  console.error(`run 失败（stopReason=${result.stopReason}）：${result.error.message}`);
  console.error('请把 ANTHROPIC_API_KEY 填进 .env，或设置对应的环境变量。');
  process.exitCode = 1;
} else {
  console.log(result.finalText);
  // result.trace 已包含本次调用的完整调用树与 token/成本；需要落盘时再接 TraceSink。
}
