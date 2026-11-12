// ============================================================
// FlClash 覆写脚本：只保留美国节点 + 统一分组结构
//
// 版本：v2.1    更新日期：2026-11-12
// 改动记录：
//   v2.1  容差 50 → 100 毫秒：只在明显更快时才换节点，减少出口 IP 变动（对 AI 类服务更友好）。
//   v2.0  改为「重建分组」：不管机场原本什么结构，统一输出 Proxy + 自动选择；
//         删除 fallback（故障转移）组；自动组收录全部美国节点。
//   v1.0  首版。保留机场原有分组，仅删除非美国节点；空组级联清理；规则改指主组。
//
// 输出的代理页固定是这两个组：
//
//   Proxy        [Selector]   规则指向这里，默认选中「自动选择」
//    └ 自动选择  [URLTest]    含全部美国节点，自动选延迟最低的
//
// 为什么不再保留机场原分组：
//   不同机场自带的分组各不相同（有的 Proxy/自动选择/故障转移，有的 节点选择/香港/日本/美国），
//   裁剪后每组长得都不一样。统一重建才能做到「每个订阅打开都是同一张脸」。
//
// 判断条件只有一条：节点名里含「美」字 → 美国节点，保留；其余全部删除。
//
// 用法：FlClash → 配置 → 右上角「脚本」→ 新建 → 粘贴 → 保存 → 勾选启用 → 更新订阅
//
// 可调参数：见 main 函数开头（测速间隔 / 组名 / 是否保留 DIRECT）
// ============================================================

