import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  console.error("数据库连接异常：", error.code || error.name);
});


export async function migrate() {
  /** 幂等创建账号表；不修改现有账号数据。 */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_users (
      id uuid PRIMARY KEY,
      username varchar(32) NOT NULL UNIQUE,
      password_hash text NOT NULL,
      display_name varchar(40) NOT NULL,
      bio varchar(200) NOT NULL DEFAULT '',
      workspace jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 0,
      session_hash text,
      session_id uuid,
      session_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS study_users_session_idx
      ON study_users (session_hash) WHERE session_hash IS NOT NULL;
  `);
}
