#!/usr/bin/env python3
"""
通过 Chrome DevTools Protocol 抓取中国移动资费公示专区全部 31 省的套餐数据。
前置：Chrome 已用 --remote-debugging-port=9222 --remote-allow-origins=* 启动。
用法：python3 scripts/fetch-cmcc-tariffs-cdp.py
"""
import json, urllib.request, urllib.parse, websocket, time, os, sys, threading

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222
PAGE_URL = "https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html"
PUBLIC_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")
RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "data")

PROVINCES = [
    "安徽","北京","重庆","福建","甘肃","广东","广西","贵州","海南","河北",
    "河南","黑龙江","湖北","湖南","吉林","江苏","江西","辽宁","内蒙古","宁夏",
    "青海","山东","陕西","山西","上海","四川","天津","西藏","新疆","云南","浙江",
]
# 页面 select-item 文本带"市/省"后缀
def province_matcher(p):
    return lambda txt: p in txt and ("市" in txt or "省" in txt or p in txt)

def num(v):
    if v is None or v == "": return 0
    try: return float(v)
    except: return 0
    return 0

def gb(value, unit):
    """把 value+unit 转成 GB。单位：GB直接用，MB/Mb/M 除1024，KB除1048576，TB乘1024。"""
    n = num(value)
    if n == 0: return 0
    u = str(unit or "").upper().strip()
    if u in ("GB", "G", "GB/月", "GB/T"):
        return n
    if u in ("MB", "M", "MB/月", "MB/T", "MBPS"):
        return round(n / 1024 * 100) / 100
    if u in ("MB2", "MBIT", "MBIT/S"):
        # 数据源里 Mb 实际指 MB，当 MB 处理
        return round(n / 1024 * 100) / 100
    if u in ("KB", "K", "KB/月"):
        return round(n / 1048576 * 100) / 100
    if u in ("TB", "T"):
        return n * 1024
    # 无单位假定 GB
    return n

def text(v):
    if v is None: return ""
    return str(v).strip()

def normalize_item(item, bean_name, province):
    price = num(item.get("fees"))
    general = gb(item.get("data"), item.get("dataUnit"))
    directed = gb(item.get("orientTraffic"), item.get("orientTrafficUnit"))
    name = text(item.get("name"))
    report_no = text(item.get("reportNo"))
    seqno = text(item.get("seqno"))
    item_id = text(item.get("id"))
    pid = f"cmcc-{province}-{report_no or seqno or item_id}".replace(" ", "-")
    return {
        "id": pid,
        "name": name,
        "area": province,
        "price": price,
        "data": round((general + directed) * 10) / 10,
        "generalData": general,
        "directedData": directed,
        "voice": num(item.get("call")),
        "sms": text(item.get("sms")) or "详见详情",
        "broadband": text(item.get("brandwidth")) or "详见详情",
        "audience": text(item.get("applicablePeople")) or "详见详情",
        "contract": "；".join([text(item.get("validPeriod")), text(item.get("duration"))]).strip("；") or "详见详情",
        "source": "中国移动资费公示专区",
        "tags": [bean_name, item.get("tariffName")],
        "details": {
            "schemeId": report_no,
            "tariffStandard": f"{int(price) if price == int(price) else price}{text(item.get('feesUnit')) or '元/月'}" if price else "详见详情",
            "applicableArea": text(item.get("applicablePeople")),
            "salesChannel": text(item.get("channel")),
            "onlineDate": text(item.get("onlineDay")),
            "offlineDate": text(item.get("offineDay")),
            "validity": text(item.get("validPeriod")),
            "networkRequirement": text(item.get("duration")),
            "cancelMethod": text(item.get("unsubscribe")),
            "liability": text(item.get("responsibility")),
            "overage": "\n".join([text(item.get("extraFees")), text(item.get("otherFees"))]).strip(),
            "services": "\n".join([text(item.get("rights")), text(item.get("otherContent"))]).strip(),
            "notes": text(item.get("others")),
            "category": bean_name,
            "tariffCode": text(item.get("tariffCode")),
        },
    }

