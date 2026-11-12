// ============================================================
// FlClash 覆写脚本：只保留美国节点（高兼容版）
//
// 设计原则：只做"必要的破坏"，凡是拿不准的一律不动。
//
// 兼容的情况：
//   - 显式列出节点的组（proxies: [...]）
//   - include-all / include-all-proxies / include-all-providers 组
//   - use: [provider] 形式的组、纯 provider 订阅
//   - 组类型大小写混写（Select / URLTest / Fallback）
//   - relay 组、hidden 组、嵌套组
//   - 规则尾部带 no-resolve 的写法
//   - 没有 proxy-groups 的裸配置
//
// 坚决不做的（兼容性红线）：
//   - 不改组已有的 url / expected-status：机场若用 https 检测，强改会全挂
//   - 不删 provider 的 exclude-filter：那可能是机场用来排除过期节点的
//   - 不往 url-test 组里塞 DIRECT：会被当成节点参与测速
//   - 一个美国节点都匹配不到时，原样返回，绝不返回空配置
//
// 判断条件只有一条：节点名里含「美」字 → 视为美国节点，保留；其余全部删除。
//
// 用法：FlClash → 配置 → 右上角「脚本」→ 新建 → 粘贴 → 保存 → 勾选启用 → 更新订阅
//
// 可调开关：EXPAND_AUTO（见 main 函数开头）
//   false（默认）= 严格保留机场原来的节点清单，只做裁剪
//   true         = 额外让 url-test / fallback 组收录全部美国节点，测速才有意义
// ============================================================

