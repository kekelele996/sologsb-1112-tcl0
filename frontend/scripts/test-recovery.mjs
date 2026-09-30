import { parseBulletin, normalizeRingNo, parseRecoveryDate, parseReportSite, parseSpecies, sourceFingerprint } from '../src/utils/recovery.ts';
import { matchRecoveryItem } from '../src/utils/reconcile.ts';

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

/* 归一化 */
check('normalize A-10231', normalizeRingNo('a 10231'), 'A-10231');
check('normalize dot', normalizeRingNo('b.20511'), 'B-20511');

/* 日期 */
check('date cn', parseRecoveryDate('2026年9月18日在崇明回收', 2026).slice(0, 10), '2026-09-18');
check('date iso', parseRecoveryDate('2026-09-15发现', 2026).slice(0, 10), '2026-09-15');
check('date md fallback year', parseRecoveryDate('9月10日重捕', 2026).slice(0, 10), '2026-09-10');
check('date invalid', parseRecoveryDate('2026年13月40日', 2026), '');

/* 站点 */
check('site protect', parseReportSite('在崇明东滩保护站回收'), '崇明东滩');
check('site huanzhi', parseReportSite('青岛环志站回收'), '青岛');
check('site monitor', parseReportSite('条子泥监测点发现死亡个体'), '条子泥');
check('site prep', parseReportSite('由盘锦湿地环志站回收上报'), '盘锦湿地');
check('site none', parseReportSite('环号清晰鸟况良好'), '');

/* 鸟种 */
check('species catalog', parseSpecies('红喉歌鸲2026年回收'), '红喉歌鸲');
check('species fallback suffix', parseSpecies('某地发现一只蓝翡翠死亡'), '蓝翡翠');

/* 整段通报解析 */
const sample = `全国鸟类环志中心回捕通报（2026 年 9 月）
各环志站：
现将近期各地回收情况通报如下。
A-10231，红喉歌鸲，2026年9月18日，在崇明东滩保护站回收，环号清晰，鸟况良好。
B-20512，大山雀，2026-09-15，条子泥监测点发现死亡个体。
A-10232，黄眉柳莺，2026年9月12日，青岛环志站回收。
D-90001，红喉歌鸲，2026年9月20日，由盘锦湿地环志站回收上报。
A-10241，黑腹滨鹬，9月10日，在闽江口观鸟点重捕。
请有关站点核对后反馈。
全国鸟类环志中心`;

const items = parseBulletin(sample);
check('parsed count', items.length, 5);
check('first ring', items[0].ringNo, 'A-10231');
check('first species', items[0].speciesCn, '红喉歌鸲');
check('first date', items[0].recoveryDate.slice(0, 10), '2026-09-18');
check('first site', items[0].reportSite, '崇明东滩');
check('second site', items[1].reportSite, '条子泥');
check('md date gets header year', items[4].recoveryDate.slice(0, 10), '2026-09-10');
check('snippet', items[0].snippet.includes('A-10231'), true);

/* 无环号抛错 */
let threw = false;
try {
  parseBulletin('这段文字里没有任何环号，请查收。');
} catch {
  threw = true;
}
check('no ring throws', threw, true);

/* 同段去重：同环号出现两次只解析一次 */
const dupItems = parseBulletin('A-10231 红喉歌鸲 9月1日回收。环号 A-10231 再次确认。');
check('same ring once', dupItems.length, 1);

/* 指纹：空白差异不影响 */
check('fingerprint whitespace', sourceFingerprint('A-10231 回收') === sourceFingerprint('A-10231回收\n'), true);
check('fingerprint content diff', sourceFingerprint('A-10231 回收') === sourceFingerprint('A-10232 回收'), false);

/* 对账：本地初捕 */
const initial = {
  id: 'r1',
  ringNo: 'A-10231',
  colorRing: '无',
  speciesCn: '红喉歌鸲',
  speciesSci: 'Calliope calliope',
  age: '成',
  ringDate: '2026-08-01T08:00:00.000Z',
  netNo: '1 号网',
  netRound: 1,
  status: '初捕',
  ringer: '韩雪',
  siteId: 's1',
  sessionId: 'ss1',
};

check('matched', matchRecoveryItem(items[0], [initial]).status, '已对账');
check(
  'species mismatch -> verify',
  matchRecoveryItem(items[1], [initial]).status, // B-20512 查无
  '待认领',
);
// 同环号但鸟种不符
const wrongSpecies = { ...items[0], ringNo: 'A-10231', speciesCn: '麻雀' };
check('species mismatch verify', matchRecoveryItem(wrongSpecies, [initial]).status, '待核实');
// 回收日期早于初捕
const earlyDate = { ...items[0], ringNo: 'A-10231', recoveryDate: '2026-07-01T04:00:00.000Z' };
check('date before initial verify', matchRecoveryItem(earlyDate, [initial]).status, '待核实');
// 只有重捕没有初捕
const recaptureOnly = { ...initial, status: '重捕', id: 'r2' };
check('no initial verify', matchRecoveryItem(items[0], [recaptureOnly]).status, '待核实');
// 查无此环
check('unknown ring unclaimed', matchRecoveryItem(items[3], [initial]).status, '待认领');
// 缺日期 -> 待核实
const noDate = { ...items[0], ringNo: 'A-10231', recoveryDate: '' };
check('missing date verify', matchRecoveryItem(noDate, [initial]).status, '待核实');
// 缺鸟种但日期有效 -> 已对账
const noSpecies = { ...items[0], ringNo: 'A-10231', speciesCn: '' };
check('missing species but date ok', matchRecoveryItem(noSpecies, [initial]).status, '已对账');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
