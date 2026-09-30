import { SPECIES_CATALOG } from './stats';

/** 通报中解析出的单个环号原始信息（尚未对账） */
export interface ParsedRecoveryItem {
  ringNo: string;
  speciesCn: string;
  recoveryDate: string;
  reportSite: string;
  snippet: string;
}

/* ---------------------------------- 环号 ---------------------------------- */

/** 金属环号：带前缀（A-10231 / B 20511 / C.30103）或 6~10 位裸号（123456） */
const RING_NO_REG = /(?:[A-Za-z]{1,2}\s*[-.．]?\s*[0-9]{4,10}|\b[0-9]{6,10}\b)/g;
/** 8 位日期数字（20260918）不是环号 */
const DATE_8_REG = /^\d{8}$/;
/** 从片段中直接取「前缀-序号」形态的环号 */
const RING_NO_STRICT_REG = /[A-Za-z]{1,2}\s*[-.．]?\s*[0-9]{4,10}/g;

/** 环号归一化：去空格 / 统一连字符 / 转大写（A 10231、b.20511 均归为 A-10231 / B-20511） */
export function normalizeRingNo(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[．.]/g, '');
  return compact.replace(/^([A-Z]{1,2})-?(\d{4,10})$/, '$1-$2');
}

interface RingMatch {
  no: string;
  start: number;
  end: number;
}