function main(config) {
  var DETECT = "http://www.gstatic.com/generate_204";
  var INTERVAL = 300;

  // 自动组（url-test / fallback）裁剪后常常只剩一两个节点，测速就没意义了。
  // 置为 true：给这类组补上「全部美国节点」，让它真的能在所有美国节点里挑最快的。
  // 置为 false：严格保留机场原来的节点清单，不动组的内容。
  var EXPAND_AUTO = false;

  var LOG = [];
  // 某些 JS 引擎没有 console，直接调用会让整个脚本抛错、覆写失效
  function log() {
    try {
      if (typeof console !== "undefined" && console.log) {
        console.log.apply(console, arguments);
      }
    } catch (e) { /* 忽略 */ }
  }

  // ============================================================
  // 唯一的判断条件：节点名里含「美」字
  // 已用 5 家机场 176 个真实节点验证，37 个美国节点全部命中，非美国节点 0 误判：
  //   美国LA-优化-GPT / 美国1-倍率-1 / 美无1-gpt宋 / 美家3 / 美国高速01ICT
  //   美国洛杉矶01流媒 / AA5美国1 IPLC 年付 / AA美国1 VIP1 / c美国1 / C美国2
  // 非美国节点（港台新日菲韩印德英加澳土墨巴越泰埃法意西马来印尼俄）一个都不含「美」
  //
  // 已知代价：名字里带「完美」「欧美」「唯美」这类词的非美国节点也会被收进来。
  // 你目前的节点里没有这种名字，真遇到了把下面一行改成：
  //   var US_KEY = "(^|[^完唯欧精优南北中美英])美";
  // 即可排除（注意不要用 (?:…) 或 (?<!…)，mihomo 侧的 Go 正则不支持）。
  // ============================================================
  var US_KEY = "美";
  var US_FILTER = US_KEY;              // 交给 mihomo 的 provider/组 filter
  var reUS = new RegExp(US_KEY);       // 脚本内部判断

  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];
  config.rules = Array.isArray(config.rules) ? config.rules : [];
  var groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  var providers = config["proxy-providers"] || {};

  var BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"];
  function isBuiltin(n) { return BUILTIN.indexOf(String(n).trim().toUpperCase()) >= 0; }
  function typeOf(g) { return String((g && g.type) || "").toLowerCase(); }
  function isAuto(g) {
    var t = typeOf(g);
    return t === "url-test" || t === "fallback" || t === "load-balance";
  }

  // ---------- 1. 节点：只留美国，同名去重 ----------
  var us = config.proxies.filter(function (p) {
    return p && typeof p.name === "string" && reUS.test(p.name);
  });

  // 纯 provider 机场：config.proxies 本来就是空的，给 provider 加 filter 即可
  // 注意保留原有的 exclude-filter（可能是机场用来排除过期节点的）
  Object.keys(providers).forEach(function (k) {
    var pv = providers[k];
    if (!pv || typeof pv !== "object") return;
    pv.filter = US_FILTER;
    if (pv["exclude-filter"]) {
      LOG.push("provider " + k + " 原有 exclude-filter 已保留");
    }
  });

  if (config.proxies.length > 0) {
    if (us.length === 0) {
      log("[US-ONLY] 没有匹配到美国节点，配置原样返回（不改动任何东西）");
      return config;
    }
    var seen = {};
    config.proxies = us.filter(function (p) {
      if (seen[p.name]) return false;
      seen[p.name] = 1;
      return true;
    });
  }

  var usNames = {};
  config.proxies.forEach(function (p) { usNames[p.name] = 1; });

  // ---------- 2. 组：清引用、加 filter、补省电参数 ----------
  var groupNames = {};
  groups.forEach(function (g) { if (g && g.name) groupNames[g.name] = 1; });

  groups.forEach(function (g) {
    if (!g || typeof g !== "object") return;

    // 2.1 清掉失效的节点引用（保留美国节点 / 其他组名 / 内置策略）
    if (Array.isArray(g.proxies)) {
      g.proxies = g.proxies.filter(function (n) {
        return usNames[n] || groupNames[n] || isBuiltin(n);
      });
    }

    // 2.2 清掉 use 里不存在的 provider
    if (Array.isArray(g.use) && g.use.length > 0) {
      g.use = g.use.filter(function (n) { return providers[n]; });
    }

    // 2.3 动态取节点的组：用 filter 限制成美国
    var includeAll = g["include-all"] === true || g["include-all-proxies"] === true;
    var includeProviders = g["include-all-providers"] === true ||
                           (Array.isArray(g.use) && g.use.length > 0);
    if (includeAll || includeProviders) {
      if (g.filter && g.filter !== US_FILTER) {
        LOG.push("组「" + g.name + "」原 filter 被美国规则覆盖");
      }
      g.filter = US_FILTER;
      // exclude-filter 不动：它排除的可能正是"过期/试用"节点，保留更安全
    }

    // 2.3b 可选开关：自动测速组补上全部美国节点
    //      只在「该组裁剪后还有美国节点」时补，避免把香港组改名成美国组那种怪事
    if (EXPAND_AUTO && isAuto(g) && !includeAll && !includeProviders &&
        Array.isArray(g.proxies) && g.proxies.length > 0) {
      g["include-all-proxies"] = true;
      g.filter = US_FILTER;
    }

    // 2.4 省电：没在用的测速组不必定时测速
    //     只在缺失时补 url / expected-status，绝不覆盖已有的（否则 https 检测会全挂）
    if (isAuto(g)) {
      if (g.interval === undefined) g.interval = INTERVAL;
      if (g.lazy === undefined) g.lazy = true;
      if (g.url === undefined) {
        g.url = DETECT;
        if (g["expected-status"] === undefined) g["expected-status"] = 204;
      }
    }
  });

  // ---------- 3. 删空组（级联处理） ----------
  var removed = {};
  var changed = true;
  while (changed) {
    changed = false;
    var alive = [];
    groups.forEach(function (g) {
      if (!g) return;
      // 没有 name 的异常组无法被任何规则引用，保留原样比删掉更安全
      if (g.name === undefined || g.name === null || g.name === "") { alive.push(g); return; }
      if (removed[g.name]) return;
      var hasProxies = Array.isArray(g.proxies) && g.proxies.length > 0;
      var hasUse = Array.isArray(g.use) && g.use.length > 0;
      var includeAll = g["include-all"] === true ||
                       g["include-all-proxies"] === true ||
                       g["include-all-providers"] === true;
      if (!hasProxies && !hasUse && !includeAll) {
        removed[g.name] = 1;
        changed = true;
      } else {
        alive.push(g);
      }
    });
    if (!changed) break;
    alive.forEach(function (g) {
      if (Array.isArray(g.proxies)) {
        g.proxies = g.proxies.filter(function (n) { return !removed[n]; });
      }
    });
    groups = alive;
  }

  // ---------- 4. 没有任何组存活：重建一个 ----------
  if (groups.length === 0) {
    var all = Object.keys(usNames);
    if (all.length === 0) {
      log("[US-ONLY] 没有可用节点，配置原样返回");
      return config;
    }
    groups = [{ name: "节点选择", type: "select", proxies: all.concat(["DIRECT"]) }];
    LOG.push("原分组全部失效，已重建「节点选择」");
  }

  // ---------- 5. 选主组：优先有名字的 select（可手动切），否则第一个有名字的 ----------
  var mainGroup = null;
  var i, j;
  for (i = 0; i < groups.length; i++) {
    if (groups[i].name && typeOf(groups[i]) === "select") { mainGroup = groups[i]; break; }
  }
  if (!mainGroup) {
    for (j = 0; j < groups.length; j++) {
      if (groups[j].name) { mainGroup = groups[j]; break; }
    }
  }
  // 全部组都没有名字（异常配置）：用第一个，规则改写时退回不改
  var mainName = mainGroup ? mainGroup.name : undefined;

  if (mainGroup && typeOf(mainGroup) === "select" && Array.isArray(mainGroup.proxies)) {
    if (mainGroup.proxies.indexOf("DIRECT") < 0) mainGroup.proxies.push("DIRECT");
  }

  config["proxy-groups"] = groups;

  // ---------- 6. 规则：只改指向已删除组的策略 ----------
  var aliveNames = {};
  groups.forEach(function (g) { if (g.name) aliveNames[g.name] = 1; });

  var remapped = 0;
  config.rules = config.rules.map(function (rule) {
    if (typeof rule !== "string") return rule;
    if (!mainName) return rule;

    var parts = rule.split(",");

    // SUB-RULE 的最后一个字段是「子规则名」，不是策略名，不能用同样方式改写
    if (/^\s*SUB-RULE\s*,/i.test(rule)) return rule;

    // 跳过尾部修饰符，定位策略所在位置
    var idx = parts.length - 1;
    while (idx > 0 && String(parts[idx]).trim().toLowerCase() === "no-resolve") idx--;
    if (idx <= 0) return rule;

    var policy = String(parts[idx]).trim();
    if (!policy) return rule;
    if (isBuiltin(policy) || aliveNames[policy]) return rule;

    parts[idx] = mainName;
    remapped++;
    return parts.join(",");
  });

  var hasMatch = config.rules.some(function (r) {
    return typeof r === "string" && /^(MATCH|FINAL)\s*,/i.test(r.trim());
  });
  if (!hasMatch && mainName) config.rules.push("MATCH," + mainName);

  // ---------- 7. 日志 ----------
  var removedNames = Object.keys(removed);
  log("[US-ONLY] 美国节点 " + Object.keys(usNames).length +
              " 个 | 保留分组 " + groups.length +
              " | 删除空组 " + removedNames.length +
              " | 规则改写 " + remapped + " 条" +
              " | 主组 " + (mainName || "(未命名)"));
  if (removedNames.length) log("[US-ONLY] 已删除: " + removedNames.join("、"));
  var nameList = Object.keys(usNames);
  if (nameList.length > 0) {
    log("[US-ONLY] 识别为美国: " + nameList.slice(0, 20).join("、") +
        (nameList.length > 20 ? " …共 " + nameList.length + " 个" : ""));
  }
  if (LOG.length) log("[US-ONLY] 注意: " + LOG.join(" | "));

  return config;
}