function main(config) {
  // ---------------- 可调参数 ----------------
  var DETECT = "http://www.gstatic.com/generate_204"; // 测速地址
  var INTERVAL = 300;                                 // 测速间隔（秒）
  var TOLERANCE = 100;                                // 容差（毫秒）：新节点要快 100ms 以上才切，避免出口 IP 频繁变动

  // 顶层手动组名。填 "Proxy" 则所有订阅都显示 Proxy；
  // 填 null 则沿用该订阅原来那个 select 组的名字（有的机场叫「节点选择」）。
  var TOP_NAME = "Proxy";

  var AUTO_NAME = "自动选择";   // 自动测速组名
  var KEEP_DIRECT = true;       // 顶层组末尾是否追加 DIRECT（方便临时切直连）

  // 判断条件：节点名含「美」= 美国节点
  // 已知代价：名字里带「完美」「欧美」「唯美」这类词的非美国节点也会被收进来。
  // 真遇到了把下面一行改成：
  //   var US_KEY = "(^|[^完唯欧精优南北中美英])美";
  // （不要用 (?:…) 或 (?<!…)，mihomo 侧的 Go 正则不支持）
  var US_KEY = "美";
  // --------------------------------------------------

  var US_FILTER = US_KEY;
  var reUS = new RegExp(US_KEY);

  var LOG = [];
  // 某些 JS 引擎没有 console，直接调用会让整个脚本抛错、覆写失效
  function log() {
    try {
      if (typeof console !== "undefined" && console.log) {
        console.log.apply(console, arguments);
      }
    } catch (e) { /* 忽略 */ }
  }

  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];
  config.rules = Array.isArray(config.rules) ? config.rules : [];
  var rawGroups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  var providers = config["proxy-providers"] || {};
  var providerKeys = Object.keys(providers);
  var hadProxies = config.proxies.length > 0;

  var BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"];
  function isBuiltin(n) {
    return BUILTIN.indexOf(String(n).trim().toUpperCase()) >= 0;
  }

  // ---------- 1. 节点：只留美国，同名去重 ----------
  var seen = {};
  var us = [];
  config.proxies.forEach(function (p) {
    if (!p || typeof p.name !== "string") return;
    if (!reUS.test(p.name)) return;
    if (seen[p.name]) return;
    seen[p.name] = 1;
    us.push(p);
  });

  // ---------- 2. provider：限制成美国 ----------
  // 纯 provider 机场 config.proxies 本来就是空的，靠这一步拿到节点
  // 保留原有 exclude-filter（可能是机场用来排除过期/试用节点的）
  providerKeys.forEach(function (k) {
    var pv = providers[k];
    if (!pv || typeof pv !== "object") return;
    pv.filter = US_FILTER;
    if (pv["exclude-filter"]) {
      LOG.push("provider「" + k + "」原 exclude-filter 已保留");
    }
  });

  // ---------- 3. 可用性保护：拿不到美国节点就不动配置 ----------
  if (hadProxies && us.length === 0) {
    log("[US-ONLY] 有节点但没一个含「美」，配置原样返回（不做任何改动）");
    return config;
  }
  if (!hadProxies && providerKeys.length === 0) {
    log("[US-ONLY] 既没有节点也没有 provider，配置原样返回");
    return config;
  }

  // 保护性返回之后才真正裁剪节点，避免「没有美国节点」时把 proxies 清空
  config.proxies = us;

  // ---------- 4. 顶层组名 ----------
  var top = TOP_NAME;
  if (!top) {
    for (var i = 0; i < rawGroups.length; i++) {
      var g = rawGroups[i];
      if (g && g.name && String(g.type || "").toLowerCase() === "select") {
        top = g.name;
        break;
      }
    }
    if (!top) top = "Proxy";
  }
  if (top === AUTO_NAME) {
    top = "Proxy";
    LOG.push("顶层组名与自动组重名，已改用 Proxy");
  }

  // ---------- 5. 重建分组（旧分组全部丢弃） ----------
  var nodeNames = us.map(function (p) { return p.name; });

  var topGroup = { name: top, type: "select", proxies: [AUTO_NAME].concat(nodeNames) };
  if (KEEP_DIRECT) topGroup.proxies.push("DIRECT");
  // 混合型机场：顶层手动组也把 provider 的节点列进来，方便单独点选
  if (providerKeys.length > 0) topGroup["include-all-providers"] = true;

  var autoGroup = {
    name: AUTO_NAME,
    type: "url-test",
    "include-all-proxies": true,
    filter: US_FILTER,
    url: DETECT,
    interval: INTERVAL,
    tolerance: TOLERANCE,
    lazy: false   // 显式关闭懒惰：保证它一直测速，用户切过去时不会是空的
  };
  if (providerKeys.length > 0) autoGroup["include-all-providers"] = true;

  config["proxy-groups"] = [topGroup, autoGroup];

  // ---------- 6. 规则：指向已不存在分组的策略，统一改指顶层组 ----------
  var alive = {};
  alive[top] = 1;
  alive[AUTO_NAME] = 1;
  // mihomo 允许规则直接指向某个节点，这类规则要原样保留，不能被改指到组
  nodeNames.forEach(function (n) { alive[n] = 1; });

  // 节点可能通过 dialer-proxy 串联到某个分组；那个分组已被丢弃，引用会失效导致加载报错
  us.forEach(function (p) {
    var d = p["dialer-proxy"];
    if (typeof d === "string" && d && !isBuiltin(d) && !alive[d]) {
      delete p["dialer-proxy"];
      LOG.push("节点「" + p.name + "」的 dialer-proxy 指向已丢弃的分组，已移除该字段");
    }
  });

  var remapped = 0;
  function remapRule(rule) {
    if (typeof rule !== "string") return rule;

    // SUB-RULE 的最后一个字段是「子规则名」，不是策略名，不能改写
    if (/^\s*SUB-RULE\s*,/i.test(rule)) return rule;

    var parts = rule.split(",");
    var idx = parts.length - 1;
    // 跳过尾部修饰符，定位策略所在位置
    while (idx > 0 && String(parts[idx]).trim().toLowerCase() === "no-resolve") idx--;
    if (idx <= 0) return rule;

    var policy = String(parts[idx]).trim();
    if (!policy) return rule;
    if (isBuiltin(policy) || alive[policy]) return rule;

    parts[idx] = top;
    remapped++;
    return parts.join(",");
  }

  config.rules = config.rules.map(remapRule);

  // 子规则里也可能引用旧分组，一并处理
  var subRules = config["sub-rules"];
  if (subRules && typeof subRules === "object") {
    Object.keys(subRules).forEach(function (k) {
      if (Array.isArray(subRules[k])) subRules[k] = subRules[k].map(remapRule);
    });
  }

  var hasMatch = config.rules.some(function (r) {
    return typeof r === "string" && /^(MATCH|FINAL)\s*,/i.test(r.trim());
  });
  if (!hasMatch) config.rules.push("MATCH," + top);

  // ---------- 7. 日志 ----------
  log("[US-ONLY] v2.1 | 美国节点 " + us.length +
              " 个 | 分组 2 个（" + top + " / " + AUTO_NAME + "）" +
              " | 丢弃原分组 " + rawGroups.length +
              " | 规则改写 " + remapped + " 条");
  if (nodeNames.length > 0) {
    log("[US-ONLY] 识别为美国: " + nodeNames.slice(0, 20).join("、") +
        (nodeNames.length > 20 ? " …共 " + nodeNames.length + " 个" : ""));
  }
  if (providerKeys.length > 0) {
    log("[US-ONLY] provider 已限制为美国: " + providerKeys.join("、"));
  }
  if (LOG.length) log("[US-ONLY] 注意: " + LOG.join(" | "));

  return config;
}
