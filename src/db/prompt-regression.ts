export interface PromptRegressionSample {
  name: string;
  input: string;
  expected?: unknown;
}

export interface PromptRegressionSetRow {
  id: number;
  name: string;
  biz_type: string;
  provider: string;
  samples_json: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface PromptRegressionSet {
  id: number;
  name: string;
  biz_type: string;
  provider: string;
  samples: PromptRegressionSample[];
  sample_count: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface PromptRegressionSetSummary {
  id: number;
  name: string;
  biz_type: string;
  provider: string;
  sample_count: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export async function listPromptRegressionSets(
  db: D1Database,
  opts: { bizType?: string; provider?: string; limit?: number } = {},
): Promise<PromptRegressionSetSummary[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.bizType) {
    where.push("biz_type = ?");
    args.push(opts.bizType);
  }
  if (opts.provider) {
    where.push("provider = ?");
    args.push(opts.provider);
  }
  const sql = [
    "SELECT * FROM prompt_regression_sets",
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY updated_at DESC, id DESC",
    "LIMIT ?",
  ].filter(Boolean).join(" ");
  args.push(Math.min(Math.max(opts.limit ?? 50, 1), 100));
  const { results } = await db.prepare(sql).bind(...args).all<PromptRegressionSetRow>();
  return results.map((row) => {
    const set = rowToPromptRegressionSet(row);
    return {
      id: set.id,
      name: set.name,
      biz_type: set.biz_type,
      provider: set.provider,
      sample_count: set.sample_count,
      created_by: set.created_by,
      created_at: set.created_at,
      updated_at: set.updated_at,
    };
  });
}

export async function getPromptRegressionSet(
  db: D1Database,
  id: number,
): Promise<PromptRegressionSet | null> {
  const row = await db
    .prepare("SELECT * FROM prompt_regression_sets WHERE id = ? LIMIT 1")
    .bind(id)
    .first<PromptRegressionSetRow>();
  return row ? rowToPromptRegressionSet(row) : null;
}

export async function createPromptRegressionSet(
  db: D1Database,
  input: {
    name: string;
    bizType: string;
    provider: string;
    samples: PromptRegressionSample[];
    createdBy: string | null;
  },
): Promise<PromptRegressionSet> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO prompt_regression_sets
       (name, biz_type, provider, samples_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.name,
      input.bizType,
      input.provider,
      JSON.stringify(input.samples),
      input.createdBy,
      now,
      now,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT * FROM prompt_regression_sets
       WHERE biz_type = ? AND provider = ? AND name = ? AND created_at = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(input.bizType, input.provider, input.name, now)
    .first<PromptRegressionSetRow>();
  if (!row) throw new Error("createPromptRegressionSet: insert returned no row");
  return rowToPromptRegressionSet(row);
}

export async function updatePromptRegressionSet(
  db: D1Database,
  id: number,
  input: { name?: string; samples?: PromptRegressionSample[] },
): Promise<PromptRegressionSet | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    args.push(input.name);
  }
  if (input.samples !== undefined) {
    sets.push("samples_json = ?");
    args.push(JSON.stringify(input.samples));
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    args.push(Date.now());
    args.push(id);
    await db.prepare(`UPDATE prompt_regression_sets SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  }
  return await getPromptRegressionSet(db, id);
}

function rowToPromptRegressionSet(row: PromptRegressionSetRow): PromptRegressionSet {
  const samples = parseSamples(row.samples_json);
  return {
    id: row.id,
    name: row.name,
    biz_type: row.biz_type,
    provider: row.provider,
    samples,
    sample_count: samples.length,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseSamples(raw: string): PromptRegressionSample[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is PromptRegressionSample =>
        !!item &&
        typeof item === "object" &&
        typeof (item as PromptRegressionSample).name === "string" &&
        typeof (item as PromptRegressionSample).input === "string",
      )
      .map((item) => ({
        name: item.name,
        input: item.input,
        ...(Object.prototype.hasOwnProperty.call(item, "expected") ? { expected: item.expected } : {}),
      }));
  } catch {
    return [];
  }
}
