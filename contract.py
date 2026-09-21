"""变量契约审计：根据模板 AST 推导变量类型契约并审计场景样例。

对每个模板变量，汇总其在五类语法位置中的用法：

- 简单占位 ``{name}``                 → simple
- 数字格式化 ``{n, number}``          → number
- 复数 ``{n, plural, ...}``           → plural
- 序数 ``{n, selectordinal, ...}``    → selectordinal
- 选择 ``{g, select, ...}``           → select

由此推导：
- 允许的 JSON 类型（多类用法取交集；交集为空说明模板自相矛盾）；
- 必需性（变量是否出现在每一条结构上可能的分支路径上，与 locale 无关）；
- select 允许的取值集合（多个 select 用法取交集，空集标记契约冲突）。

再对多组场景样例批量审计，按变量聚合四类问题：

- missing        缺失必需变量
- missing_optional 缺失可选变量（仅部分分支使用，警告）
- type           类型冲突（如 plural 给了字符串、select 给了数字）
- invalid_plural 复数值无效（plural 给了 NaN/Infinity，
                   或 selectordinal 给了非整数——序数规则只适用于整数）
- unused         场景提供了模板未使用的变量（警告）

最后按契约生成可复制的 JSON Schema 草案。
"""
from __future__ import annotations

import json
import math

from icu import (
    MAX_TEMPLATE_LEN, Arg, FmtArg, Parser, Plural, Select,
)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 各语法位置允许的 JSON 类型
_CONTEXT_TYPES = {
    "simple": ["string", "number", "boolean"],
    "number": ["number"],
    "plural": ["number"],
    "selectordinal": ["number"],
    "select": ["string"],
}

_CONTEXT_LABELS = {
    "simple": "简单占位",
    "number": "number 数字格式化",
    "plural": "plural 复数",
    "selectordinal": "selectordinal 序数",
    "select": "select 选择",
}

# 问题严重级别
_SEVERITY = {
    "missing": "error",
    "missing_optional": "warning",
    "type": "error",
    "invalid_plural": "error",
    "unused": "warning",
}

_STRUCT_PATH_CAP = 10000  # 必需性推导时枚举结构路径的上限

_OCCURRENCE_LIMIT = 20   # 聚合问题中保留的场景明细上限


# ---------------------------------------------------------------------------
# AST 遍历：用法收集与结构路径
# ---------------------------------------------------------------------------

def _line_col(template: str, pos: int) -> tuple[int, int]:
    pos = max(0, min(pos, len(template)))
    line = template.count("\n", 0, pos) + 1
    last_nl = template.rfind("\n", 0, pos)
    return line, pos - last_nl


def collect_usages(parts: list) -> list[dict]:
    """先序遍历 AST，收集每个变量的每次语法用法。

    返回 [{name, context, pos, style, selectors}]，按出现位置排序。
    """
    out: list[dict] = []

    def walk(frag: list):
        for node in frag:
            if isinstance(node, Arg):
                out.append({"name": node.name, "context": "simple",
                            "pos": node.pos, "style": None, "selectors": None})
            elif isinstance(node, FmtArg):
                ctx = "number" if node.fmt == "number" else "simple"
                out.append({"name": node.name, "context": ctx,
                            "pos": node.pos, "style": node.style,
                            "selectors": None})
            elif isinstance(node, Plural):
                out.append({"name": node.name, "context": node.kind,
                            "pos": node.pos, "style": None, "selectors": None})
                for b in node.branches:
                    walk(b.message)
            elif isinstance(node, Select):
                out.append({
                    "name": node.name, "context": "select",
                    "pos": node.pos, "style": None,
                    "selectors": [b.selector for b in node.branches],
                })
                for b in node.branches:
                    walk(b.message)

    walk(parts)
    out.sort(key=lambda u: u["pos"])
    return out


