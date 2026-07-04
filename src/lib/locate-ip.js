const CACHE_KEY = 'taocan:ip-province';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const regionToProvince = {
  Beijing: '北京',
  Shanghai: '上海',
  Tianjin: '天津',
  Chongqing: '重庆',
  Guangdong: '广东',
  Zhejiang: '浙江',
  Jiangsu: '江苏',
  Sichuan: '四川',
  Hubei: '湖北',
  Hunan: '湖南',
  Henan: '河南',
  Hebei: '河北',
  Shandong: '山东',
  Shanxi: '山西',
  Shaanxi: '陕西',
  Liaoning: '辽宁',
  Jilin: '吉林',
  Heilongjiang: '黑龙江',
  Anhui: '安徽',
  Fujian: '福建',
  Jiangxi: '江西',
  Guangxi: '广西',
  Guizhou: '贵州',
  Yunnan: '云南',
  Hainan: '海南',
  Gansu: '甘肃',
  Qinghai: '青海',
  Ningxia: '宁夏',
  'Inner Mongolia': '内蒙古',
  Tibet: '西藏',
  Xizang: '西藏',
  Xinjiang: '新疆',
};

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { province, detectedAt } = JSON.parse(raw);
    if (Date.now() - detectedAt > CACHE_TTL_MS) return null;
    return province;
  } catch {
    return null;
  }
}

function writeCache(province) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ province, detectedAt: Date.now() }));
  } catch {}
}

async function detectByIp() {
  try {
    const res = await fetch('https://ipinfo.io/json');
    if (!res.ok) return null;
    const data = await res.json();
    if (data.country !== 'CN') return null;
    return regionToProvince[data.region] || null;
  } catch {
    return null;
  }
}

export async function resolveUserProvince() {
  const cached = readCache();
  if (cached) return { province: cached, source: 'cache' };
  const province = await detectByIp();
  if (province) {
    writeCache(province);
    return { province, source: 'ip' };
  }
  return { province: null, source: 'none' };
}
