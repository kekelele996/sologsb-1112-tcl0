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
  if (a === e) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
async function expectThrow(name, fn, fragment) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = !fragment || String((error).message).includes(fragment);
  }
  check(name, threw, true);
}

const BULLETIN_OK = `全国鸟类环志中心回捕通报（2026 年 9 月）
各环志站：
现将近期各地回收情况通报如下。
A-10231，红喉歌鸲，2026年9月18日，在崇明东滩保护站回收。
B-20512，大山雀，2026-09-15，条子泥监测点发现死亡个体。
D-90001，红喉歌鸲，2026年9月20日，由盘锦湿地环志站回收上报。
请有关站点核对后反馈。
全国鸟类环志中心`;

function resetPinia() {
  setActivePinia(createPinia());
}

async function seedInitial() {
  resetPinia();
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
  await ringStore.addRing({
    ringNo: 'B-20512',
    colorRing: '无',
    speciesCn: '大山雀',
    speciesSci: 'Parus cinereus',
    age: '成',
    ringDate: '2026-08-10T08:00:00.000Z',
    netNo: '8 号网',
    netRound: 2,
    status: '初捕',
    ringer: '郑海',
    siteId: 'site-003',
    sessionId: 'session-003',
  });
  return ringStore;
}

/* ---------- 1. 空文本 / 无环号：报错且什么都不写 ---------- */
resetPinia();
const reportStore = useReportStore();
await expectThrow('empty text throws', () => reportStore.importBulletin('   '), '通报内容为空');
await expectThrow('no ring throws', () => reportStore.importBulletin('没有环号的一段通报，请查收'), '没有识别到金属环号');
check('reports untouched on parse error', await db.reports.count(), 0);
check('rings untouched on parse error', await db.rings.count(), 0);

/* ---------- 2. 正常导入：已对账挂回收，查无此环待认领 ---------- */
const ringStore = await seedInitial();
const store2 = useReportStore();
await store2.hydrate();
const result = await store2.importBulletin(BULLETIN_OK);
check('summary total', result.total, 3);
check('summary matched', result.matched, 2);
check('summary unclaimed', result.unclaimed, 1);
check('summary verify', result.verify, 0);
check('summary created rings', result.createdRings, 2);

await ringStore.hydrate();
const recoveries = ringStore.rings.filter((r) => r.status === '回收');
check('two recovery records', recoveries.length, 2);
const rec10231 = recoveries.find((r) => r.ringNo === 'A-10231');
check('recovery date', rec10231.ringDate.slice(0, 10), '2026-09-18');
check('recovery site', rec10231.reportSite, '崇明东滩');
check('recovery ringer placeholder', rec10231.ringer, '回捕通报');
check('recovery keeps initial species', rec10231.speciesCn, '红喉歌鸲');
check('recovery keeps initial site', rec10231.siteId, 'site-001');
check('recovery linked report id is set', !!rec10231.reportId, true);

const reports = await db.reports.toArray();
check('three reports stored', reports.length, 3);
const d90001 = reports.find((r) => r.ringNo === 'D-90001');
check('unknown ring pending claim', d90001.status, '待认领');
check('unknown ring no ringId', d90001.ringId, '');
const okReport = reports.find((r) => r.ringNo === 'A-10231');
check('matched report auto resolved', okReport.resolvedBy, '自动对账');
check('source text retained', okReport.sourceText.includes('全国鸟类环志中心'), true);

/* ---------- 3. 同一段通报再贴一次：不重复挂 ---------- */
const beforeCount = await db.rings.count();
const again = await store2.importBulletin(BULLETIN_OK);
check('duplicate flagged', again.duplicated, true);
check('duplicate no reports added', await db.reports.count(), 3);
check('duplicate no rings added', await db.rings.count(), beforeCount);
// 只改空白仍视为同一段
const againSpaced = await store2.importBulletin(`\n${BULLETIN_OK.replace(/\n/g, '  \n  ')}\n`);
check('whitespace-only diff duplicate', againSpaced.duplicated, true);

/* ---------- 4. 鸟种 / 日期对不上：本地与通报原样，待核实，不生成回收 ---------- */
const mismatch = `补充通报
A-10231，麻雀，2026年9月19日，青岛环志站回收。
B-20512，大山雀，2026年7月1日，条子泥监测点重捕。`;
const r3 = await store2.importBulletin(mismatch);
check('mismatch all verify', [r3.matched, r3.verify, r3.unclaimed], [0, 2, 0]);
check('mismatch no new rings', r3.createdRings, 0);
const verifyReports = (await db.reports.where('status').equals('待核实').toArray());
check('two verify reports', verifyReports.length, 2);
// 本地初捕记录原样未动
const initial10231 = ringStore.rings.find((x) => x.ringNo === 'A-10231' && x.status === '初捕');
check('local initial untouched species', initial10231.speciesCn, '红喉歌鸲');
// 通报鸟种保留
check(
  'bulletin species retained',
  verifyReports.find((x) => x.ringNo === 'A-10231').speciesCn,
  '麻雀',
);