def structural_path_vars(parts: list,
                         cap: int = _STRUCT_PATH_CAP) -> tuple[list[set], bool]:
    """枚举每一条结构上可能的分支路径上使用的变量集合。

    与 locale 无关：即使某个复数类别在当前语言环境下不可达，对应分支
    仍是模板契约的一部分。返回 (路径变量集合列表, 是否被 cap 截断)。
    """
    results: list[set] = []
    truncated = False

    def rec(frag: list, acc: set):
        nonlocal truncated
        if len(results) >= cap:
            truncated = True
            return
        acc = set(acc)
        first_branch = None
        for i, node in enumerate(frag):
            if isinstance(node, (Arg, FmtArg)):
                acc.add(node.name)
            elif isinstance(node, (Plural, Select)):
                first_branch = i
                break
        if first_branch is None:
            results.append(acc)
            return
        node = frag[first_branch]
        acc.add(node.name)
        tail = frag[first_branch + 1:]
        for b in node.branches:
            if len(results) >= cap:
                truncated = True
                return
            # 分支消息 + 当前层级的后续片段一起下钻，
            # 保证分支之后的兄弟变量计入每一条路径
            rec(list(b.message) + tail, acc)

    rec(parts, set())
    return results, truncated


# ---------------------------------------------------------------------------
# 契约推导
# ---------------------------------------------------------------------------

def _ordered_intersect(lists: list[list[str]], first: list[str]) -> list[str]:
    """以 first 的顺序为基准，求各列表的有序交集。"""
    if not lists:
        return list(first)
    sets = [set(x) for x in lists]
    return [x for x in first if all(x in s for s in sets)]


def build_contracts(parts: list, template: str) -> tuple[list[dict], bool]:
    """根据 AST 构造变量契约列表。

    返回 (contracts, paths_truncated)。契约按首次出现位置排序。
    """
    usages = collect_usages(parts)
    path_sets, truncated = structural_path_vars(parts)

    required: set[str] = (set.intersection(*path_sets)
                          if path_sets else set())
    used_names = {u["name"] for u in usages}

    by_name: dict[str, list[dict]] = {}
    for u in usages:
        by_name.setdefault(u["name"], []).append(u)

    contracts: list[dict] = []
    for name in sorted(used_names, key=lambda n: by_name[n][0]["pos"]):
        ulist = by_name[name]
        first = ulist[0]
        contexts = []
        for u in ulist:
            if u["context"] not in contexts:
                contexts.append(u["context"])

        # 允许类型 = 各用法允许类型的交集
        allowed = set(_CONTEXT_TYPES[first["context"]])
        for u in ulist[1:]:
            allowed &= set(_CONTEXT_TYPES[u["context"]])
        ordered_allowed = [t for t in ("string", "number", "boolean")
                           if t in allowed]

        # select 取值集合：多个 select 用法取交集
        select_usages = [u for u in ulist if u["context"] == "select"]
        selectors = None
        selector_conflict = False
        if select_usages:
            base = []
            for s in select_usages[0]["selectors"]:
                if s not in base:
                    base.append(s)
            others = [u["selectors"] for u in select_usages[1:]]
            selectors = _ordered_intersect(others, base)
            if not selectors:
                selector_conflict = True

        notes: list[str] = []
        number_percent = any(u["context"] == "number"
                             and u["style"] == "percent" for u in ulist)
        if number_percent:
            notes.append("number 使用了 percent 百分比样式")
        if not ordered_allowed:
            labels = "、".join(_CONTEXT_LABELS[c] for c in contexts)
            notes.append(
                f"模板中的类型要求自相矛盾：该变量同时用于{labels}，"
                "没有任何 JSON 类型能同时满足，请统一其用法")
        if selector_conflict:
            notes.append(
                "多个 select 的取值集合没有公共项：任何取值都至少在一个 "
                "select 中落入 other，已不在 JSON Schema 中生成 enum 约束")

        line, col = _line_col(template, first["pos"])
        contracts.append({
            "name": name,
            "contexts": contexts,
            "context_labels": [_CONTEXT_LABELS[c] for c in contexts],
            "allowed_types": ordered_allowed,
            "conflicting": not ordered_allowed,
            "required": name in required,
            "selectors": selectors,
            "selector_conflict": selector_conflict,
            "has_other": any(
                u["context"] == "select" and "other" in (u["selectors"] or [])
                for u in ulist),
            "number_percent": number_percent,
            "notes": notes,
            "usage_count": len(ulist),
            "first_pos": first["pos"],
            "line": line,
            "col": col,
        })
    return contracts, truncated


