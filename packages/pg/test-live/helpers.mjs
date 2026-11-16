import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import '../test/helpers.mjs'; // 复用 dist 新鲜度守卫：live 套件同样不测旧产物

export const liveUrl = process.env.AGENTIA_PG_TEST_URL;
if (!liveUrl) {
  throw new Error(
    '真实 PG 套件需要 AGENTIA_PG_TEST_URL（例如 postgresql://postgres:password@127.0.0.1:5432/postgres）。' +
      '默认 npm test 不需要真实数据库，仍由 PGlite 覆盖。',
  );
}

export function newClient() {
  return new Client({ connectionString: liveUrl, application_name: 'agentia-pg-live-test' });
}

/** 每个用例独立 schema；即使意外失败也不会碰宿主的 agentia_* 表。 */
export async function withLiveSchema(fn) {
  const admin = newClient();
  await admin.connect();
  const schema = `agentia_live_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    return await fn({ admin, schema, tablePrefix: 'agentia_' });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
