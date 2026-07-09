import fs from 'node:fs/promises';
import path from 'node:path';

const publicDataDir = path.resolve('public/data');
const PROVINCES = [
  '安徽','北京','重庆','福建','甘肃','广东','广西','贵州','海南','河北',
  '河南','黑龙江','湖北','湖南','吉林','江苏','江西','辽宁','内蒙古','宁夏',
  '青海','山东','陕西','山西','上海','四川','天津','西藏','新疆','云南','浙江',
];

async function main() {
  // 读所有省
  const byProvince = {};
  for (const p of PROVINCES) {
    byProvince[p] = JSON.parse(await fs.readFile(path.join(publicDataDir, `${p}.json`), 'utf8'));
  }

  // 统计每个 (name|price) 出现在哪些省
  const keyToProvinces = new Map();
  const keyToPlan = new Map();
  for (const [prov, data] of Object.entries(byProvince)) {
    for (const plan of data.plans) {
      const k = `${plan.name}|${plan.price}`;
      if (!keyToProvinces.has(k)) keyToProvinces.set(k, []);
      keyToProvinces.get(k).push(prov);
      if (!keyToPlan.has(k)) keyToPlan.set(k, plan);
    }
  }

  // 拆分：>=2 省 → national；==1 省 → province
  const nationalPlans = [];
  const provinceOnly = {}; for (const p of PROVINCES) provinceOnly[p] = [];
  for (const [k, provs] of keyToProvinces) {
    const plan = keyToPlan.get(k);
    if (provs.length >= 2) {
      // 全国号卡
      nationalPlans.push({ ...plan, area: '全国' });
    } else {
      provinceOnly[provs[0]].push(plan);
    }
  }
  nationalPlans.sort((a, b) => a.price - b.price || b.data - a.data);

  // 写 national.json
  await fs.writeFile(
    path.join(publicDataDir, 'national.json'),
    `${JSON.stringify({ scope: 'national', planCount: nationalPlans.length, plans: nationalPlans }, null, 2)}\n`,
  );
  console.log(`national.json: ${nationalPlans.length} plans`);

  // 写各省 json（只保留本省专属）
  const provinceEntries = [];
  for (const p of PROVINCES) {
    const plans = provinceOnly[p].sort((a, b) => a.price - b.price || b.data - a.data);
    await fs.writeFile(
      path.join(publicDataDir, `${p}.json`),
      `${JSON.stringify({ scope: 'province', province: p, planCount: plans.length, plans }, null, 2)}\n`,
    );
    provinceEntries.push({ province: p, planCount: plans.length });
  }

  // 写 index.json
  await fs.writeFile(
    path.join(publicDataDir, 'index.json'),
    `${JSON.stringify({
      sourceUrl: 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html',
      fetchedAt: new Date().toISOString(),
      provinceCount: PROVINCES.length,
      nationalPlanCount: nationalPlans.length,
      planCount: nationalPlans.length + provinceEntries.reduce((s, e) => s + e.planCount, 0),
      provinces: provinceEntries.sort((a, b) => a.province.localeCompare(b.province, 'zh-Hans-CN')),
    }, null, 2)}\n`,
  );
  console.log(`index.json: national=${nationalPlans.length}, provinces total=${provinceEntries.reduce((s,e)=>s+e.planCount,0)}`);
  for (const e of provinceEntries) console.log(`  ${e.province}: ${e.planCount}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
