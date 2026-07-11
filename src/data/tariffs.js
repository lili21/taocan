export const provinceCenters = {
  北京: [39.9042, 116.4074],
  上海: [31.2304, 121.4737],
  天津: [39.3434, 117.3616],
  重庆: [29.563, 106.5516],
  广东: [23.1291, 113.2644],
  浙江: [30.2741, 120.1551],
  江苏: [32.0603, 118.7969],
  四川: [30.5728, 104.0668],
  湖北: [30.5928, 114.3055],
  湖南: [28.2282, 112.9388],
  河南: [34.7655, 113.7536],
  河北: [38.0428, 114.5149],
  山东: [36.6683, 117.0204],
  山西: [37.8706, 112.5489],
  陕西: [34.3416, 108.9398],
  辽宁: [41.8057, 123.4315],
  吉林: [43.8171, 125.3235],
  黑龙江: [45.8038, 126.5349],
  安徽: [31.8206, 117.2272],
  福建: [26.0745, 119.2965],
  江西: [28.6829, 115.8582],
  广西: [22.817, 108.3669],
  贵州: [26.647, 106.6302],
  云南: [25.0453, 102.7097],
  海南: [20.044, 110.1999],
  甘肃: [36.0611, 103.8343],
  青海: [36.6232, 101.7782],
  宁夏: [38.4872, 106.2309],
  内蒙古: [40.8426, 111.7492],
  西藏: [29.652, 91.1721],
  新疆: [43.8256, 87.6168],
};

export const operators = {
  cmcc: {
    label: '中国移动',
    shortLabel: '移动',
    servicePhone: '10086',
    sourceUrl: 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html',
    dataRoot: '/data',
  },
  unicom: {
    label: '中国联通',
    shortLabel: '联通',
    servicePhone: '10010',
    sourceUrl: 'https://img.client.10010.com/zifeizhuanquwt/index.html',
    dataRoot: '/data/unicom',
  },
  telecom: {
    label: '中国电信',
    shortLabel: '电信',
    servicePhone: '10000',
    sourceUrl: 'https://www.189.cn/jtzfzq/',
    dataRoot: '/data/telecom',
  },
};

export async function fetchTariffIndex(operator) {
  const res = await fetch(`${operators[operator].dataRoot}/index.json`);
  if (!res.ok) throw new Error(`index.json: ${res.status}`);
  return res.json();
}

export async function fetchNationalPlans(operator) {
  const res = await fetch(`${operators[operator].dataRoot}/national.json`);
  if (!res.ok) throw new Error(`national.json: ${res.status}`);
  const data = await res.json();
  return data.plans.map((plan) => ({ operator, ...plan }));
}

export async function fetchProvincePlans(operator, province) {
  const res = await fetch(`${operators[operator].dataRoot}/${encodeURIComponent(province)}.json`);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`${province}.json: ${res.status}`);
  }
  const data = await res.json();
  return data.plans.map((plan) => ({ operator, ...plan }));
}
