const users = 500;
const problems = 8;
const rows = Array.from({ length: users }, (_, u) => ({
  userId: u,
  scores: Array.from({ length: problems }, (_, p) => (u * 7 + p * 13) % 101),
}));

const start = process.hrtime.bigint();
for (const row of rows) {
  row.total = row.scores.reduce((a, b) => a + b, 0);
}
rows.sort((a, b) => b.total - a.total || a.userId - b.userId);
const ranked = rows.map((row, i) => ({ rank: i + 1, ...row }));
const payload = JSON.stringify({ contestId: 1, rows: ranked });
const computeMs = Number(process.hrtime.bigint() - start) / 1e6;

console.log(
  JSON.stringify({
    computeMs: Number(computeMs.toFixed(3)),
    serializeKb: Number((Buffer.byteLength(payload) / 1024).toFixed(1)),
    rows: ranked.length,
  }),
);