class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, max_size=None)
        self.mid = 0
        self.lock = threading.Lock()

    def send(self, method, params=None):
        with self.lock:
            self.mid += 1
            mid = self.mid
            self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                m = json.loads(self.ws.recv())
                if m.get("id") == mid:
                    return m

    def ev(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return r.get("result", {}).get("result", {}).get("value")

def get_targets():
    return json.load(urllib.request.urlopen(f"http://{CDP_HOST}:{CDP_PORT}/json"))

def new_tab(url):
    ver = json.load(urllib.request.urlopen(f"http://{CDP_HOST}:{CDP_PORT}/json/version"))
    bws = websocket.create_connection(ver["webSocketDebuggerUrl"], max_size=None)
    bmid = 0
    def bsend(method, params=None):
        nonlocal bmid; bmid += 1
        bws.send(json.dumps({"id": bmid, "method": method, "params": params or {}}))
        while True:
            m = json.loads(bws.recv())
            if m.get("id") == bmid: return m
    r = bsend("Target.createTarget", {"url": url})
    return r["result"]["targetId"]

def install_hook(cdp):
    """装 JSON.parse hook，捕获解密后含 'beans' 的明文响应。"""
    cdp.ev("""
    (function(){
      window.__cap = [];
      window.__capKeys = new Set();
      var orig = JSON.parse;
      JSON.parse = function(t){
        var r = orig.apply(this, arguments);
        try {
          if (typeof t === 'string' && t.length > 1500 && t.indexOf('"beans"') > -1 && window.__cap.length < 200) {
            var key = t.slice(0, 300);
            if (!window.__capKeys.has(key)) {
              window.__capKeys.add(key);
              window.__cap.push({len: t.length, text: t});
            }
          }
        } catch(e){}
        return r;
      };
      return 'installed';
    })()
    """)

def reset_cap(cdp):
    cdp.ev("window.__cap = []; window.__capKeys = new Set();")

def click_province(cdp, province):
    """点击地区 select-item。"""
    return cdp.ev(f"""
    (function(){{
      var items = Array.from(document.querySelectorAll('.select-item'));
      var target = items.find(e => e.innerText.indexOf('{province}') > -1);
      if (!target) return 'not found';
      target.click();
      return 'clicked: ' + target.innerText.trim();
    }})()
    """)

def click_tab(cdp, text_pattern):
    """点击含指定文本的 tab/tipsText（资费类型: 套餐）。"""
    return cdp.ev(f"""
    (function(){{
      var items = Array.from(document.querySelectorAll('.tipsText,.tab-item'));
      var target = items.find(e => (e.innerText||'').trim().indexOf('{text_pattern}') > -1);
      if (!target) return 'not found';
      target.click();
      return 'clicked: ' + target.innerText.trim();
    }})()
    """)

def click_range_tab(cdp, prefer_local):
    """点击 range-tab。prefer_local=True 选'本省资费'(XX资费，非全网)，False 选'全网资费'。"""
    if prefer_local:
        js = """
        (function(){
          var tabs = Array.from(document.querySelectorAll('.range-tab'));
          var target = tabs.find(e => /资费/.test(e.innerText) && !/全网/.test(e.innerText));
          if (!target) return 'no local tab';
          target.click();
          return 'clicked: ' + target.innerText.trim();
        })()
        """
    else:
        js = """
        (function(){
          var tabs = Array.from(document.querySelectorAll('.range-tab'));
          var target = tabs.find(e => /全网/.test(e.innerText));
          if (!target) return 'no national tab';
          target.click();
          return 'clicked: ' + target.innerText.trim();
        })()
        """
    return cdp.ev(js)

def has_local_tab(cdp):
    """检查是否存在'本省资费'tab（有些省可能只有全网资费）。"""
    return cdp.ev("""
    (function(){
      var tabs = Array.from(document.querySelectorAll('.range-tab'));
      return tabs.filter(e => /资费/.test(e.innerText) && !/全网/.test(e.innerText)).length;
    })()
    """)

def scroll_loop(cdp, max_iters=30, wait=2.0):
    """滚动到底，直到连续 3 次无新捕获或达到上限。"""
    prev_count = int(cdp.ev("window.__cap.length") or 0)
    no_new = 0
    for i in range(max_iters):
        cdp.ev("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(wait)
        cur = int(cdp.ev("window.__cap.length") or 0)
        if cur == prev_count:
            no_new += 1
            if no_new >= 3:
                break
        else:
            no_new = 0
            prev_count = cur
    return int(cdp.ev("window.__cap.length") or 0)

def extract_all(cdp, province):
    """从 window.__cap 提取所有套餐项，归一化。返回 plans 列表 + raw pages。"""
    n = int(cdp.ev("window.__cap.length") or 0)
    plans = []
    raw_pages = []
    seen = set()
    for i in range(n):
        # 分段读：先读长度，再读全文（避免大传输卡死，30KB 内 OK）
        t = cdp.ev(f"window.__cap[{i}].text")
        if not t: continue
        try:
            o = json.loads(t)
        except: continue
        raw_pages.append(o)
        beans = (o.get("data") or {}).get("beans") or []
        for bean in beans:
            bean_name = bean.get("tariffName", "")
            for nm in (bean.get("nonModuleList") or []):
                p = normalize_item(nm, bean_name, province)
                key = f"{p['name']}|{p['price']}|{p['details']['schemeId']}"
                if key in seen: continue
                seen.add(key)
                if p["name"] and p["price"] > 0:
                    plans.append(p)
            for m in (bean.get("moduleList") or []):
                for tl in (m.get("tariffList") or []):
                    p = normalize_item(tl, bean_name, province)
                    key = f"{p['name']}|{p['price']}|{p['details']['schemeId']}"
                    if key in seen: continue
                    seen.add(key)
                    if p["name"] and p["price"] > 0:
                        plans.append(p)
    plans.sort(key=lambda p: (p["price"], -p["data"]))
    return plans, raw_pages

def main():
    # 找已有 tab 或新建
    targets = get_targets()
    page = next((t for t in targets if t.get("type")=="page" and "tariffZonePers" in t.get("url","")), None)
    if page:
        tid = page["id"]
        print(f"reusing existing tab {tid}")
    else:
        tid = new_tab(PAGE_URL)
        print(f"created tab {tid}")
        time.sleep(8)
        targets = get_targets()
    page = next(t for t in targets if t.get("id")==tid)
    cdp = CDP(page["webSocketDebuggerUrl"])
    cdp.send("Runtime.enable")
    cdp.send("Page.enable")

    # 等页面完全加载
    time.sleep(3)
    install_hook(cdp)
    print("hook installed")

    os.makedirs(PUBLIC_DATA_DIR, exist_ok=True)
    os.makedirs(RAW_DIR, exist_ok=True)

    all_raw = {}
    for idx, province in enumerate(PROVINCES):
        print(f"\n[{idx+1}/{len(PROVINCES)}] {province}")
        all_raw[province] = {"national": [], "local": []}
        combined_plans = []
        seen_keys = set()

        # 先点省份（不切 tab，默认是全网资费）
        click_tab(cdp, "套餐")
        time.sleep(0.5)
        res = click_province(cdp, province)
        print(f"  click prov: {res}")
        time.sleep(3)

        # === 全网资费 tab ===
        click_range_tab(cdp, prefer_local=False)
        time.sleep(2)
        reset_cap(cdp)
        n_pages = scroll_loop(cdp)
        print(f"  [全网] pages: {n_pages}")
        plans_n, raw_n = extract_all(cdp, province)
        all_raw[province]["national"] = raw_n
        for p in plans_n:
            k = f"{p['name']}|{p['price']}|{p['details']['schemeId']}"
            if k in seen_keys: continue
            seen_keys.add(k)
            combined_plans.append(p)

        # === 本省资费 tab ===
        if int(has_local_tab(cdp) or 0) > 0:
            click_range_tab(cdp, prefer_local=True)
            time.sleep(3)
            reset_cap(cdp)
            # 滚动前先回到顶部，确保从头加载
            cdp.ev("window.scrollTo(0, 0)")
            time.sleep(1)
            n_pages_l = scroll_loop(cdp, max_iters=40, wait=2.5)
            print(f"  [本省] pages: {n_pages_l}")
            plans_l, raw_l = extract_all(cdp, province)
            all_raw[province]["local"] = raw_l
            new_local = 0
            for p in plans_l:
                k = f"{p['name']}|{p['price']}|{p['details']['schemeId']}"
                if k in seen_keys: continue
                seen_keys.add(k)
                combined_plans.append(p)
                new_local += 1
            print(f"  [本省] new plans (not in 全网): {new_local}")
        else:
            print(f"  [本省] no local tab")

        combined_plans.sort(key=lambda p: (p["price"], -p["data"]))
        # 写 public/data/{province}.json（合并两个 tab）
        out_path = os.path.join(PUBLIC_DATA_DIR, f"{province}.json")
        with open(out_path, "w") as f:
            json.dump({"scope":"province","province":province,"planCount":len(combined_plans),"plans":combined_plans}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"  wrote {out_path}: {len(combined_plans)} plans")

    # 写 raw
    raw_path = os.path.join(RAW_DIR, "cmcc-tariffs-raw.json")
    with open(raw_path, "w") as f:
        json.dump({"fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "provinces": all_raw}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\nwrote raw: {raw_path}")

    # 写 index.json（planCount 是各省文件里实际的 plans 数，由 split 脚本修正）
    province_entries = []
    for p in PROVINCES:
        raw = all_raw.get(p, {})
        n_count = len(raw.get("national", [])) if isinstance(raw, dict) else 0
        l_count = len(raw.get("local", [])) if isinstance(raw, dict) else 0
        province_entries.append({"province": p, "rawPages": n_count + l_count})
    with open(os.path.join(PUBLIC_DATA_DIR, "index.json"), "w") as f:
        json.dump({
            "sourceUrl": PAGE_URL,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "provinceCount": len(PROVINCES),
            "note": "planCount 由 split-national-province.mjs 修正",
            "provinces": sorted(province_entries, key=lambda x: x["province"]),
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote index.json (run split-national-province.mjs next)")

if __name__ == "__main__":
    main()
