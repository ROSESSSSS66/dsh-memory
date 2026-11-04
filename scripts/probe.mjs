import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function runProbe() {
  const report = {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sqlite: {},
    zlib: {}
  };

  console.log(`=== M0-T1 运行时探测 ===`);
  console.log(`Node.js 版本: ${process.versions.node}`);
  console.log(`平台 / 架构: ${process.platform} / ${process.arch}`);

  // 1. node:sqlite 探测
  try {
    const memDb = new DatabaseSync(':memory:');
    report.sqlite.nodeSqliteAvailable = true;
    console.log(`[node:sqlite] 导入与内存数据库实例化: 成功`);

    // FTS5 探测
    try {
      memDb.exec(`CREATE VIRTUAL TABLE test_fts USING fts5(x)`);
      memDb.exec(`INSERT INTO test_fts(x) VALUES ('hello world')`);
      const ftsRes = memDb.prepare(`SELECT rowid, x FROM test_fts WHERE test_fts MATCH 'hello'`).all();
      report.sqlite.fts5Available = true;
      report.sqlite.fts5TestPassed = ftsRes.length === 1 && ftsRes[0].x === 'hello world';
      console.log(`[node:sqlite] FTS5 虚拟表及 MATCH 检索测试: 成功`);
    } catch (err) {
      report.sqlite.fts5Available = false;
      report.sqlite.fts5Error = err.message;
      console.error(`[node:sqlite] FTS5 失败:`, err.message);
    }

    // 事务支持探测
    try {
      memDb.exec(`CREATE TABLE tx_test(id INT PRIMARY KEY, val TEXT)`);
      memDb.exec(`BEGIN TRANSACTION`);
      memDb.exec(`INSERT INTO tx_test VALUES (1, 'ok')`);
      memDb.exec(`COMMIT`);

      let rollbackWorked = false;
      try {
        memDb.exec(`BEGIN TRANSACTION`);
        memDb.exec(`INSERT INTO tx_test VALUES (2, 'fail')`);
        throw new Error('intentional_error');
      } catch {
        memDb.exec(`ROLLBACK`);
        const cnt = memDb.prepare(`SELECT count(*) as c FROM tx_test WHERE id = 2`).get();
        rollbackWorked = cnt.c === 0;
      }
      report.sqlite.transactionPassed = rollbackWorked;
      console.log(`[node:sqlite] 事务回滚测试: ${rollbackWorked ? '成功' : '失败'}`);
    } catch (err) {
      report.sqlite.transactionPassed = false;
      report.sqlite.txError = err.message;
      console.error(`[node:sqlite] 事务测试异常:`, err.message);
    }

    memDb.close();

    // 持久化文件与重开探测
    const tmpFile = path.join(os.tmpdir(), `dsh_probe_${Date.now()}.db`);
    try {
      const fileDb1 = new DatabaseSync(tmpFile);
      fileDb1.exec(`CREATE TABLE t(k TEXT, v TEXT)`);
      fileDb1.exec(`INSERT INTO t VALUES ('a', '123')`);
      fileDb1.close();

      const fileDb2 = new DatabaseSync(tmpFile);
      const row = fileDb2.prepare(`SELECT v FROM t WHERE k = 'a'`).get();
      fileDb2.close();
      report.sqlite.persistencePassed = (row && row.v === '123');
      console.log(`[node:sqlite] 磁盘持久化与重开测试: ${report.sqlite.persistencePassed ? '成功' : '失败'}`);
    } catch (err) {
      report.sqlite.persistencePassed = false;
      report.sqlite.persistenceError = err.message;
      console.error(`[node:sqlite] 持久化测试异常:`, err.message);
    } finally {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    }

  } catch (err) {
    report.sqlite.nodeSqliteAvailable = false;
    report.sqlite.error = err.message;
    console.error(`[node:sqlite] 不可用:`, err.message);
  }

  // 2. zstd 解压探测
  report.zlib.zstdDecompressSyncType = typeof zlib.zstdDecompressSync;
  console.log(`[node:zlib] typeof zlib.zstdDecompressSync: ${report.zlib.zstdDecompressSyncType}`);

  if (typeof zlib.zstdDecompressSync === 'function') {
    try {
      // 测试基本的 zstd 压缩/解压 (如果 zstdCompressSync 也存在)
      if (typeof zlib.zstdCompressSync === 'function') {
        const buf = Buffer.from('hello dsh zstd test');
        const compressed = zlib.zstdCompressSync(buf);
        const decompressed = zlib.zstdDecompressSync(compressed);
        report.zlib.zstdRoundtripPassed = decompressed.toString() === 'hello dsh zstd test';
        console.log(`[node:zlib] zstd 压缩/解压往返测试: ${report.zlib.zstdRoundtripPassed ? '成功' : '失败'}`);
      } else {
        report.zlib.zstdCompressSyncType = typeof zlib.zstdCompressSync;
        console.log(`[node:zlib] zstdCompressSync: ${typeof zlib.zstdCompressSync}`);
      }
    } catch (err) {
      report.zlib.zstdError = err.message;
      console.error(`[node:zlib] zstd 测试失败:`, err.message);
    }
  }

  console.log(`\n--- JSON 报告 ---`);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

runProbe().catch(console.error);