function extractRingMatches(text: string): RingMatch[] {
  const strict = Array.from(text.matchAll(RING_NO_STRICT_REG)).map((m) => ({
    no: normalizeRingNo(m[0]),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  if (strict.length > 0) return strict;
  return Array.from(text.matchAll(RING_NO_REG))
    .filter((m) => !DATE_8_REG.test(m[0].trim()))
    .map((m) => ({
      no: normalizeRingNo(m[0]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }));
}

/* ---------------------------------- 日期 ---------------------------------- */

const FULL_DATE_REG = /(20\d{2})\s*[年\-/.．]\s*(\d{1,2})\s*月?\s*[\-/.．]?\s*(\d{1,2})\s*日?/;
const CN_DATE_REG = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/;

/** 解析回收日期为本地 12:00 的 ISO；无年份时用 fallbackYear；非法日期返回空串 */
export function parseRecoveryDate(text: string, fallbackYear?: number): string {
  const full = text.match(FULL_DATE_REG);
  if (full) {
    return buildIso(Number(full[1]), Number(full[2]), Number(full[3]));
  }
  const cn = text.match(CN_DATE_REG);
  if (cn && fallbackYear) {
    return buildIso(fallbackYear, Number(cn[1]), Number(cn[2]));
  }
  return '';
}

function buildIso(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime()) || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== iso) {
    return '';
  }
  return d.toISOString();
}

/* ---------------------------------- 鸟种 ---------------------------------- */

/** 常见鸟种后缀，用于兜底提取目录外鸟种（两个捕获组分别取前缀字与后缀） */
const SPECIES_SUFFIX_REG =
  /([一-鿿]{1,4}?)(歌鸲|柳莺|杓鹬|滨鹬|鹡鸰|山雀|鸦雀|苇鹀|白眉鹀|鹀|鸲|鹬|鹳|雀|莺|雁|鸭|鸥|鹭|雕|隼|翡翠|伯劳|鸫|鹎|燕|鸦)/g;
/** 捕获组里可能带入的动词 / 量词 / 指示词，剥掉后才是鸟种名 */
const SPECIES_LEAD_NOISE =
  /^(?:在|于|由|有|的|地|了|是|为|现|见|看|捡|发|只|一|几|这|那|发现|见到|看见|回收|重捕|捕获|一只|几只|这只|那只)+/;

function extractSuffixSpecies(text: string): string {
  const hits = Array.from(text.matchAll(SPECIES_SUFFIX_REG), (m) => (m[1] + m[2]).replace(SPECIES_LEAD_NOISE, ''));
  return hits.map((s) => s.trim()).find((s) => s.length >= 2) ?? '';
}

/** 去掉片段中容易被误识别为鸟种的站点 / 日期 / 环号文字 */
function stripNonSpecies(text: string): string {
  return text
    .replace(/(全国|中国|国家|鸟类)?环志(中心|站|管理站)/g, '')
    .replace(/自然保护[区站]/g, '')
    .replace(/鸟类[栖息保护]*(管理区|地|区)?/g, '')
    .replace(/野生动物园/g, '')
    .replace(RING_NO_REG, '')
    .replace(FULL_DATE_REG, '')
    .replace(CN_DATE_REG, '');
}

export function parseSpecies(text: string): string {
  const cleaned = stripNonSpecies(text);
  const catalogHit = SPECIES_CATALOG.find((s) => cleaned.includes(s.cn));
  if (catalogHit) return catalogHit.cn;
  return extractSuffixSpecies(cleaned);
}

/* ---------------------------------- 站点 ---------------------------------- */

/** 站点关键词附近的名称（崇明东滩保护站、青岛环志站、条子泥监测点 …） */
const SITE_NEAR_KEYWORD_REG =
  /([一-龥A-Za-z0-9]{2,18}?)(?:鸟类)?(?:国家级|省级)?(?:自然保护[区站]|保护[区站]|环志站|监测点|观测点|管理站|鸟类环志中心|环志中心|野生动物保护站|救护中心|动物园)/g;
/** 「在/由/经/来自 + 地名」 */
const SITE_PREP_REG = /(?:在|由|经|来自|于)([一-鿿]{2,12}?)(?:回收|重捕|发现|捕获|上报|通报|，|。|；|、|\s)/g;
const LABEL_REG = /^(?:地点|站点|回收地点|上报站点|发现地点|回收于|发现于|在|由|经|来自|于)[:：\s]*/;
/** 上级发文单位 / 泛称不是具体上报站点 */
const STOP_WORDS = ['我站', '本站', '当地', '附近', '野外', '此处', '全国', '中国', '国家', '中心', '环志'];

function trimSiteName(raw: string): string {
  let name = raw.replace(LABEL_REG, '').trim();
  name = name.replace(/[，。；、：:,.\s]+$/g, '').trim();
  if (STOP_WORDS.includes(name)) return '';
  return name;
}

export function parseReportSite(text: string): string {
  // 非贪婪正则会给出长短不一的候选（如「东滩」/「崇明东滩」），取最长的合法地名
  const keywordHits = Array.from(text.matchAll(SITE_NEAR_KEYWORD_REG), (m) => trimSiteName(m[1])).filter(
    (name) => name.length >= 2,
  );
  if (keywordHits.length > 0) {
    return keywordHits.sort((a, b) => b.length - a.length)[0];
  }
  const prepHits = Array.from(text.matchAll(SITE_PREP_REG), (m) => trimSiteName(m[1]));
  return prepHits.find((name) => name.length >= 2 && !STOP_WORDS.includes(name)) ?? '';
}

/* --------------------------------- 整段解析 -------------------------------- */

const SENTENCE_SPLIT_REG = /[。；;\n\r]+/;

/** 通报指纹：去掉所有空白后哈希（只改空格/换行不算新通报） */
export function sourceFingerprint(text: string): string {
  const normalized = text.replace(/\s+/g, '');
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `fp-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

/**
 * 解析一段回捕通报为逐条环号信息。
 * 按句号 / 分号 / 换行分句；含环号的句子以环号位置切窗——每个环号取上一个环号
 * 结束位置到下一个环号起始位置之间的文本，因此「环号，鸟种，日期，站点」这种
 * 逗号分隔的同句多条记录不会被拦腰截断。缺失字段由通报抬头句兜底。
 * @throws Error 没有解析出任何金属环号时抛错
 */
export function parseBulletin(text: string): ParsedRecoveryItem[] {
  // 分句（trim 掉空白句）
  const clauses: string[] = text
    .split(SENTENCE_SPLIT_REG)
    .map((c) => c.trim())
    .filter(Boolean);

  // 句序 -> 该句的环号匹配
  const ringRanges = clauses.map((clause) => {
    const matches = extractRingMatches(clause);
    return matches.length > 0 ? matches : undefined;
  });
  const totalRings = ringRanges.reduce((sum, matches) => sum + (matches ? matches.length : 0), 0);

  if (totalRings === 0) {
    throw new Error('通报中没有识别到金属环号（形如 A-10231、B-20511 或 6 位以上数字），请核对原文后重试');
  }

  // 抬头 / 落款等不含环号的句子，提供全局兜底信息
  const headerSites: string[] = [];
  const headerDates: string[] = [];
  let headerYear = new Date().getFullYear();
  const headerSpecies = new Map<string, number>();

  clauses.forEach((clause, index) => {
    if (ringRanges[index]) return;
    const site = parseReportSite(clause);
    if (site) headerSites.push(site);
    const date = parseRecoveryDate(clause);
    if (date) {
      headerDates.push(date);
      headerYear = new Date(date).getFullYear();
    }
    const species = parseSpecies(clause);
    if (species) headerSpecies.set(species, (headerSpecies.get(species) ?? 0) + 1);
  });

  const fallbackSite = headerSites[0] ?? '';
  const fallbackDate = headerDates[headerDates.length - 1] ?? '';
  // 抬头中唯一出现的鸟种可作为兜底（多鸟种通报抬头通常不列鸟种）
  const fallbackSpecies = headerSpecies.size === 1 ? Array.from(headerSpecies.keys())[0] : '';

  const seen = new Set<string>();
  const items: ParsedRecoveryItem[] = [];

  clauses.forEach((clause, clauseIndex) => {
    const matches = ringRanges[clauseIndex];
    if (!matches) return;
    matches.forEach((match, index) => {
      // 窗口：同句上一个环号结束 → 同句下一个环号开始
      const windowStart = index === 0 ? 0 : matches[index - 1].end;
      const windowEnd = index + 1 < matches.length ? matches[index + 1].start : clause.length;
      const context = `${clause.slice(windowStart, match.start)} ${clause.slice(match.end, windowEnd)}`;

      if (seen.has(match.no)) return; // 同段通报内同一环号只挂一次
      seen.add(match.no);
      items.push({
        ringNo: match.no,
        speciesCn: parseSpecies(context) || fallbackSpecies,
        recoveryDate: parseRecoveryDate(context, headerYear) || fallbackDate,
        reportSite: parseReportSite(context) || fallbackSite,
        snippet: clause
          .slice(Math.max(0, match.start - 10), Math.min(clause.length, windowEnd + 10))
          .trim()
          .slice(0, 120),
      });
    });
  });

  return items;
}
