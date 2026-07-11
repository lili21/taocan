#!/usr/bin/env python3
"""通过已通过安全校验的 Chrome 会话抓取中国电信集团资费专区。"""

import html
import json
import os
import re
import sys
import threading
import urllib.parse
import urllib.request

import websocket


CDP_PORT = int(os.environ.get("CDP_PORT", "9224"))
BASE_URL = "https://www.189.cn/jtzfzq/"
API_ROOT = "https://www.189.cn/bss/tariffZone"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data", "telecom")
SEARCH_TERMS = ["套餐", "5G", "4G", "星卡", "畅享", "流量", "元", "校园", "关爱", "无忧"]

PROVINCES = {
    "北京": "609001", "天津": "609902", "河北": "609906", "山西": "609907",
    "内蒙古": "609908", "辽宁": "609905", "吉林": "609909", "黑龙江": "609910",
    "上海": "600102", "江苏": "600103", "浙江": "600104", "安徽": "600301",
    "福建": "600105", "江西": "600305", "山东": "609903", "河南": "609904",
    "湖北": "600202", "湖南": "600203", "广东": "600101", "广西": "600302",
    "海南": "600403", "重庆": "600304", "四川": "600201", "贵州": "600402",
    "云南": "600205", "西藏": "600406", "陕西": "600204", "甘肃": "600401",
    "青海": "600405", "宁夏": "600404", "新疆": "600303",
}

POSITIVE = re.compile(r"套餐|星卡|无忧卡|孝心卡|关爱|青春卡|校园卡")
EXCLUDE = re.compile(r"宽带|融合|电视|固话|企业|ICT|云业务|云看家|专线|折扣|减免|优惠活动|礼包|副卡|加装包|靓号|号码|橙分期|红包|购机|终端")


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, max_size=None)
        self.mid = 0
        self.lock = threading.Lock()

    def evaluate(self, expression):
        with self.lock:
            self.mid += 1
            mid = self.mid
            self.ws.send(json.dumps({
                "id": mid,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
            }))
            while True:
                message = json.loads(self.ws.recv())
                if message.get("id") == mid:
                    result = message.get("result", {}).get("result", {})
                    if result.get("subtype") == "error":
                        raise RuntimeError(result.get("description", "浏览器执行失败"))
                    return result.get("value")


def connect():
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json"))
    target = next((item for item in targets if item.get("type") == "page" and "189.cn" in item.get("url", "")), None)
    if not target:
        raise RuntimeError(f"端口 {CDP_PORT} 没有已打开的中国电信资费专区页面")
    return CDP(target["webSocketDebuggerUrl"])


def api(cdp, path, params):
    query = "&".join(f"{key}={urllib.parse.quote(str(value))}" for key, value in params.items())
    url = f"{API_ROOT}/{path}?{query}"
    expression = f"""
      fetch({json.dumps(url)}, {{credentials: 'include'}})
        .then(async response => ({{status: response.status, text: await response.text()}}))
    """
    response = cdp.evaluate(expression)
    if response["status"] != 200:
        raise RuntimeError(f"{path}: HTTP {response['status']}")
    payload = json.loads(response["text"])
    if payload.get("code") != "0":
        raise RuntimeError(f"{path}: {payload.get('message') or payload.get('msg') or payload.get('code')}")
    return payload.get("dataObject")


def plain(value):
    value = re.sub(r"<br\s*/?>", "\n", value or "", flags=re.I)
    value = re.sub(r"</(?:p|div|tr|li)>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value).replace("\xa0", " ")
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines() if line.strip())


def first_number(pattern, value):
    match = re.search(pattern, value, re.I)
    return float(match.group(1)) if match else 0


def price_from(value):
    values = [float(item) for item in re.findall(r"(?<!\d)(\d+(?:\.\d+)?)\s*元", value)]
    values = [item for item in values if 0 < item < 1000]
    return values[0] if values else 0


def metric(value, unit):
    number = first_number(rf"(\d+(?:\.\d+)?)\s*{unit}", value)
    return int(number) if float(number).is_integer() else number


def data_metric(value):
    return metric(value, r"(?:GB|G(?=流量))")


