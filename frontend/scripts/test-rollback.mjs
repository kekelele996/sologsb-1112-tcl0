import 'fake-indexeddb/auto';
import { setActivePinia, createPinia } from 'pinia';
import { useReportStore } from '../src/stores/reportStore.ts';
import { useRingStore } from '../src/stores/ringStore.ts';
import { db } from '../src/utils/db.ts';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

setActivePinia(createPinia());
const ringStore = useRingStore();
await ringStore.addRing({
  ringNo: 'A-10231',
  colorRing: '红-黄',
  speciesCn: '红喉歌鸲',
  speciesSci: 'Calliope calliope',
  age: '成',
  ringDate: '2026-08-01T08:00:00.000Z',
  netNo: '3 号网',
  netRound: 2,
  status: '初捕',
  ringer: '韩雪',
  siteId: 'site-001',
  sessionId: 'session-001',
});

const reportStore = useReportStore();

// 先成功导入一份（已对好的结果）
const ok = await reportStore.importBulletin(`第一批通报
A-10231，红喉歌鸲，2026年9月18日，在崇明东滩保护站回收。`);
check('first import ok', [ok.matched, ok.createdRings], [1, 1]);

const ringsSnapshot = await db.rings.toArray();
const reportsSnapshot = await db.reports.toArray();

// 让 bulkPut 在第二次导入事务中途抛错：reports 表先成功 put，rings 表 put 时被拒
const originalBulkPut = db.rings.bulkPut.bind(db.rings);
db.rings.bulkPut = function patched(values) {
  // 环志记录写入（不是初始数据）时抛错
  if (Array.isArray(values) && values.some((v) => v && v.status === '回收' && v.reportId)) {
    return Promise.reject(new Error('模拟写入失败（磁盘配额/约束错误）'));
  }
  return originalBulkPut(values);
};

let threw = false;
let message = '';
try {
  await reportStore.importBulletin(`第二批通报
A-10231，红喉歌鸲，2026年9月19日，在青岛环志站回收。
D-90001，红喉歌鸲，2026年9月20日，由盘锦湿地环志站回收上报。`);
} catch (error) {
  threw = true;
  message = String((error).message);
}
check('failed import throws', threw, true);
check('error message surfaced', message.includes('模拟写入失败'), true);

// 事务整体回滚：两张表都恢复到导入前
const ringsAfter = await db.rings.toArray();
const reportsAfter = await db.reports.toArray();
check('rings fully rolled back', ringsAfter.length, ringsSnapshot.length);
check('reports fully rolled back', reportsAfter.length, reportsSnapshot.length);
check(
  'no half-written report',
  reportsAfter.some((r) => r.ringNo === 'D-90001'),
  false,
);

// store 内存态也没有被脏数据污染
check('store state not polluted', reportStore.reports.length, reportsSnapshot.length);

// 失败后可用同一段原文重试（恢复 bulkPut 后成功）
db.rings.bulkPut = originalBulkPut;
const retry = await reportStore.importBulletin(`第二批通报
A-10231，红喉歌鸲，2026年9月19日，在青岛环志站回收。
D-90001，红喉歌鸲，2026年9月20日，由盘锦湿地环志站回收上报。`);
check('retry succeeds', [retry.total, retry.matched, retry.verify, retry.unclaimed], [2, 1, 0, 1]);
check('retry created exactly one ring', retry.createdRings, 1);
check('retry stored two reports', await db.reports.count(), reportsSnapshot.length + 2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
