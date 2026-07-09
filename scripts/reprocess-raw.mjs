import fs from 'node:fs/promises';
import path from 'node:path';

const publicDataDir = path.resolve('public/data');
const rawPath = path.resolve('src/data/cmcc-tariffs-raw.json');

const PROVINCES = [
  '安徽','北京','重庆','福建','甘肃','广东','广西','贵州','海南','河北',
  '河南','黑龙江','湖北','湖南','吉林','江苏','江西','辽宁','内蒙古','宁夏',
  '青海','山东','陕西','山西','上海','四川','天津','西藏','新疆','云南','浙江',
];

function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function gb(value, unit) {
  const n = num(value);
  if (n === 0) return 0;
  const u = String(unit || '').toUpperCase().trim();
  if (['GB','G','GB/月','GB/T'].includes(u)) return n;
  if (['MB','M','MB/月','MB/T','MBPS','MBIT','MBIT/S'].includes(u)) return Math.round(n / 1024 * 100) / 100;
  if (['KB','K','KB/月'].includes(u)) return Math.round(n / 1048576 * 100) / 100;
  if (['TB','T'].includes(u)) return n * 1024;
  return n;
}

function text(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeItem(item, beanName, province) {
  const price = num(item.fees);
  const general = gb(item.data, item.dataUnit);
  const directed = gb(item.orientTraffic, item.orientTrafficUnit);
  const name = text(item.name);
  const reportNo = text(item.reportNo);
  const seqno = text(item.seqno);
  const itemId = text(item.id);
  const id = `cmcc-${province}-${reportNo || seqno || itemId}`.replace(/\s+/g, '-');
  return {
    id, name, area: province, price,
    data: Math.round((general + directed) * 10) / 10,
    generalData: general, directedData: directed,
    voice: num(item.call),
    sms: text(item.sms) || '详见详情',
    broadband: text(item.brandwidth) || '详见详情',
    audience: text(item.applicablePeople) || '详见详情',
    contract: [text(item.validPeriod), text(item.duration)].filter(Boolean).join('；') || '详见详情',
    source: '中国移动资费公示专区',
    tags: [beanName, item.tariffName].filter(Boolean),
    details: {
      schemeId: reportNo,
      tariffStandard: price ? `${Number.isInteger(price) ? price : price.toFixed(2)}${text(item.feesUnit) || '元/月'}` : '详见详情',
      applicableArea: text(item.applicablePeople),
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

function extractFromPages(pages, province) {
  const seen = new Set();
  const plans = [];
  for (const page of pages) {
    const beans = page?.data?.beans ?? [];
    for (const bean of beans) {
      const beanName = bean.tariffName || '';
      for (const nm of (bean.nonModuleList ?? [])) {
        const p = normalizeItem(nm, beanName, province);
        const k = `${p.name}|${p.price}|${p.details.schemeId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (p.name && p.price > 0) plans.push(p);
      }
      for (const m of (bean.moduleList ?? [])) {
        for (const tl of (m.tariffList ?? [])) {
          const p = normalizeItem(tl, beanName, province);
          const k = `${p.name}|${p.price}|${p.details.schemeId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (p.name && p.price > 0) plans.push(p);
        }
      }
    }
  }
  return plans;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(rawPath, 'utf8'));
  const provincesData = raw.provinces || raw;

  // 1. 每省：合并全网+本省，归一化
  const byProvince = {};
  for (const prov of PROVINCES) {
    const d = provincesData[prov];
    if (!d) { byProvince[prov] = []; continue; }
    const pages = [...(d.national || []), ...(d.local || [])];
    byProvince[prov] = extractFromPages(pages, prov);
  }

  // 2. 拆分 national / province：按 (name|price) 跨省去重
  const keyToProvinces = new Map();
  const keyToPlan = new Map();
  for (const [prov, plans] of Object.entries(byProvince)) {
    for (const plan of plans) {
      const k = `${plan.name}|${plan.price}`;
      if (!keyToProvinces.has(k)) keyToProvinces.set(k, []);
      keyToProvinces.get(k).push(prov);
      if (!keyToPlan.has(k)) keyToPlan.set(k, plan);
    }
  }

  const nationalPlans = [];
  const provinceOnly = {}; for (const p of PROVINCES) provinceOnly[p] = [];
  for (const [k, provs] of keyToProvinces) {
    const plan = keyToPlan.get(k);
    if (provs.length >= 2) {
      nationalPlans.push({ ...plan, area: '全国' });
    } else {
      provinceOnly[provs[0]].push(plan);
    }
  }
  nationalPlans.sort((a, b) => a.price - b.price || b.data - a.data);

  // 3. 写文件
  await fs.mkdir(publicDataDir, { recursive: true });
  await fs.writeFile(
    path.join(publicDataDir, 'national.json'),
    `${JSON.stringify({ scope: 'national', planCount: nationalPlans.length, plans: nationalPlans }, null, 2)}\n`,
  );

  const provinceEntries = [];
  for (const p of PROVINCES) {
    const plans = provinceOnly[p].sort((a, b) => a.price - b.price || b.data - a.data);
    await fs.writeFile(
      path.join(publicDataDir, `${p}.json`),
      `${JSON.stringify({ scope: 'province', province: p, planCount: plans.length, plans }, null, 2)}\n`,
    );
    provinceEntries.push({ province: p, planCount: plans.length });
  }

  await fs.writeFile(
    path.join(publicDataDir, 'index.json'),
    `${JSON.stringify({
      sourceUrl: 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html',
      fetchedAt: raw.fetchedAt || new Date().toISOString(),
      provinceCount: PROVINCES.length,
      nationalPlanCount: nationalPlans.length,
      planCount: nationalPlans.length + provinceEntries.reduce((s, e) => s + e.planCount, 0),
      provinces: provinceEntries.sort((a, b) => a.province.localeCompare(b.province, 'zh-Hans-CN')),
    }, null, 2)}\n`,
  );

  console.log(`national: ${nationalPlans.length}`);
  for (const e of provinceEntries) console.log(`  ${e.province}: ${e.planCount}`);
  console.log(`total: ${nationalPlans.length + provinceEntries.reduce((s, e) => s + e.planCount, 0)}`);

  // 4. 验证关键套餐
  const natNames = nationalPlans.map(p => p.name);
  const must = ['骑士卡39','骑士卡59','动感地带芒果卡-59元档','动感地带抖音联名卡-59元档','动感地带·大萌卡','智臻会员299档（B版）'];
  console.log('\n--- verify ---');
  for (const m of must) console.log(natNames.includes(m) ? 'OK' : 'MISS', m);

  // 5. 验证 MB 修复
  const bj = provinceOnly['北京'] || [];
  const fujian = provinceOnly['福建'] || [];
  const fjsame = [...nationalPlans, ...fujian];
  const aixin = fjsame.find(p => p.name.includes('爱心卡（流量版）'));
  console.log('爱心卡（流量版）:', aixin ? `${aixin.generalData}GB+${aixin.directedData}GB` : 'not found');
  const feixiang = bj.find(p => p.name.includes('18元飞享套餐副卡版'));
  console.log('18元飞享套餐副卡版:', feixiang ? `${feixiang.generalData}GB` : 'not found');
}

main().catch((e) => { console.error(e); process.exit(1); });