# ---------------------------------------------------------------------------
# 场景值类型判断
# ---------------------------------------------------------------------------

def _json_type(value) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "number"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "null"
    if isinstance(value, (list, tuple)):
        return "array"
    return "object"


def _show(value) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=True)
    except (TypeError, ValueError):
        return repr(value)


def _check_value(name: str, value, contract: dict) -> dict | None:
    """检查单个场景中一个变量的取值，返回问题 dict 或 None。"""
    contexts = contract["contexts"]
    jtype = _json_type(value)

    # 模板用法自相矛盾时，样例值的对错无从判定（契约本身已报冲突）
    if contract["conflicting"]:
        return None

    # 每个用法上下文都要满足；以第一个不满足的上下文为准
    for ctx in contexts:
        allowed = _CONTEXT_TYPES[ctx]
        if jtype in allowed:
            if ctx in ("plural", "selectordinal"):
                bad = _invalid_plural_value(name, value, ctx)
                if bad:
                    return {"code": "invalid_plural", "context": ctx,
                            "message": bad}
            continue
        # 类型不匹配
        if ctx == "select" and jtype == "string":
            continue  # 字符串即合法；未命中的取值由 other 兜底
        if ctx == "select":
            return {
                "code": "type", "context": ctx,
                "message": f"变量 '{name}' 用于 select 选择，需要字符串"
                           f"（JSON string），当前为 {jtype}：{_show(value)}"
                           "（select 按字符串精确匹配）",
            }
        if ctx in ("number", "plural", "selectordinal"):
            return {
                "code": "type", "context": ctx,
                "message": f"变量 '{name}' 用于 {_CONTEXT_LABELS[ctx]}，"
                           f"需要数字（JSON number），当前为 {jtype}："
                           f"{_show(value)}",
            }
        # simple
        if jtype in ("null", "object", "array"):
            return {
                "code": "type", "context": ctx,
                "message": f"变量 '{name}' 用于简单占位，需要标量值"
                           f"（字符串 / 数字 / 布尔），当前为 {jtype}："
                           f"{_show(value)}",
            }
    return None


def _invalid_plural_value(name: str, value, ctx: str) -> str | None:
    """复数值的进一步检查：有限性与（序数的）整数性。"""
    if isinstance(value, bool):
        return None  # 布尔已按类型冲突处理
    if not isinstance(value, (int, float)):
        return None
    fv = float(value)
    if math.isnan(fv) or math.isinf(fv):
        shown = "NaN" if math.isnan(fv) else ("Infinity" if fv > 0 else "-Infinity")
        return (f"变量 '{name}' 用于 {_CONTEXT_LABELS[ctx]}，"
                f"需要有限数字，当前为 {shown}（无法匹配任何复数分支）")
    if ctx == "selectordinal" and fv != int(fv):
        return (f"变量 '{name}' 用于序数（selectordinal）：序数规则只适用于"
                f"整数，非整数 {_fmt_num(fv)} 始终落入 other 分支")
    return None


def _fmt_num(v: float) -> str:
    if float(v) == int(v) and abs(v) < 1e15:
        return str(int(v))
    return str(v)


# ---------------------------------------------------------------------------
# 顶层审计
# ---------------------------------------------------------------------------

