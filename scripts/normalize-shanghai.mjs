import fs from 'node:fs/promises';
import path from 'node:path';

const pagesDir = '/tmp/sh-pages';
const publicDataDir = path.resolve('public/data');
const rawPath = path.resolve('src/data/cmcc-tariffs-shanghai-raw.json');

function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function text(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeItem(item, beanName) {
  const price = num(item.fees);
  const generalData = num(item.data);
  const directedData = num(item.orientTraffic);
  const name = text(item.name);
  const reportNo = text(item.reportNo);
  const seqno = text(item.seqno);
  const id = `cmcc-shanghai-${reportNo || seqno || item.id}`.replace(/\s+/g, '-');

  return {
    id,
    name,
    area: '上海',
    price,
    data: Math.round((generalData + directedData) * 10) / 10,
    generalData,
    directedData,
    voice: num(item.call),
    sms: text(item.sms) || '详见详情',
    broadband: text(item.brandwidth) || '详见详情',
    audience: text(item.applicablePeople) || '详见详情',
    contract: [text(item.validPeriod), text(item.duration)].filter(Boolean).join('；') || '详见详情',
    source: '中国移动资费公示专区',
    tags: [beanName, item.tariffName].filter(Boolean),
    details: {
      schemeId: reportNo,
      tariffStandard: price ? `${price}${text(item.feesUnit) || '元/月'}` : '详见详情',
      applicableArea: text(item.applicablePeople) || '',
      salesChannel: text(item.channel),
      onlineDate: text(item.onlineDay),
      offlineDate: text(item.offineDay),
      validity: text(item.validPeriod),
      networkRequirement: text(item.duration),
      cancelMethod: text(item.unsubscribe),
      liability: text(item.responsibility),
      overage: [text(item.extraFees), text(item.otherFees)].filter(Boolean).join('\n'),
      services: [text(item.rights), text(item.otherContent)].filter(Boolean).join('\n'),
      notes: text(item.others),
      category: beanName,
      tariffCode: text(item.tariffCode),
    },
  };
}

async function main() {
  const files = (await fs.readdir(pagesDir)).sort();
  const allItems = [];
  const rawResponses = [];

  for (const f of files) {
    const raw = await fs.readFile(path.join(pagesDir, f), 'utf8');
    rawResponses.push(JSON.parse(raw));
    const o = JSON.parse(raw);
    const beans = o.data?.beans ?? [];
    for (const bean of beans) {
      const beanName = bean.tariffName;
      for (const nm of (bean.nonModuleList ?? [])) {
        allItems.push(normalizeItem(nm, beanName));
      }
      for (const m of (bean.moduleList ?? [])) {
        for (const tl of (m.tariffList ?? [])) {
          allItems.push(normalizeItem(tl, beanName));
        }
      }
    }
  }

  // 去重（按 name+price+reportNo）
  const seen = new Set();
  const plans = allItems.filter((p) => {
    const key = `${p.name}|${p.price}|${p.details.schemeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).filter((p) => p.name && p.price > 0).sort((a, b) => a.price - b.price || b.data - a.data);

  console.log(`total raw items: ${allItems.length}, unique plans: ${plans.length}`);

  await fs.mkdir(publicDataDir, { recursive: true });
  await fs.writeFile(
    path.join(publicDataDir, '上海.json'),
    `${JSON.stringify({ scope: 'province', province: '上海', planCount: plans.length, plans }, null, 2)}\n`,
  );
  await fs.writeFile(rawPath, `${JSON.stringify({ fetchedAt: new Date().toISOString(), pages: rawResponses }, null, 2)}\n`);

  console.log(`Wrote public/data/上海.json (${plans.length} plans)`);
  console.log(`Wrote ${rawPath}`);

  // 打印所有套餐名
  for (const p of plans) {
    console.log(`  ¥${p.price}  ${p.name}  通用${p.generalData}GB 定向${p.directedData}GB 通话${p.voice}分钟`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
