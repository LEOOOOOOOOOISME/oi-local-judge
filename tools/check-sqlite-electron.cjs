const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t(x)');
db.prepare('INSERT INTO t VALUES (?)').run(1);
console.log(
  JSON.stringify({
    ok: true,
    sqlite: db.prepare('select sqlite_version() as v').get().v,
  }),
);
db.close();