def audit_contract(template: str, scenarios: list[dict],
                   locale: str = "en") -> dict:
    """推导变量契约并批量审计场景样例。

    scenarios 中每项为 {id?, name?, locale?, variables?}；单场景请求级
    错误（locale / variables 非法）标记 failed 但不中断整批。
    """
    template = template or ""
    scenarios = scenarios or []

    if len(template) > MAX_TEMPLATE_LEN:
        return {
            "ok": False,
            "errors": [{"message": f"模板过长（>{MAX_TEMPLATE_LEN} 字符）",
                        "pos": 0, "length": 1, "line": 1, "col": 1,
                        "severity": "error"}],
        }

    parser = Parser(template)
    parts = parser.parse()
    if parser.errors:
        return {"ok": False, "errors": parser.errors,
                "error_count": len(parser.errors)}

    contracts, paths_truncated = build_contracts(parts, template)
    contract_by_name = {c["name"]: c for c in contracts}

    # 聚合：(变量, code) -> 问题；保留首次出现位置
    agg: dict[tuple[str, str], dict] = {}
    flat_issues: list[dict] = []
    out_scenarios: list[dict] = []

    def add_issue(code: str, name: str, sc: dict | None, sc_index: int,
                  message: str, context: str | None, value, pos,
                  severity: str | None = None):
        key = (name, code)
        severity = severity or _SEVERITY[code]
        item = agg.get(key)
        occ = {"scenario_id": sc.get("id") if sc else None,
               "scenario_name": sc.get("name") if sc else None,
               "scenario_index": sc_index,
               "value": value}
        if item is None:
            if isinstance(pos, int):
                line, col = _line_col(template, pos)
            else:
                line = col = None
            item = {
                "variable": name,
                "code": code,
                "severity": severity,
                "context": context,
                "message": message,
                "pos": pos if isinstance(pos, int) else None,
                "line": line,
                "col": col,
                "count": 0,
                "first": occ,
                "occurrences": [],
            }
            agg[key] = item
        item["count"] += 1
        if len(item["occurrences"]) < _OCCURRENCE_LIMIT:
            item["occurrences"].append(occ)
        flat_issues.append({
            "variable": name,
            "code": code,
            "severity": severity,
            "context": context,
            "message": message,
            "scenario_id": occ["scenario_id"],
            "scenario_name": occ["scenario_name"],
            "scenario_index": sc_index,
            "value": value,
        })

    passed = 0
    failed = 0
    for idx, sc in enumerate(scenarios):
        name = sc.get("name") or f"场景 {idx + 1}"
        sc_locale = sc.get("locale", locale)
        variables = sc.get("variables", {})
        entry: dict = {"id": sc.get("id", idx + 1), "name": name,
                       "locale": sc_locale, "ok": False, "issue_count": 0}
        if not isinstance(sc_locale, str) or not sc_locale.strip():
            entry["status"] = "failed"
            entry["error"] = "locale 必须是非空字符串"
            failed += 1
            out_scenarios.append(entry)
            continue
        if not isinstance(variables, dict):
            entry["status"] = "failed"
            entry["error"] = "variables 必须是对象"
            failed += 1
            out_scenarios.append(entry)
            continue

        entry["status"] = "pending"
        sc_errors = 0
        for c in contracts:
            vname = c["name"]
            if vname not in variables:
                if c["required"]:
                    sc_errors += 1
                    add_issue(
                        "missing", vname, sc, idx,
                        f"场景缺少必需变量 '{vname}'：该变量在模板的每条"
                        "分支路径上都会使用",
                        c["contexts"][0], None, c["first_pos"])
                else:
                    # 仅部分分支路径使用：可选，缺失时这些分支无法正确渲染
                    add_issue(
                        "missing_optional", vname, sc, idx,
                        f"场景未提供可选变量 '{vname}'：仅部分分支路径使用，"
                        "缺失时这些分支无法正确渲染",
                        c["contexts"][0], None, c["first_pos"],
                        severity="warning")
                continue
            problem = _check_value(vname, variables[vname], c)
            if problem:
                sc_errors += 1
                add_issue(problem["code"], vname, sc, idx,
                          problem["message"], problem["context"],
                          variables[vname], c["first_pos"])

        for extra in sorted(set(variables) - {c["name"] for c in contracts}):
            add_issue("unused", extra, sc, idx,
                      f"场景提供了模板未使用的变量 '{extra}'"
                      f"（值：{_show(variables[extra])}）",
                      None, variables[extra], None)

        entry["ok"] = sc_errors == 0
        entry["status"] = "passed" if sc_errors == 0 else "failed"
        entry["issue_count"] = sc_errors
        if sc_errors:
            failed += 1
        else:
            passed += 1
        out_scenarios.append(entry)

    # 把聚合问题挂到对应契约上（unused 变量没有契约）
    issues_for: dict[str, list[dict]] = {}
    for (name, _code), item in agg.items():
        issues_for.setdefault(name, []).append(item)
    for c in contracts:
        c["issues"] = sorted(issues_for.get(c["name"], []),
                             key=lambda it: it["first"]["scenario_index"])
    orphan_issues = sorted(
        (item for (name, _code), item in agg.items()
         if name not in contract_by_name),
        key=lambda it: it["variable"])

    by_code = {"missing": 0, "missing_optional": 0, "type": 0,
               "invalid_plural": 0, "unused": 0}
    for (_n, code), item in agg.items():
        by_code[code] += item["count"]

    schema = build_json_schema(contracts)
    return {
        "ok": True,
        "errors": [],
        "locale": locale,
        "contracts": contracts,
        "issues": sorted(
            agg.values(),
            key=lambda it: (
                it["pos"] is None, it["pos"] if it["pos"] is not None else 0,
                it["variable"], it["code"],
                it["first"]["scenario_index"])),
        "orphan_issues": orphan_issues,
        "flat_issues": sorted(flat_issues,
                              key=lambda it: (it["scenario_index"],
                                              it["variable"], it["code"])),
        "scenarios": out_scenarios,
        "json_schema": schema,
        "summary": {
            "total_scenarios": len(out_scenarios),
            "passed_scenarios": passed,
            "failed_scenarios": failed,
            "variables_total": len(contracts),
            "required_total": sum(1 for c in contracts if c["required"]),
            "conflicting_total": sum(1 for c in contracts if c["conflicting"]),
            "missing_count": by_code["missing"],
            "missing_optional_count": by_code["missing_optional"],
            "type_count": by_code["type"],
            "invalid_plural_count": by_code["invalid_plural"],
            "unused_count": by_code["unused"],
            "error_count": (by_code["missing"] + by_code["type"]
                            + by_code["invalid_plural"]),
            "paths_truncated": paths_truncated,
        },
    }