/* ---------- 5. 导入失败整体回滚：构造事务内失败 ---------- */
// 报告数据过多触发存储失败不易模拟；改为：重复 fingerprint 检查在事务内，
// 而空文本在事务外已覆盖。这里验证 attach 的失败回滚。
const verifyA = verifyReports.find((x) => x.ringNo === 'A-10231');
const ringCountBeforeAttach = await db.rings.count();
await expectThrow(
  'attach to nonexistent initial fails',
  () => store2.attach(verifyA.id, 'ring-not-exist'),
  '请选择一条本地初捕记录',
);
check('attach failure leaves rings', await db.rings.count(), ringCountBeforeAttach);
check('attach failure leaves report status', (await db.reports.get(verifyA.id)).status, '待核实');

/* ---------- 6. 人工确认挂接（待核实） ---------- */
await store2.attach(verifyA.id, initial10231.id);
await ringStore.hydrate();
const afterAttach = ringStore.rings.filter((r) => r.status === '回收' && r.ringNo === 'A-10231');
// 已有一条 9-18 自动回收 + 人工挂的 9-19
check('manual attach created recovery', afterAttach.length, 2);
check(
  'manual attach report resolved',
  (await db.reports.get(verifyA.id)).status,
  '已对账',
);
check('manual attach resolvedBy', (await db.reports.get(verifyA.id)).resolvedBy, '人工确认');

/* ---------- 7. 待认领：登记初捕后重新对账自动挂上 ---------- */
const d9Report = (await db.reports.where('status').equals('待认领').toArray())[0];
check('d90001 still pending', d9Report.ringNo, 'D-90001');
await ringStore.addRing({
  ringNo: 'D-90001',
  colorRing: '无',
  speciesCn: '红喉歌鸲',
  speciesSci: 'Calliope calliope',
  age: '亚成',
  ringDate: '2026-05-01T08:00:00.000Z',
  netNo: '2 号网',
  netRound: 1,
  status: '初捕',
  ringer: '郑海',
  siteId: 'site-006',
  sessionId: 'session-002',
});
const recheckResult = await store2.recheck();
check('recheck matched one', recheckResult.matched, 1);
check('d90001 now matched', (await db.reports.get(d9Report.id)).status, '已对账');
await ringStore.hydrate();
check('d90001 recovery exists', ringStore.rings.some((r) => r.ringNo === 'D-90001' && r.status === '回收'), true);

// 再 recheck 一次是幂等的（已对账的不会重复处理）
const recheckAgain = await store2.recheck();
check('recheck idempotent', recheckAgain.matched, 0);

/* ---------- 8. 人工认领（待认领，直接 attach 到初捕） ---------- */
const foreign = `外地通报
E-55555，黄鹡鸰，2026年9月22日，青岛环志站回收。`;
await store2.importBulletin(foreign);
const eReport = (await db.reports.where('status').equals('待认领').toArray()).find((r) => r.ringNo === 'E-55555');
check('E ring pending claim', !!eReport, true);
const eInitial = await ringStore.addRing({
  ringNo: 'E-55555',
  colorRing: '无',
  speciesCn: '黄鹡鸰',
  speciesSci: 'Motacilla tschutschensis',
  age: '幼',
  ringDate: '2026-06-01T08:00:00.000Z',
  netNo: '6 号网',
  netRound: 4,
  status: '初捕',
  ringer: '韩雪',
  siteId: 'site-001',
  sessionId: 'session-004',
});
await store2.attach(eReport.id, eInitial.record.id);
check('manual claim resolved', (await db.reports.get(eReport.id)).resolvedBy, '人工认领');

/* ---------- 9. 删除通报连带回收记录，不影响初捕 ---------- */
const initialCount = await db.rings.where('status').equals('初捕').count();
const removed = await store2.removeReport(d9Report.id);
check('remove linked recoveries count', removed, 1);
check('initial records intact after remove', await db.rings.where('status').equals('初捕').count(), initialCount);
check('report removed', await db.reports.get(d9Report.id), undefined);

/* ---------- 10. 跨通报重报同一环号同一天：不重复生成 ---------- */
const reReport = `另一份通报（转发件）
A-10231，红喉歌鸲，2026年9月18日，在崇明东滩保护站回收（转发核实）。`;
const cross = await store2.importBulletin(reReport);
check('cross-bulletin matched', cross.matched, 1);
check('cross-bulletin no duplicate ring', cross.createdRings, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
