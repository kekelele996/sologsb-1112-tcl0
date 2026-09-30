import { SPECIES_CATALOG } from './stats';

/** 解析出的单条通报（字段均可空，环号必有） */
export interface ParsedEntry {
  ringNo: string;
  speciesCn?: string;
  /** 回收日期 ISO */
  recoveryDate?: string;
  reportSite?: string;
  /** 该条原文片段（展示用） */
  raw: string;
}

export interface ParsedNotice {
  /** 通报层面来报站点（条目内站点优先） */
  reportSite?: string;
  entries: ParsedEntry[];
}

/** 金属环号：字母前缀 + 横线（含全角－）+ 至少 3 位数字，如 A-10231、B-20512 */
const RING_NO_RE = /[A-Za-z][-－]\d{3,}/g;
const RING_NO_ONE = /[A-Za-z][-－]\d{3,}/;

/** 日期：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 */
const DATE_RE = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/;

function toIsoDate(y: string, m: string, d: string): string {
  const mm = m.padStart(2, '0');
  const dd = d.padStart(2, '0');
  return new Date(`${y}-${mm}-${dd}T00:00:00`).toISOString();
}

/** 去掉站点尾部误带的动词（回收 / 放飞 / 捕获 / 环志） */
function cleanSite(value: string): string {
  return value.replace(/(回收|放飞|捕获|环志|站)$/g, '').trim();
}

/** 从片段中提取鸟种：先取「鸟种：」标注，再在鸟种目录里按最长中文名匹配 */
function extractSpecies(block: string): string | undefined {
  const labeled = block.match(/鸟种[：:]\s*([^\n，,。;；]+)/);
  if (labeled) return labeled[1].trim();
  const names = [...SPECIES_CATALOG].sort((a, b) => b.cn.length - a.cn.length);
  for (const item of names) {
    if (block.includes(item.cn)) return item.cn;
  }
  return undefined;
}

function extractDate(block: string): string | undefined {
  const m = block.match(DATE_RE);
  return m ? toIsoDate(m[1], m[2], m[3]) : undefined;
}

/** 从来报站点：先取标注字段，再取「于/在 + 地点 + 回收/放飞」格式 */
function extractSite(block: string): string | undefined {
  const labeled = block.match(/(来报站点|报站点|回收站点|回收地点|地点|站点)[：:]\s*([^\n，,。;；]+)/);
  if (labeled) return cleanSite(labeled[2]);
  const m = block.match(/[于在]([^\n，,。;；]{2,15}?)(?:回收|放飞|捕获)/);
  return m ? cleanSite(m[1]) : undefined;
}

/**
 * 解析回收通报原文。
 * 以金属环号为界切成片段（每个片段含一个环号及其后到下一环号前的字段），
 * 兼容「一行一条」与「字段逐行」两种通报格式。
 * 未识别到任何环号时抛错（调用方据此把通报落为 failed，可重试）。
 */
export function parseRecoveryNotice(text: string): ParsedNotice {
  const matches = [...text.matchAll(RING_NO_RE)];
  if (matches.length === 0) {
    throw new Error('未在通报中识别到金属环号（形如 A-10231），请核对粘贴内容');
  }

  const entries: ParsedEntry[] = matches.map((match, i) => {
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const block = text.slice(start, end);
    const ringNo = (block.match(RING_NO_ONE)?.[0] ?? match[0]).toUpperCase();
    return {
      ringNo,
      speciesCn: extractSpecies(block),
      recoveryDate: extractDate(block),
      reportSite: extractSite(block),
      raw: block.trim(),
    };
  });

  // 通报层面来报站点（取第一个标注字段）
  const noticeSite = text.match(/(来报站点|报站点|回收站点|回收地点)[：:]\s*([^\n，,。;；]+)/);
  const reportSite = noticeSite ? cleanSite(noticeSite[2]) : undefined;

  return { reportSite, entries };
}