# ---------------------------------------------------------------------------
# JSON Schema 草案
# ---------------------------------------------------------------------------

def build_json_schema(contracts: list[dict]) -> dict:
    """根据变量契约生成 JSON Schema（draft 2020-12）草案。"""
    props: dict = {}
    required_names: list[str] = []
    for c in contracts:
        desc_parts = ["、".join(c["context_labels"])]
        desc_parts.append("必需变量" if c["required"] else "可选变量")
        if c["contexts"] == ["select"] and c["has_other"]:
            desc_parts.append("other 为兜底分支")
        for note in c["notes"]:
            desc_parts.append(note)

        schema_obj: dict = {"description": "；".join(desc_parts)}
        if c["allowed_types"]:
            if len(c["allowed_types"]) == 1:
                schema_obj["type"] = c["allowed_types"][0]
            else:
                schema_obj["type"] = list(c["allowed_types"])
        else:
            # 契约自相矛盾：无法给出类型，保留描述供人工修正
            schema_obj["x-icu-contract-conflict"] = True
        if c["selectors"] and not c["selector_conflict"]:
            schema_obj["enum"] = list(c["selectors"])
        props[c["name"]] = schema_obj
        if c["required"]:
            required_names.append(c["name"])

    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "ICU 模板变量契约（自动生成的草案）",
        "type": "object",
        "properties": props,
        "required": required_names,
        "additionalProperties": True,
    }
    return schema