def normalize_search(item, province):
    name = (item.get("title") or "").strip()
    price = price_from(name)
    if not name or not price or not POSITIVE.search(name) or EXCLUDE.search(name):
        return None
    report_no = (item.get("records") or item.get("nbr") or item.get("id") or "").strip()
    source_url = (item.get("wt_url") or item.get("app_url") or BASE_URL).strip()
    return {
        "id": f"telecom-{province}-{report_no or item.get('id')}",
        "name": name,
        "area": province,
        "price": price,
        "data": data_metric(name),
        "generalData": data_metric(name),
        "directedData": 0,
        "voice": metric(name, "分钟"),
        "sms": "详见官方详情",
        "broadband": "详见官方详情",
        "audience": "以当地电信办理规则为准",
        "contract": "详见官方详情",
        "source": "中国电信资费专区",
        "tags": ["套餐", "移网", "本省资费"],
        "details": {
            "schemeId": report_no,
            "tariffStandard": f"{price:g}元/月（标题提取，详见官方详情）",
            "onlineDate": item.get("begin_time") or "",
            "offlineDate": item.get("end_time") or "",
            "category": "套餐",
            "sourceUrl": source_url,
            "notes": "省级统一索引仅公示摘要字段，具体流量、通话、适用对象及合约条件请查看官方详情。",
        },
    }


def normalize_national(item):
    name = (item.get("name") or "").strip()
    content = "\n".join(filter(None, [name, plain(item.get("jbxx")), plain(item.get("ffnr")), plain(item.get("other_content"))]))
    price = price_from(content)
    if not name or not price:
        return None
    report_no = (item.get("report_no") or item.get("id") or "").strip()
    is_activity = bool(re.search(r"合约|优惠|折扣|促销", name))
    category = "活动" if is_activity else "套餐"
    return {
        "id": f"telecom-national-{report_no or item.get('id')}",
        "name": name,
        "area": "全国",
        "price": price,
        "data": data_metric(content),
        "generalData": data_metric(content),
        "directedData": 0,
        "voice": metric(content, "分钟"),
        "sms": "详见资费说明",
        "broadband": "详见资费说明",
        "audience": "以官方公示为准",
        "contract": "详见资费说明",
        "source": "中国电信资费专区",
        "tags": [category, "集团资费"],
        "details": {
            "schemeId": report_no,
            "tariffStandard": content[:8000],
            "category": category,
            "sourceUrl": BASE_URL,
            "notes": plain(item.get("others")),
        },
    }


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def main():
    cdp = connect()
    national_items = api(cdp, "tarifZone3Title.do", {
        "provCode": "1000000037", "lable1Id": "671af00f114dd43fc66375b9",
    }) or []
    national = [plan for item in national_items if (plan := normalize_national(item))]
    write_json(os.path.join(OUTPUT_DIR, "national.json"), {"area": "全国", "plans": national})

    province_counts = {}
    for province, code in PROVINCES.items():
        merged = {}
        for term in SEARCH_TERMS:
            result = api(cdp, "tarifZoneEs.do", {"provinceCode": code, "query": term}) or {}
            for item in result.get("data", []):
                plan = normalize_search(item, province)
                if plan:
                    merged[plan["id"]] = plan
        plans = sorted(merged.values(), key=lambda plan: (plan["price"], plan["name"]))
        province_counts[province] = len(plans)
        write_json(os.path.join(OUTPUT_DIR, f"{province}.json"), {"area": province, "plans": plans})
        print(f"{province}: {len(plans)}")

    total = len(national) + sum(province_counts.values())
    index = {
        "sourceUrl": BASE_URL,
        "sourceName": "中国电信资费专区",
        "updatedAt": "2026-07-11",
        "planCount": total,
        "nationalPlanCount": len(national),
        "provincePlanCounts": province_counts,
        "provinces": list(PROVINCES),
        "methodology": "集团资费来自集团目录；省级资费来自中国电信统一资费搜索索引，详情字段以官方链接为准。",
    }
    write_json(os.path.join(OUTPUT_DIR, "index.json"), index)
    print(f"全国: {len(national)}；合计: {total}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"抓取失败：{error}", file=sys.stderr)
        sys.exit(1)
