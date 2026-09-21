/* ICU 文案分支预览器 — 前端逻辑 */
(function () {
  "use strict";

  var tpl = document.getElementById("template");
  var hl = document.getElementById("highlight");
  var localeInput = document.getElementById("locale");
  var messagesEl = document.getElementById("messages");
  var varRowsEl = document.getElementById("varRows");
  var mainResultEl = document.getElementById("mainResult");
  var mainCondsEl = document.getElementById("mainConds");
  var statsEl = document.getElementById("stats");
  var nodesEl = document.getElementById("nodes");
  var pathsEl = document.getElementById("paths");
  var toastEl = document.getElementById("toast");

  var lastResult = null;
  var debounceTimer = null;

  var DEFAULT_TEMPLATE =
    "{gender, select, male{He} female{She} other{They}} has " +
    "{count, plural, =0{no new messages} one{# new message} other{# new messages}}.";

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    setTimeout(function () { toastEl.classList.remove("show"); }, 1600);
  }

  function copyText(text, label) {
    function done() { toast(label || "已复制"); }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); }
      catch (e) { toast("复制失败，请手动复制"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function parseValue(raw) {
    var t = raw.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t !== "" && !isNaN(Number(t))) return Number(t);
    return raw;
  }

  function typeLabel(v) {
    if (typeof v === "number") return "数字";
    if (typeof v === "boolean") return "布尔";
    return "字符串";
  }

  /* ---------------- 变量行 ---------------- */

  function addVarRow(name, value) {
    var row = document.createElement("div");
    row.className = "var-row";

    var nameInput = document.createElement("input");
    nameInput.className = "var-name";
    nameInput.placeholder = "变量名";
    nameInput.value = name || "";

    var valueInput = document.createElement("input");
    valueInput.className = "var-value";
    valueInput.placeholder = "样例值";
    valueInput.value = value === undefined ? "" : String(value);

    var typeBadge = document.createElement("span");
    typeBadge.className = "var-type";
    typeBadge.textContent = "字符串";

    var del = document.createElement("button");
    del.className = "var-del";
    del.textContent = "×";
    del.title = "删除该变量";
    del.addEventListener("click", function () {
      row.remove();
      scheduleAnalyze();
    });

    function updateType() {
      typeBadge.textContent = typeLabel(parseValue(valueInput.value));
    }
    valueInput.addEventListener("input", function () { updateType(); scheduleAnalyze(); });
    nameInput.addEventListener("input", scheduleAnalyze);
    updateType();

    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(typeBadge);
    row.appendChild(del);
    varRowsEl.appendChild(row);
  }

  function collectVariables() {
    var vars = {};
    var rows = varRowsEl.querySelectorAll(".var-row");
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].querySelector(".var-name").value.trim();
      var raw = rows[i].querySelector(".var-value").value;
      if (name) vars[name] = parseValue(raw);
    }
    return vars;
  }

  /* ---------------- 模板高亮 ---------------- */

  function renderHighlight(tokens, errors) {
    var text = tpl.value;
    // 汇总所有染色区间：token 在前，error 覆盖其上
    var spans = [];
    (tokens || []).forEach(function (t) {
      spans.push({ start: t.start, end: t.end, cls: "tok-" + t.cls });
    });
    (errors || []).forEach(function (e) {
      if (e.pos === null || e.pos === undefined) return;
      spans.push({ start: e.pos, end: e.pos + (e.length || 1), cls: "tok-error" });
    });
    if (!text) {
      hl.innerHTML = "\n";
      return;
    }
    // 切分边界
    var cuts = { 0: true };
    cuts[text.length] = true;
    spans.forEach(function (s) {
      cuts[Math.max(0, Math.min(text.length, s.start))] = true;
      cuts[Math.max(0, Math.min(text.length, s.end))] = true;
    });
    var points = Object.keys(cuts).map(Number).sort(function (a, b) { return a - b; });
    var html = "";
    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i], b = points[i + 1];
      var cls = null;
      for (var j = 0; j < spans.length; j++) {
        if (spans[j].start <= a && spans[j].end >= b) {
          if (spans[j].cls === "tok-error") { cls = "tok-error"; break; }
          if (!cls) cls = spans[j].cls;
        }
      }
      var piece = esc(text.slice(a, b));
      html += cls ? '<span class="' + cls + '">' + piece + "</span>" : piece;
    }
    hl.innerHTML = html + "\n";
  }

  tpl.addEventListener("scroll", function () {
    hl.scrollTop = tpl.scrollTop;
    hl.scrollLeft = tpl.scrollLeft;
  });

  /* ---------------- 消息列表 ---------------- */

  function renderMessages(result) {
    messagesEl.innerHTML = "";
    var all = [];
    (result.errors || []).forEach(function (e) { all.push({ kind: "error", label: "错误", data: e }); });
    (result.warnings || []).forEach(function (w) { all.push({ kind: "warning", label: "警告", data: w }); });
    (result.infos || []).forEach(function (i) { all.push({ kind: "info", label: "提示", data: i }); });
    all.forEach(function (item) {
      var d = item.data;
      var div = document.createElement("div");
      div.className = "msg msg-" + item.kind;
      var loc = "";
      if (d.line !== null && d.line !== undefined) {
        loc = "第 " + d.line + " 行 " + d.col + " 列：";
      }
      div.innerHTML = '<span class="tag">' + item.label + "</span><span>" +
        esc(loc + d.message) + "</span>";
      if (d.pos !== null && d.pos !== undefined) {
        div.title = "点击定位到出错位置";
        div.addEventListener("click", function () {
          tpl.focus();
          var end = Math.min(tpl.value.length, d.pos + (d.length || 1));
          tpl.setSelectionRange(d.pos, end);
        });
      }
      messagesEl.appendChild(div);
    });
  }

  /* ---------------- 结果渲染 ---------------- */

  function badge(covered, reachable, coverageAvailable) {
    if (!reachable) return '<span class="badge badge-dead">不可达</span>';
    if (!coverageAvailable) return '<span class="badge badge-dead">覆盖未知</span>';
    return covered
      ? '<span class="badge badge-covered">已覆盖</span>'
      : '<span class="badge badge-uncovered">未覆盖</span>';
  }

  function renderResult(result) {
    lastResult = result;

    renderHighlight(result.tokens, result.errors);
    renderMessages(result);

    // 主渲染
    if (result.main) {
      mainResultEl.textContent = result.main.output || "（空）";
      mainCondsEl.innerHTML = "";
      (result.main.conditions || []).forEach(function (c) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        mainCondsEl.appendChild(chip);
      });
      if (result.main.incomplete) {
        var warn = document.createElement("span");
        warn.className = "chip";
        warn.textContent = "⚠ 分支变量缺失或类型错误，覆盖情况不可判定";
        mainCondsEl.appendChild(warn);
      }
    }

    // 统计
    var st = result.stats || {};
    var statText = "共 " + st.total_paths + " 条路径";
    if (st.truncated) statText += "（仅展示前 " + st.shown_paths + " 条）";
    if (st.coverage_available) {
      statText += "，样例覆盖 " + st.covered_paths + " 条";
    }
    statsEl.textContent = statText;

    // 分支节点
    nodesEl.innerHTML = "";
    if (!result.nodes || !result.nodes.length) {
      nodesEl.innerHTML = '<div class="empty">模板中没有 plural / select 分支节点。</div>';
    }
    (result.nodes || []).forEach(function (node) {
      var card = document.createElement("div");
      card.className = "node-card";
      var kindCls = node.kind === "select" ? "select" : "";
      var html = '<div class="node-head">' +
        '<span class="node-kind ' + kindCls + '">' + esc(node.kind) + "</span>" +
        "<span>变量 " + esc(node.variable) + "</span></div>";
      node.branches.forEach(function (b) {
        var rowCls = "branch-row" + (!b.reachable ? " dead" : (!b.covered ? " uncovered" : ""));
        html += '<div class="' + rowCls + '">' +
          '<span class="branch-sel">' + esc(b.selector) + "</span>" +
          '<span class="branch-cond">' + esc(b.condition) + "</span>" +
          badge(b.covered, b.reachable, st.coverage_available) +
          "</div>";
      });
      card.innerHTML = html;
      nodesEl.appendChild(card);
    });

    // 路径列表
    pathsEl.innerHTML = "";
    if (!result.paths || !result.paths.length) {
      pathsEl.innerHTML = '<div class="empty">没有可枚举的分支路径。</div>';
    }
    (result.paths || []).forEach(function (p) {
      var card = document.createElement("div");
      card.className = "path-card" + (p.covered ? "" : " uncovered");
      card.setAttribute("data-key", p.key || "");
      var head = document.createElement("div");
      head.className = "path-head";
      var idSpan = document.createElement("span");
      idSpan.className = "path-id";
      idSpan.textContent = "#" + p.id;
      head.appendChild(idSpan);
      p.conditions.forEach(function (c) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        head.appendChild(chip);
      });
      var badgeSpan = document.createElement("span");
      badgeSpan.innerHTML = badge(p.covered, true, st.coverage_available);
      head.appendChild(badgeSpan);
      var copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-small path-copy";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", function () { copyText(p.output, "已复制路径 #" + p.id); });
      head.appendChild(copyBtn);
      var out = document.createElement("div");
      out.className = "path-output";
      out.textContent = p.output;
      card.appendChild(head);
      card.appendChild(out);
      pathsEl.appendChild(card);
    });
  }

  /* ---------------- 分析请求 ---------------- */

  function analyze() {
    var payload = {
      template: tpl.value,
      locale: localeInput.value.trim() || "en",
      variables: collectVariables(),
    };
    fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(renderResult)
      .catch(function () {
        messagesEl.innerHTML =
          '<div class="msg msg-error"><span class="tag">错误</span>' +
          "<span>无法连接服务器</span></div>";
      });
  }

  function scheduleAnalyze() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(analyze, 350);
  }

  /* ---------------- 事件绑定 ---------------- */

  tpl.addEventListener("input", scheduleAnalyze);
  localeInput.addEventListener("input", scheduleAnalyze);

  document.getElementById("btnAddVar").addEventListener("click", function () {
    addVarRow("", "");
  });

  document.getElementById("btnExtract").addEventListener("click", function () {
    if (!lastResult || !lastResult.variables_used) { analyze(); return; }
    var existing = {};
    varRowsEl.querySelectorAll(".var-name").forEach(function (inp) {
      existing[inp.value.trim()] = true;
    });
    var added = 0;
    lastResult.variables_used.forEach(function (name) {
      if (!existing[name]) { addVarRow(name, ""); added++; }
    });
    toast(added ? "已添加 " + added + " 个变量" : "模板变量均已在列表中");
    if (added) scheduleAnalyze();
  });

  document.getElementById("btnCopyMain").addEventListener("click", function () {
    if (lastResult && lastResult.main) copyText(lastResult.main.output, "已复制渲染结果");
  });

  document.getElementById("btnCopyAll").addEventListener("click", function () {
    if (!lastResult || !lastResult.paths) return;
    var text = lastResult.paths.map(function (p) {
      return "#" + p.id + " [" + p.conditions.join("; ") + "]\n" + p.output;
    }).join("\n\n");
    copyText(text, "已复制全部路径");
  });

  document.getElementById("btnExport").addEventListener("click", function () {
    if (!lastResult) return;
    var data = {
      tool: "icu-branch-previewer",
      exported_at: new Date().toISOString(),
      template: tpl.value,
      locale: localeInput.value.trim() || "en",
      variables: collectVariables(),
      result: lastResult,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "icu-branch-preview.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast("已导出 JSON");
  });

  /* ---------------- 场景集回归 ---------------- */

  var STORAGE_KEY = "icu-preview-scenarios-v1";
  var scenarioListEl = document.getElementById("scenarioList");
  var scenarioCountEl = document.getElementById("scenarioCount");
  var scenarioSummaryEl = document.getElementById("scenarioSummary");
  var scenarioPathsEl = document.getElementById("scenarioPaths");
  var scenarioProgressEl = document.getElementById("scenarioProgress");
  var scenarioProgressBarEl = document.getElementById("scenarioProgressBar");

  var scenarios = [];          // [{id, name, locale, variables}]
  var scenarioStatus = {};     // id -> "running" | "passed" | "failed"
  var scenarioErrors = {};     // id -> 错误信息
  var scenarioResults = {};    // id -> 最近一次成功的 analyze 结果
  var lastMerge = null;        // 最近一次合并响应（scenarios / summary / paths）
  var bindKey = tpl.value;     // 当前场景列表绑定的模板
  var rebindTimer = null;
  var scenarioSeq = 1;

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveStore() {
    try {
      var store = loadStore();
      store[bindKey] = {
        template: bindKey,
        scenarios: scenarios,
        saved_at: new Date().toISOString(),
      };
      // 最多保留 20 份模板的场景集，超出删除最旧的
      var keys = Object.keys(store).sort(function (a, b) {
        return String(store[a].saved_at || "").localeCompare(store[b].saved_at || "");
      });
      while (keys.length > 20) { delete store[keys.shift()]; }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) { /* 本地存储不可用时静默降级 */ }
  }

  function resetScenarioRuntime() {
    scenarioStatus = {};
    scenarioErrors = {};
    scenarioResults = {};
    lastMerge = null;
  }

  function bindTemplate(key) {
    saveStore();  // 保存上一份模板的场景
    bindKey = key;
    var entry = loadStore()[key];
    scenarios = entry && entry.scenarios ? entry.scenarios.slice() : [];
    scenarioSeq = scenarios.reduce(function (m, s) {
      return Math.max(m, parseInt(String(s.id).replace(/^s/, ""), 10) || 0);
    }, 0) + 1;
    resetScenarioRuntime();
    renderScenarios();
    renderMerge();
  }

  function scheduleRebind() {
    clearTimeout(rebindTimer);
    rebindTimer = setTimeout(function () {
      if (tpl.value !== bindKey) bindTemplate(tpl.value);
    }, 500);
  }

  tpl.addEventListener("input", scheduleRebind);

  function addScenario() {
    var vars = collectVariables();
    var n = scenarios.length + 1;
    var sc = {
      id: "s" + scenarioSeq++,
      name: "场景 " + n,
      locale: localeInput.value.trim() || "en",
      variables: vars,
    };
    scenarios.push(sc);
    saveStore();
    renderScenarios();
    toast("已保存当前 locale 与变量为场景");
  }

  function removeScenario(id) {
    scenarios = scenarios.filter(function (s) { return s.id !== id; });
    delete scenarioStatus[id];
    delete scenarioErrors[id];
    delete scenarioResults[id];
    saveStore();
    rebuildMerge();
    renderScenarios();
  }

  function loadScenarioIntoEditor(sc) {
    localeInput.value = sc.locale || "en";
    varRowsEl.innerHTML = "";
    Object.keys(sc.variables || {}).forEach(function (name) {
      var v = sc.variables[name];
      addVarRow(name, v === undefined || v === null ? "" : String(v));
    });
    scheduleAnalyze();
    toast("已载入「" + sc.name + "」到编辑器");
  }

  function statusBadge(status) {
    if (status === "running") return '<span class="sc-status sc-running">运行中…</span>';
    if (status === "passed") return '<span class="sc-status sc-passed">通过</span>';
    if (status === "failed") return '<span class="sc-status sc-failed">失败</span>';
    return '<span class="sc-status sc-idle">未运行</span>';
  }

  function renderScenarios() {
    scenarioCountEl.textContent = scenarios.length ? "（" + scenarios.length + "）" : "";
    scenarioListEl.innerHTML = "";
    if (!scenarios.length) {
      scenarioListEl.innerHTML =
        '<div class="empty">还没有场景。调好左侧的 locale 与变量后，点「保存当前为场景」。</div>';
      return;
    }
    scenarios.forEach(function (sc) {
      var row = document.createElement("div");
      row.className = "scenario-row";

      var head = document.createElement("div");
      head.className = "scenario-row-head";
      var nameInput = document.createElement("input");
      nameInput.className = "scenario-name";
      nameInput.value = sc.name || "";
      nameInput.title = "场景名称";
      nameInput.addEventListener("change", function () {
        sc.name = nameInput.value.trim() || ("场景 " + sc.id);
        nameInput.value = sc.name;
        saveStore();
        rebuildMerge();
      });
      head.appendChild(nameInput);
      var badgeWrap = document.createElement("span");
      badgeWrap.innerHTML = statusBadge(scenarioStatus[sc.id]);
      head.appendChild(badgeWrap);
      row.appendChild(head);

      var meta = document.createElement("div");
      meta.className = "scenario-meta";
      var varText = Object.keys(sc.variables || {})
        .map(function (k) { return k + "=" + JSON.stringify(sc.variables[k]); })
        .join(", ");
      meta.innerHTML = '<code>' + esc(sc.locale || "en") + "</code> " +
        esc(varText || "（无变量）");
      row.appendChild(meta);

      if (scenarioStatus[sc.id] === "failed" && scenarioErrors[sc.id]) {
        var err = document.createElement("div");
        err.className = "scenario-error";
        err.textContent = "✕ " + scenarioErrors[sc.id];
        row.appendChild(err);
      }

      var actions = document.createElement("div");
      actions.className = "scenario-row-actions";
      [
        { label: "载入", title: "把该场景的 locale 与变量载入编辑器", fn: function () { loadScenarioIntoEditor(sc); } },
        { label: "重跑", title: "仅重新运行该场景并更新合并结果", fn: function () { runScenarios([sc], false); } },
        { label: "删除", title: "删除该场景", cls: "sc-btn-del", fn: function () { removeScenario(sc.id); } },
      ].forEach(function (b) {
        var btn = document.createElement("button");
        btn.className = "btn btn-small" + (b.cls ? " " + b.cls : "");
        btn.textContent = b.label;
        btn.title = b.title;
        btn.addEventListener("click", b.fn);
        actions.appendChild(btn);
      });
      row.appendChild(actions);
      scenarioListEl.appendChild(row);
    });
  }

  /* 调用后端批量接口；单个场景失败由后端保留错误并继续其他场景。
     full=false（单场景重跑）时，合并结果用本地全部场景缓存重建。 */
  function runScenarios(list, full) {
    if (!list || !list.length) {
      toast("请先保存至少一个场景");
      return Promise.resolve(null);
    }
    list.forEach(function (sc) { scenarioStatus[sc.id] = "running"; });
    renderScenarios();
    return fetch("/api/scenarios/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: tpl.value,
        scenarios: list.map(function (sc) {
          return { id: sc.id, name: sc.name, locale: sc.locale, variables: sc.variables };
        }),
      }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "请求失败"); });
        return r.json();
      })
      .then(function (resp) {
        // 以本次结果更新各场景状态，并缓存完整 analyze 结果（供重跑后本地重建合并）
        resp.scenarios.forEach(function (s) {
          var sc = list.filter(function (x) { return String(x.id) === String(s.id); })[0];
          if (!sc) return;
          scenarioStatus[sc.id] = s.status;
          if (s.status === "failed") {
            scenarioErrors[sc.id] = s.error || "运行失败";
            delete scenarioResults[sc.id];
          } else {
            delete scenarioErrors[sc.id];
            if (s.result) scenarioResults[sc.id] = s.result;
          }
        });
        rebuildMerge(full !== false ? resp : null);
        renderScenarios();
        return lastMerge;
      })
      .catch(function (e) {
        list.forEach(function (sc) {
          scenarioStatus[sc.id] = "failed";
          scenarioErrors[sc.id] = String(e.message || e);
        });
        renderScenarios();
        toast("场景运行失败：" + (e.message || e));
        return null;
      });
  }

  /* 用本地缓存的 analyze 结果重建与后端一致的合并结构 */
  function rebuildMerge(fresh) {
    if (fresh && fresh.paths) {
      lastMerge = fresh;
    } else if (scenarios.some(function (s) { return scenarioStatus[s.id] === "passed"; })) {
      lastMerge = mergeFromCache();
    } else {
      lastMerge = null;
    }
    renderMerge();
  }

  /* 用本地缓存的 analyze 结果重建与后端一致的合并结构 */
  function mergeFromCache() {
    var merged = {};
    var order = 0;
    scenarios.forEach(function (sc) {
      if (scenarioStatus[sc.id] !== "passed") return;
      var r = scenarioResults[sc.id];
      if (!r) return;
      (r.paths || []).forEach(function (p) {
        var item = merged[p.key];
        if (!item) {
          order += 1;
          item = {
            id: order, key: p.key, conditions: p.conditions || [],
            outputs: {}, covered: false, covered_by: [],
          };
          merged[p.key] = item;
        }
        item.outputs[String(sc.id)] = p.output;
        if (p.covered) {
          item.covered = true;
          item.covered_by.push({ id: sc.id, name: sc.name });
        }
      });
    });
    var paths = Object.keys(merged).map(function (k) { return merged[k]; });
    var failed = scenarios.filter(function (s) { return scenarioStatus[s.id] === "failed"; }).length;
    var total = paths.length;
    var cov = paths.filter(function (p) { return p.covered; }).length;
    return {
      summary: {
        total_scenarios: scenarios.length,
        passed_scenarios: scenarios.length - failed,
        failed_scenarios: failed,
        total_paths: total,
        covered_paths: cov,
        uncovered_paths: total - cov,
        all_paths_covered: total > 0 && cov === total,
        truncated: scenarios.some(function (s) {
          var r = scenarioResults[s.id];
          return r && r.stats && r.stats.truncated;
        }),
      },
      scenarios: scenarios.map(function (s) {
        return {
          id: s.id, name: s.name, locale: s.locale,
          status: scenarioStatus[s.id], error: scenarioErrors[s.id],
        };
      }),
      paths: paths,
    };
  }

  function locatePath(key) {
    // 定位到右侧「可达分支路径」中的对应卡片并闪烁
    var card = pathsEl.querySelector('.path-card[data-key="' + cssEsc(key) + '"]');
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("path-flash");
      void card.offsetWidth;  // 重置动画
      card.classList.add("path-flash");
      return;
    }
    // 当前样例下该路径未展示（被截断或样例导致列表不同）→ 展开面板提示
    pathsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("该路径未在当前路径列表中展示，请查看面板中的触发条件");
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function renderMerge() {
    if (!lastMerge) {
      scenarioSummaryEl.textContent = "";
      scenarioProgressEl.hidden = true;
      scenarioPathsEl.innerHTML =
        '<div class="empty">尚未运行场景集。保存场景后点击「运行全部场景」。</div>';
      return;
    }
    var sm = lastMerge.summary || {};
    scenarioSummaryEl.textContent =
      "共 " + sm.total_paths + " 条路径 · 已覆盖 " + sm.covered_paths +
      " · 未覆盖 " + sm.uncovered_paths +
      (sm.truncated ? "（路径过多，部分未枚举）" : "") +
      "｜场景通过 " + sm.passed_scenarios + "/" + sm.total_scenarios +
      (sm.failed_scenarios ? "，失败 " + sm.failed_scenarios : "");

    var pct = sm.total_paths ? Math.round(100 * sm.covered_paths / sm.total_paths) : 0;
    scenarioProgressEl.hidden = false;
    scenarioProgressBarEl.style.width = pct + "%";
    scenarioProgressBarEl.className =
      "scenario-progress-bar" + (sm.all_paths_covered ? " done" : "");

    scenarioPathsEl.innerHTML = "";
    if (!lastMerge.paths.length) {
      scenarioPathsEl.innerHTML =
        '<div class="empty">没有可枚举的路径（场景可能全部失败，或模板不含分支）。</div>';
      return;
    }
    lastMerge.paths.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "spath-card" + (p.covered ? " covered" : " uncovered");
      var head = document.createElement("div");
      head.className = "spath-head";
      head.innerHTML = badge(p.covered, true, true) +
        '<span class="spath-id">#' + p.id + "</span>";
      if (!p.covered) {
        head.title = "点击定位到该路径的触发条件";
        head.addEventListener("click", function () { locatePath(p.key); });
      }
      var by = document.createElement("span");
      by.className = "spath-by";
      if (p.covered && p.covered_by && p.covered_by.length) {
        by.textContent = "由 " + p.covered_by.map(function (x) { return x.name; }).join("、") + " 覆盖";
      } else if (!p.covered) {
        by.textContent = "未覆盖 — 点击定位触发条件";
      }
      head.appendChild(by);
      card.appendChild(head);

      var conds = document.createElement("div");
      conds.className = "spath-conds";
      (p.conditions || []).forEach(function (c) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        conds.appendChild(chip);
      });
      card.appendChild(conds);
      scenarioPathsEl.appendChild(card);
    });
  }

  function exportScenarios() {
    if (!scenarios.length) { toast("没有可导出的场景"); return; }
    var doExport = function (merge) {
      var data = {
        tool: "icu-branch-previewer",
        exported_at: new Date().toISOString(),
        template: tpl.value,
        scenarios: scenarios.map(function (sc) {
          return { name: sc.name, locale: sc.locale, variables: sc.variables };
        }),
        summary: merge ? merge.summary : null,
        scenario_results: merge ? merge.scenarios.map(function (s) {
          return { name: s.name, locale: s.locale, status: s.status,
                   error: s.error || null };
        }) : [],
        merged_paths: merge ? merge.paths.map(function (p) {
          return {
            key: p.key, conditions: p.conditions, covered: p.covered,
            covered_by: p.covered_by, outputs: p.outputs,
          };
        }) : [],
      };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "icu-scenarios.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast("已导出场景 JSON");
    };
    // 导出前确保汇总结果为最新（运行失败也导出，结果中保留各场景错误）
    runScenarios(scenarios).then(function (resp) {
      doExport(resp || (lastMerge ? lastMerge : {
        summary: null, scenarios: scenarios.map(function (s) {
          return { name: s.name, locale: s.locale, variables: s.variables,
                   status: scenarioStatus[s.id], error: scenarioErrors[s.id] };
        }), paths: [],
      }));
    });
  }

  document.getElementById("btnAddScenario").addEventListener("click", addScenario);
  document.getElementById("btnRunScenarios")
    .addEventListener("click", function () { runScenarios(scenarios, true); });
  document.getElementById("btnExportScenarios").addEventListener("click", exportScenarios);

  /* ---------------- 版本对比 ---------------- */

  var BASELINE_KEY = "icu-preview-baseline-v1";
  var baselineInfoEl = document.getElementById("baselineInfo");
  var compareNoticesEl = document.getElementById("compareNotices");
  var baselineViewEl = document.getElementById("baselineView");
  var changeFiltersEl = document.getElementById("changeFilters");
  var changeListEl = document.getElementById("changeList");
  var compareSummaryEl = document.getElementById("compareSummary");
  var compareScenariosEl = document.getElementById("compareScenarios");
  var compareScenarioSummaryEl = document.getElementById("compareScenarioSummary");

  var baseline = null;        // {template, saved_at}
  var lastCompare = null;     // 最近一次 /api/compare 响应
  var changeFilter = "all";   // all | added | removed | condition | render

  var CHANGE_TYPES = [
    { key: "added", label: "新增", cls: "added" },
    { key: "removed", label: "删除", cls: "removed" },
    { key: "condition", label: "条件变化", cls: "condition" },
    { key: "render", label: "文本变化", cls: "render" },
  ];

  function loadBaseline() {
    try {
      var raw = localStorage.getItem(BASELINE_KEY);
      baseline = raw ? JSON.parse(raw) : null;
    } catch (e) { baseline = null; }
    if (!baseline || typeof baseline.template !== "string") baseline = null;
  }

  function persistBaseline() {
    try {
      if (baseline) localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
      else localStorage.removeItem(BASELINE_KEY);
    } catch (e) { /* 本地存储不可用时静默降级 */ }
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || "") : d.toLocaleString();
  }

  function renderBaselineMeta() {
    if (!baseline) {
      baselineInfoEl.innerHTML =
        '<span class="baseline-none">尚未设置基线。点击「设为基线」把当前模板保存为对比基准。</span>';
      return;
    }
    var same = baseline.template === tpl.value;
    baselineInfoEl.innerHTML =
      "基线保存于 " + esc(fmtTime(baseline.saved_at)) +
      " · 共 " + baseline.template.length + " 字符 · " +
      (same ? '<span class="badge badge-covered">与当前一致</span>'
            : '<span class="badge badge-uncovered">当前已修改</span>');
  }

  /* 基线只读视图；hi 非空时高亮 [pos, end) 片段并滚动到位 */
  function renderBaselineView(hi) {
    if (!baseline) {
      baselineViewEl.textContent = "（未设置基线）";
      return;
    }
    var t = baseline.template;
    if (!t) {
      baselineViewEl.textContent = "（基线为空模板）";
      return;
    }
    if (!hi || hi.pos === null || hi.pos === undefined) {
      baselineViewEl.textContent = t;
      return;
    }
    var a = Math.max(0, Math.min(t.length, hi.pos));
    var b = Math.max(a, Math.min(t.length, hi.end));
    baselineViewEl.innerHTML =
      esc(t.slice(0, a)) + '<mark class="bl-mark">' + esc(t.slice(a, b)) +
      "</mark>" + esc(t.slice(b));
    var mark = baselineViewEl.querySelector("mark");
    if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function typeBadgeHtml(type) {
    var t = CHANGE_TYPES.filter(function (x) { return x.key === type; })[0];
    return '<span class="chg-badge chg-' + (t ? t.cls : "render") + '">' +
      (t ? t.label : esc(type)) + "</span>";
  }

  /* 点击变更：在编辑器中选中当前版片段，并在基线视图中高亮基线片段 */
  function locateChange(c) {
    if (c.new && c.new.pos !== null && c.new.pos !== undefined) {
      tpl.focus();
      tpl.setSelectionRange(c.new.pos, c.new.end);
      var wrap = document.getElementById("editorWrap");
      wrap.classList.remove("editor-flash");
      void wrap.offsetWidth;
      wrap.classList.add("editor-flash");
    }
    if (c.old && c.old.pos !== null && c.old.pos !== undefined) {
      renderBaselineView(c.old);
    } else {
      renderBaselineView(null);
    }
  }

  function renderChangeFilters() {
    var counts = { all: (lastCompare.changes || []).length };
    CHANGE_TYPES.forEach(function (t) { counts[t.key] = 0; });
    (lastCompare.changes || []).forEach(function (c) {
      counts[c.type] = (counts[c.type] || 0) + 1;
    });
    var html = "";
    function chip(key, label) {
      return '<button class="filter-chip filter-' + key +
        (changeFilter === key ? " active" : "") + '" data-filter="' + key + '">' +
        label + " " + (counts[key] || 0) + "</button>";
    }
    html += chip("all", "全部");
    CHANGE_TYPES.forEach(function (t) { html += chip(t.key, t.label); });
    changeFiltersEl.innerHTML = html;
    changeFiltersEl.querySelectorAll(".filter-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        changeFilter = btn.getAttribute("data-filter");
        renderChangeFilters();
        renderChangeList();
      });
    });
  }

  function renderChangeList() {
    var all = lastCompare.changes || [];
    var list = all.filter(function (c) {
      return changeFilter === "all" || c.type === changeFilter;
    });
    changeListEl.innerHTML = "";
    if (!list.length) {
      changeListEl.innerHTML = '<div class="empty">' +
        (all.length ? "该类型下没有变更。" : "两版模板结构一致，没有检测到变更。") +
        "</div>";
      return;
    }
    list.forEach(function (c) {
      var card = document.createElement("div");
      card.className = "chg-card chg-" + c.type;
      card.title = "点击定位两版对应片段";

      var head = document.createElement("div");
      head.className = "chg-head";
      head.innerHTML = typeBadgeHtml(c.type) +
        '<span class="chg-path">' + esc(c.path) + "</span>";
      card.appendChild(head);

      var detail = document.createElement("div");
      detail.className = "chg-detail";
      detail.textContent = c.detail || "";
      card.appendChild(detail);

      if (c.old || c.new) {
        var snips = document.createElement("div");
        snips.className = "chg-snips";
        if (c.old) {
          snips.innerHTML += '<div class="chg-snip old">' +
            '<span class="chg-side">基线</span><code>' +
            esc(c.old.text || "（空）") + "</code></div>";
        }
        if (c.new) {
          snips.innerHTML += '<div class="chg-snip new">' +
            '<span class="chg-side">当前</span><code>' +
            esc(c.new.text || "（空）") + "</code></div>";
        }
        card.appendChild(snips);
      }
      card.addEventListener("click", function () { locateChange(c); });
      changeListEl.appendChild(card);
    });
  }

  function renderCompareScenarios() {
    var sc = lastCompare.scenarios || { items: [] };
    if (!sc.total) {
      compareScenarioSummaryEl.textContent = "";
      compareScenariosEl.innerHTML =
        '<div class="empty">没有保存的场景。在「场景集回归」面板保存场景后，' +
        "对比时会自动在两版分别回放。</div>";
      return;
    }
    compareScenarioSummaryEl.textContent =
      "共 " + sc.total + " 个场景 · 输出变化 " + sc.changed +
      (sc.old_failed ? " · 基线侧失败 " + sc.old_failed : "") +
      (sc.new_failed ? " · 当前侧失败 " + sc.new_failed : "");
    compareScenariosEl.innerHTML = "";
    sc.items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "creplay-row" + (item.changed ? " changed" : "");

      var head = document.createElement("div");
      head.className = "creplay-head";
      head.innerHTML = '<span class="creplay-name">' + esc(item.name) + "</span>" +
        "<code>" + esc(item.locale || "en") + "</code>" +
        (item.changed
          ? '<span class="badge badge-uncovered">输出有变化</span>'
          : '<span class="badge badge-covered">输出一致</span>');
      row.appendChild(head);

      [["old", "基线"], ["new", "当前"]].forEach(function (side) {
        var s = item[side[0]];
        var div = document.createElement("div");
        div.className = "creplay-side";
        if (s.status === "passed") {
          div.innerHTML = '<span class="chg-side">' + side[1] + "</span>" +
            '<span class="creplay-out">' + esc(s.output || "（空）") + "</span>";
        } else {
          div.innerHTML = '<span class="chg-side">' + side[1] + "</span>" +
            '<span class="creplay-err">✕ ' + esc(s.error || "运行失败") + "</span>";
        }
        row.appendChild(div);
      });
      compareScenariosEl.appendChild(row);
    });
  }

  function renderCompare() {
    var sm = lastCompare.summary || {};
    compareSummaryEl.textContent =
      "新增 " + (sm.added || 0) + " · 删除 " + (sm.removed || 0) +
      " · 条件变化 " + (sm.condition || 0) + " · 文本变化 " + (sm.render || 0);

    // 单侧解析错误：保留该侧错误提示，差异基于可恢复部分计算
    var notices = "";
    [["old", "基线"], ["new", "当前"]].forEach(function (side) {
      var s = lastCompare[side[0]];
      if (!s || s.ok) return;
      var msgs = (s.errors || []).map(function (e) { return e.message; })
        .join("；");
      notices += '<div class="msg msg-error"><span class="tag">' + side[1] +
        "有错误</span><span>" + esc(msgs || "解析失败") +
        "（差异基于可恢复部分计算）</span></div>";
    });
    compareNoticesEl.innerHTML = notices;

    renderChangeFilters();
    renderChangeList();
    renderCompareScenarios();
  }

  /* 基线快照的场景 + 当前场景，按内容去重后用于两版回放 */
  function compareScenarioList() {
    var seen = {};
    var merged = [];
    function addAll(list) {
      (list || []).forEach(function (sc) {
        var key = JSON.stringify([sc.name, sc.locale, sc.variables]);
        if (seen[key]) return;
        seen[key] = true;
        merged.push({ name: sc.name, locale: sc.locale,
                      variables: sc.variables });
      });
    }
    addAll(baseline && baseline.scenarios);
    addAll(scenarios);
    merged.forEach(function (sc, i) { sc.id = "c" + (i + 1); });
    return merged;
  }

  function runCompare() {
    if (!baseline) {
      toast("请先点击「设为基线」保存当前模板为基线");
      return Promise.resolve(null);
    }
    compareSummaryEl.textContent = "对比中…";
    return fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        old_template: baseline.template,
        new_template: tpl.value,
        scenarios: compareScenarioList(),
      }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "请求失败"); });
        return r.json();
      })
      .then(function (resp) {
        lastCompare = resp;
        changeFilter = "all";
        renderCompare();
        return resp;
      })
      .catch(function (e) {
        compareSummaryEl.textContent = "";
        changeListEl.innerHTML =
          '<div class="empty">对比失败：' + esc(e.message || e) + "</div>";
        toast("对比失败：" + (e.message || e));
        return null;
      });
  }

  document.getElementById("btnSetBaseline").addEventListener("click", function () {
    baseline = {
      template: tpl.value,
      saved_at: new Date().toISOString(),
      // 快照当前场景：继续编辑后场景列表会切换到新模板的集合，
      // 对比时把基线快照与当前场景合并回放，保证回归不丢场景
      scenarios: scenarios.map(function (sc) {
        return { id: sc.id, name: sc.name, locale: sc.locale,
                 variables: sc.variables };
      }),
    };
    persistBaseline();
    renderBaselineMeta();
    renderBaselineView(null);
    toast("已把当前模板设为基线");
  });

  document.getElementById("btnRunCompare").addEventListener("click", runCompare);

  document.getElementById("btnClearBaseline").addEventListener("click", function () {
    baseline = null;
    lastCompare = null;
    persistBaseline();
    renderBaselineMeta();
    renderBaselineView(null);
    compareSummaryEl.textContent = "";
    compareNoticesEl.innerHTML = "";
    changeFiltersEl.innerHTML = "";
    changeListEl.innerHTML =
      '<div class="empty">尚未对比。设置基线并继续编辑后，点击「与基线对比」。</div>';
    compareScenarioSummaryEl.textContent = "";
    compareScenariosEl.innerHTML =
      '<div class="empty">对比时会把已保存的场景在基线版与当前版分别运行。</div>';
    toast("已清除基线");
  });

  // 编辑时刷新基线状态徽标（与当前一致 / 当前已修改）
  tpl.addEventListener("input", function () {
    if (baseline) renderBaselineMeta();
  });

  /* ---------------- 变量契约审计 ---------------- */

  var auditContractsEl = document.getElementById("auditContracts");
  var auditVarCountEl = document.getElementById("auditVarCount");
  var auditScenariosEl = document.getElementById("auditScenarios");
  var auditScenarioMetaEl = document.getElementById("auditScenarioMeta");
  var auditSummaryBarEl = document.getElementById("auditSummaryBar");
  var auditSchemaEl = document.getElementById("auditSchema");
  var auditImportFileEl = document.getElementById("auditImportFile");

  var lastAudit = null;        // 最近一次 /api/contract-audit 响应
  var auditScenariosInput = []; // 导入的场景（为空时使用已保存场景）
  var auditSource = "saved";   // saved | imported
  var auditTimer = null;

  function auditCodeLabel(code) {
    return {
      missing: "缺失变量",
      missing_optional: "缺失可选变量",
      type: "类型冲突",
      invalid_plural: "无效复数值",
      unused: "多余变量",
    }[code] || code;
  }

  function auditCodeBadge(code, severity) {
    var cls = severity === "warning" ? "warning" : code;
    return '<span class="audit-badge audit-' + cls + '">' +
      auditCodeLabel(code) + "</span>";
  }

  /* 规范化导入的场景：支持 {scenarios:[...]} 包装格式与裸数组 */
  function normalizeImportedScenarios(data) {
    var list = Array.isArray(data) ? data
      : (data && Array.isArray(data.scenarios)) ? data.scenarios : null;
    if (!list) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      var vars = s.variables;
      if (vars === undefined || vars === null) vars = {};
      if (typeof vars !== "object" || Array.isArray(vars)) continue;
      out.push({
        id: s.id == null ? "i" + (i + 1) : s.id,
        name: String(s.name == null || s.name === "" ? "导入场景 " + (i + 1) : s.name),
        locale: typeof s.locale === "string" && s.locale.trim() ? s.locale : "en",
        variables: vars,
      });
    }
    return out;
  }

  function runAudit(list, source) {
    auditScenariosInput = list || [];
    auditSource = source || (list && list.length ? "imported" : "saved");
    return fetch("/api/contract-audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: tpl.value,
        locale: localeInput.value.trim() || "en",
        scenarios: auditScenariosInput,
      }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "请求失败"); });
        return r.json();
      })
      .then(function (resp) {
        lastAudit = resp;
        renderAudit();
        return resp;
      })
      .catch(function (e) {
        auditSummaryBarEl.innerHTML =
          '<span class="audit-bar-error">✕ 审计失败：' + esc(e.message || e) + "</span>";
        toast("契约审计失败：" + (e.message || e));
        return null;
      });
  }

  function scheduleAudit(list, source) {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(function () { runAudit(list, source); }, 400);
  }

  function valuePreview(v) {
    var s;
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
    if (s === undefined) s = String(v);
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }

  function locateTemplatePos(pos) {
    if (pos === null || pos === undefined) return;
    tpl.focus();
    tpl.setSelectionRange(pos, Math.min(tpl.value.length, pos + 1));
    tpl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderAudit() {
    if (!lastAudit) return;
    var a = lastAudit;

    if (!a.ok) {
      auditSummaryBarEl.innerHTML =
        '<span class="audit-bar-error">✕ 模板存在 ' + (a.errors || []).length +
        " 个语法错误，无法推导契约，请先修正模板</span>";
      auditContractsEl.innerHTML = "";
      auditScenariosEl.innerHTML = "";
      auditSchemaEl.textContent = "（模板有语法错误）";
      return;
    }

    var sm = a.summary || {};
    var bar =
      '<span class="audit-bar-item"><b>' + sm.variables_total + "</b> 个变量" +
      "（必需 <b>" + sm.required_total + "</b>）</span>" +
      '<span class="audit-bar-item">场景通过 <b>' +
      sm.passed_scenarios + "/" + sm.total_scenarios + "</b></span>" +
      '<span class="audit-bar-item audit-cnt-error">缺失 <b>' + sm.missing_count +
      "</b></span>" +
      '<span class="audit-bar-item audit-cnt-warning">缺失可选 <b>' +
      (sm.missing_optional_count || 0) + "</b></span>" +
      '<span class="audit-bar-item audit-cnt-error">类型冲突 <b>' + sm.type_count +
      "</b></span>" +
      '<span class="audit-bar-item audit-cnt-error">无效复数值 <b>' +
      sm.invalid_plural_count + "</b></span>" +
      '<span class="audit-bar-item audit-cnt-warning">多余变量 <b>' +
      sm.unused_count + "</b></span>";
    if (sm.conflicting_total) {
      bar += '<span class="audit-bar-item audit-cnt-error">契约冲突 <b>' +
        sm.conflicting_total + "</b></span>";
    }
    if (sm.paths_truncated) {
      bar += '<span class="audit-bar-item audit-cnt-warning">分支路径过多，必需性为近似结果</span>';
    }
    bar += '<span class="audit-bar-source">样例来源：' +
      (auditSource === "imported"
        ? "导入文件（" + auditScenariosInput.length + " 组）"
        : "已保存场景（" + scenarios.length + " 组）") + "</span>";
    auditSummaryBarEl.innerHTML = bar;

    auditVarCountEl.textContent = "（" + sm.variables_total + "）";

    /* ---- 契约卡片 ---- */
    auditContractsEl.innerHTML = "";
    if (!(a.contracts || []).length) {
      auditContractsEl.innerHTML = '<div class="empty">模板没有使用任何变量。</div>';
    }
    (a.contracts || []).forEach(function (c) {
      var card = document.createElement("div");
      card.className = "contract-card" +
        (c.conflicting ? " contract-conflict" : "") +
        (c.issues && c.issues.length ? "" : " contract-clean");

      var head = document.createElement("div");
      head.className = "contract-head";
      var typeText = c.conflicting ? "无兼容类型" : c.allowed_types.join(" / ");
      head.innerHTML =
        '<code class="contract-name">' + esc(c.name) + "</code>" +
        '<span class="contract-types">' + esc(typeText) + "</span>" +
        (c.required
          ? '<span class="audit-badge audit-required">必需</span>'
          : '<span class="audit-badge audit-optional">可选</span>') +
        c.context_labels.map(function (l) {
          return '<span class="contract-ctx">' + esc(l) + "</span>";
        }).join("");
      var locBtn = document.createElement("button");
      locBtn.className = "btn btn-small contract-locate";
      locBtn.textContent = "第 " + c.line + ":" + c.col + " 行";
      locBtn.title = "点击在模板中定位首次出现位置";
      locBtn.addEventListener("click", function () { locateTemplatePos(c.first_pos); });
      head.appendChild(locBtn);
      card.appendChild(head);

      if (c.selectors && c.selectors.length) {
        var sel = document.createElement("div");
        sel.className = "contract-selectors";
        sel.innerHTML = '<span class="contract-sub">select 取值：</span>' +
          c.selectors.map(function (s) {
            return '<code>' + esc(s) + "</code>";
          }).join(" ");
        card.appendChild(sel);
      }

      if (c.notes && c.notes.length) {
        var notes = document.createElement("div");
        notes.className = "contract-notes";
        notes.innerHTML = c.notes.map(function (n) {
          return "⚠ " + esc(n);
        }).join("<br>");
        card.appendChild(notes);
      }

      (c.issues || []).forEach(function (it) {
        var issue = document.createElement("div");
        issue.className = "contract-issue audit-sev-" + it.severity;
        var occText = it.count > 1
          ? "（首次：" + (it.first.scenario_name || "场景 " + (it.first.scenario_index + 1)) +
            "，共 " + it.count + " 次）"
          : "（" + (it.first.scenario_name || "场景 " + (it.first.scenario_index + 1)) + "）";
        issue.innerHTML = auditCodeBadge(it.code, it.severity) +
          '<span class="issue-msg">' + esc(it.message) + "</span>" +
          '<span class="issue-occ">' + esc(occText) + "</span>";
        card.appendChild(issue);
      });

      // 每个变量的 schema 片段，便于单独复制
      var frag = a.json_schema.properties[c.name];
      if (frag) {
        var schemaRow = document.createElement("div");
        schemaRow.className = "contract-schema-row";
        var copyBtn = document.createElement("button");
        copyBtn.className = "btn btn-small";
        copyBtn.textContent = "复制该变量 Schema";
        copyBtn.addEventListener("click", function () {
          var obj = {};
          obj[c.name] = frag;
          copyText(JSON.stringify(obj, null, 2), "已复制变量 " + c.name + " 的 Schema 片段");
        });
        schemaRow.appendChild(copyBtn);
        card.appendChild(schemaRow);
      }

      auditContractsEl.appendChild(card);
    });

    // 模板未使用但场景提供的变量（unused 聚合项没有契约卡片）
    (a.orphan_issues || []).forEach(function (it) {
      var card = document.createElement("div");
      card.className = "contract-card contract-orphan";
      var occText = it.count > 1
        ? "（首次：" + (it.first.scenario_name || "场景 " + (it.first.scenario_index + 1)) +
          "，共 " + it.count + " 次）"
        : "（" + (it.first.scenario_name || "场景 " + (it.first.scenario_index + 1)) + "）";
      card.innerHTML =
        '<div class="contract-head"><code class="contract-name">' +
        esc(it.variable) + "</code>" + auditCodeBadge(it.code, it.severity) +
        '<span class="issue-occ">' + esc(occText) + "</span></div>" +
        '<div class="contract-issue audit-sev-warning">' +
        '<span class="issue-msg">' + esc(it.message) + "</span></div>";
      auditContractsEl.appendChild(card);
    });

    /* ---- 场景结果 ---- */
    auditScenarioMetaEl.textContent =
      "（" + sm.passed_scenarios + "/" + sm.total_scenarios + " 通过）";
    auditScenariosEl.innerHTML = "";
    if (!(a.scenarios || []).length) {
      auditScenariosEl.innerHTML =
        '<div class="empty">没有场景样例。可在「场景集回归」保存场景，或导入场景 JSON 后审计。' +
        "不含场景时仅推导变量契约与 JSON Schema。</div>";
    }
    (a.scenarios || []).forEach(function (s, sidx) {
      var row = document.createElement("div");
      row.className = "audit-scenario-row audit-sc-" + s.status;
      var issues = (a.flat_issues || []).filter(function (f) {
        return f.scenario_index === sidx;
      });
      var html = '<div class="audit-sc-head">' +
        '<span class="audit-sc-name">' + esc(s.name || ("场景 " + s.id)) + "</span>" +
        "<code>" + esc(s.locale || "en") + "</code>";
      if (s.status === "failed") {
        html += '<span class="audit-badge audit-missing">失败 · ' +
          s.issue_count + " 个错误</span>";
      } else if (s.status === "passed") {
        html += '<span class="audit-badge audit-ok">通过</span>';
      }
      html += "</div>";
      if (s.error) {
        html += '<div class="audit-sc-err">✕ ' + esc(s.error) + "</div>";
      }
      issues.forEach(function (f) {
        html += '<div class="audit-sc-issue audit-sev-' + f.severity + '">' +
          auditCodeBadge(f.code, f.severity) +
          '<code class="audit-sc-var">' + esc(f.variable) + "</code>" +
          '<span>' + esc(f.message.replace(/^变量 '[^']*' /, "")) + "</span></div>";
      });
      row.innerHTML = html;
      auditScenariosEl.appendChild(row);
    });

    auditSchemaEl.textContent = JSON.stringify(a.json_schema, null, 2);
  }

  document.getElementById("btnAuditSaved").addEventListener("click", function () {
    if (!scenarios.length) {
      toast("「场景集回归」中还没有已保存的场景");
      return;
    }
    runAudit(scenarios.map(function (sc) {
      return { id: sc.id, name: sc.name, locale: sc.locale,
               variables: sc.variables };
    }), "saved");
  });

  document.getElementById("btnAuditImport").addEventListener("click", function () {
    auditImportFileEl.value = "";
    auditImportFileEl.click();
  });

  auditImportFileEl.addEventListener("change", function () {
    var file = auditImportFileEl.files && auditImportFileEl.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { toast("导入失败：文件不是合法 JSON"); return; }
      var list = normalizeImportedScenarios(data);
      if (!list) {
        toast("导入失败：需要场景数组或包含 scenarios 数组的对象");
        return;
      }
      toast("已导入 " + list.length + " 组场景");
      runAudit(list, "imported");
    };
    reader.readAsText(file);
  });

  document.getElementById("btnAuditCopySchema").addEventListener("click", function () {
    if (!lastAudit || !lastAudit.json_schema) {
      toast("请先运行一次审计");
      return;
    }
    copyText(JSON.stringify(lastAudit.json_schema, null, 2), "已复制 JSON Schema 草案");
  });

  document.getElementById("btnExportAudit").addEventListener("click", function () {
    if (!lastAudit) { toast("请先运行一次审计"); return; }
    var data = {
      tool: "icu-branch-previewer",
      report: "variable-contract-audit",
      exported_at: new Date().toISOString(),
      template: tpl.value,
      locale: localeInput.value.trim() || "en",
      scenario_source: auditSource,
      scenarios: auditScenariosInput.map(function (sc) {
        return { id: sc.id, name: sc.name, locale: sc.locale,
                 variables: sc.variables };
      }),
      summary: lastAudit.summary,
      contracts: lastAudit.contracts,
      issues: lastAudit.issues,
      scenario_results: lastAudit.scenarios,
      json_schema: lastAudit.json_schema,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "icu-contract-audit.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast("已导出审计 JSON");
  });

  // 模板变化时，若已有审计结果则自动重跑（导入/已保存场景保持来源不变）
  tpl.addEventListener("input", function () {
    if (lastAudit) {
      var list = auditSource === "saved"
        ? scenarios.map(function (sc) {
            return { id: sc.id, name: sc.name, locale: sc.locale,
                     variables: sc.variables };
          })
        : auditScenariosInput;
      scheduleAudit(list, auditSource);
    }
  });

  /* ---------------- 初始化 ---------------- */

  tpl.value = DEFAULT_TEMPLATE;
  addVarRow("gender", "female");
  addVarRow("count", "3");
  bindTemplate(tpl.value);
  loadBaseline();
  renderBaselineMeta();
  renderBaselineView(null);
  analyze();
})();
