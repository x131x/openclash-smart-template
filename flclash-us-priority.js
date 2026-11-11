// ============================================================
// FlClash 覆写脚本：美国优先 → 全挂自动降级 → 恢复自动切回
//
// 组结构（代理页看到的就是这个）：
//
//   节点选择  [select]  ← 规则全部指向这里，这就是「自动/手动开关」
//     ├── 🤖 自动 · 美国优先  [fallback]   ← 默认选中，全自动
//     │     ├── 🇺🇸 美国·最快   [url-test]  仅美国节点，自动选延迟最低
//     │     ├── 🌐 备用·最快    [url-test]  排除美国+香港，自动选延迟最低
//     │     └── DIRECT                      两个都全挂时兜底直连
//     ├── 🇺🇸 美国·最快        ← 手动：锁死只用美国
//     ├── 🌐 备用·最快         ← 手动：锁死只用备用
//     └── DIRECT              ← 手动：全部直连
//
// 为什么顶层是 select 而不是 fallback：
//   mihomo 的 fallback 有 selected 粘性——手动点过的子项只要还活着就一直用，
//   美国恢复了也不切回。把 fallback 藏到第二层、顶层用 select，
//   手动选择就发生在「开关」这一层：想回全自动，点一下「🤖 自动」即可，一次到位。
//
// 用法：FlClash → 配置 → 右上角「脚本」→ 新建 → 粘贴 → 保存 → 勾选启用 → 更新订阅
// ============================================================

function main(config) {
  var DETECT = "http://www.gstatic.com/generate_204"; // 健康检查地址
  var INTERVAL = 60;                                   // 每 60 秒测一次，故障感知更快
  var TOLERANCE = 50;                                  // 快 50ms 以内不切换，防抖

  var MAIN = "节点选择";            // 顶层开关（规则指向它）
  var AUTO = "🤖 自动 · 美国优先";  // 全自动（fallback）
  var G_US = "🇺🇸 美国·最快";
  var G_BAK = "🌐 备用·最快";

  // 分隔符：确认 US / HK 这类两字母代码是独立词，不会误伤 Russia、Belarus
  var SEP = "[\\s_\\-·|/【】\\[\\]()（）]";

  var US_WORDS = [
    "美国", "美区", "美國", "🇺🇸", "United States", "America",
    "洛杉矶", "Los Angeles", "圣何塞", "San Jose", "硅谷", "圣克拉拉",
    "西雅图", "Seattle", "达拉斯", "Dallas", "芝加哥", "Chicago",
    "纽约", "New York", "阿什本", "Ashburn", "波特兰", "Portland",
    "凤凰城", "Phoenix", "迈阿密", "Miami", "亚特兰大", "Atlanta",
    "波士顿", "Boston", "拉斯维加斯", "Las Vegas", "丹佛", "Denver"
  ];
  var US_CODES = [
    "US", "USA", "LAX", "SJC", "SFO", "SEA", "DFW", "ORD", "JFK",
    "IAD", "EWR", "ATL", "MIA", "PHX", "DEN", "LAS", "BOS", "PDX"
  ];

  var HK_WORDS = ["香港", "深港", "沪港", "🇭🇰", "Hong Kong", "HongKong"];
  var HK_CODES = ["HK", "HKG"];

  function tokens(codes) {
    return codes.map(function (c) {
      return "(?:^|" + SEP + ")" + c + "\\d*(?=$|" + SEP + ")";
    }).join("|");
  }

  var US_SRC = US_WORDS.join("|") + "|" + tokens(US_CODES);
  var EXCL_SRC = US_SRC + "|" + HK_WORDS.join("|") + "|" + tokens(HK_CODES);

  var US_FILTER = "(?i)(" + US_SRC + ")";
  var EXCL_FILTER = "(?i)(" + EXCL_SRC + ")";
  var reUS = new RegExp(US_SRC, "i");
  var reEXCL = new RegExp(EXCL_SRC, "i");

  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];
  config.rules = Array.isArray(config.rules) ? config.rules : [];
  var providers = config["proxy-providers"] || {};
  var hasProvider = Object.keys(providers).length > 0;

  var hasUS = hasProvider || config.proxies.some(function (p) {
    return p && p.name && reUS.test(p.name);
  });
  var hasBAK = hasProvider || config.proxies.some(function (p) {
    return p && p.name && !reEXCL.test(p.name);
  });

  if (!hasUS && !hasBAK) {
    console.log("[US-PRIORITY] 没匹配到可用节点，配置保持原样，未做任何修改");
    return config;
  }

  var groups = [];
  var autoOrder = [];   // fallback 内部的顺序，决定优先级

  if (hasUS) {
    groups.push({
      name: G_US,
      type: "url-test",
      "include-all": true,
      "include-all-proxies": true,
      "include-all-providers": true,
      filter: US_FILTER,
      url: DETECT,
      interval: INTERVAL,
      tolerance: TOLERANCE,
      lazy: false          // 锁死为 false：不打盹，才能及时上报"自己全挂了"
    });
    autoOrder.push(G_US);
  }

  if (hasBAK) {
    groups.push({
      name: G_BAK,
      type: "url-test",
      "include-all": true,
      "include-all-proxies": true,
      "include-all-providers": true,
      "exclude-filter": EXCL_FILTER,
      url: DETECT,
      interval: INTERVAL,
      tolerance: TOLERANCE,
      lazy: false
    });
    autoOrder.push(G_BAK);
  }

  autoOrder.push("DIRECT");

  // 第二层：全自动 fallback（按顺序取第一个可用的）
  groups.unshift({
    name: AUTO,
    type: "fallback",
    proxies: autoOrder,
    url: DETECT,
    interval: INTERVAL
  });

  // 第一层：手动开关。第一项=自动，默认就选中它
  var switchList = [AUTO];
  if (hasUS) switchList.push(G_US);
  if (hasBAK) switchList.push(G_BAK);
  switchList.push("DIRECT");

  groups.unshift({
    name: MAIN,
    type: "select",
    proxies: switchList
  });

  config["proxy-groups"] = groups;

  // 规则里的策略全部改指向「节点选择」。DIRECT / REJECT 等内置策略原样保留，
  // 所以国内直连、广告拦截继续生效
  var KEEP = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"];
  var remapped = 0;

  config.rules = config.rules.map(function (rule) {
    if (typeof rule !== "string") return rule;
    var p = rule.split(",");
    var i = p.length - 1;
    if (i > 0 && String(p[i]).trim().toLowerCase() === "no-resolve") i--;
    var t = String(p[i] || "").trim();
    if (!t) return rule;
    if (KEEP.indexOf(t.toUpperCase()) >= 0 || t === MAIN) return rule;
    p[i] = MAIN;
    remapped++;
    return p.join(",");
  });

  var hasMatch = config.rules.some(function (r) {
    return typeof r === "string" && /^(MATCH|FINAL)\s*,/i.test(r.trim());
  });
  if (!hasMatch) config.rules.push("MATCH," + MAIN);

  console.log("[US-PRIORITY] 开关项 " + switchList.length +
              " | 美国组 " + (hasUS ? "已建" : "跳过") +
              " | 备用组 " + (hasBAK ? "已建" : "跳过") +
              " | 规则改写 " + remapped + " 条");
  return config;
}
