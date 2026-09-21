"""变量契约审计（contract.py 与 /api/contract-audit）的测试。"""
import pytest

from app import app
from contract import (
    audit_contract, build_contracts, structural_path_vars,
)
from icu import Parser


def parse(text):
    p = Parser(text)
    return p.parse()


def contracts(text):
    c, _trunc = build_contracts(parse(text), text)
    return {x["name"]: x for x in c}


# ---------------- 契约推导 ----------------

def test_simple_placeholder_allows_scalar_types():
    c = contracts("Hello {name}")["name"]
    assert c["contexts"] == ["simple"]
    assert c["allowed_types"] == ["string", "number", "boolean"]
    assert c["required"] is True


def test_number_and_plural_require_number():
    cs = contracts("{n, number} {m, plural, one{#} other{#s}} "
                   "{p, selectordinal, one{#st} other{#th}}")
    assert cs["n"]["allowed_types"] == ["number"]
    assert cs["m"]["allowed_types"] == ["number"]
    assert cs["p"]["allowed_types"] == ["number"]


def test_select_requires_string_and_collects_selectors():
    c = contracts("{g, select, male{He} female{She} other{They}}")["g"]
    assert c["allowed_types"] == ["string"]
    assert c["selectors"] == ["male", "female", "other"]
    assert c["has_other"] is True


def test_variable_only_in_branch_is_optional():
    # name 只在 select 的 male 分支中使用 → 非必需
    text = "{g, select, male{Mr {name}} other{Someone}}"
    cs = contracts(text)
    assert cs["g"]["required"] is True
    assert cs["name"]["required"] is False


def test_plural_branch_local_var_is_optional():
    # reason 只在 one 分支出现 → 非必需；count 在每条路径上 → 必需
    text = "{count, plural, one{# ({reason})} other{#}}"
    cs = contracts(text)
    assert cs["count"]["required"] is True
    assert cs["reason"]["required"] is False


def test_sibling_after_branch_counts_into_every_path():
    # 分支之后的同级变量应计入每条路径 → 必需
    text = "{g, select, male{H} other{T}} {suffix}"
    assert contracts(text)["suffix"]["required"] is True


def test_conflicting_usage_simple_and_plural():
    # 同一变量既作简单占位（允许标量）又作 plural（仅数字）→ 交集为 number
    c = contracts("{x} {x, plural, one{#} other{#s}}")["x"]
    assert c["allowed_types"] == ["number"]
    assert c["conflicting"] is False


def test_conflicting_usage_select_and_plural():
    # select 要求 string、plural 要求 number → 无兼容类型
    c = contracts("{x, select, a{A} other{O}} {x, plural, one{#} other{#s}}")["x"]
    assert c["allowed_types"] == []
    assert c["conflicting"] is True
    assert any("自相矛盾" in n for n in c["notes"])


def test_two_selects_intersect_selectors():
    text = ("{x, select, a{A} b{B} other{O}} "
            "{x, select, b{B2} c{C} other{O2}}")
    c = contracts(text)["x"]
    # 公共选择器为 b 与 other；a、c 不共现
    assert c["selectors"] == ["b", "other"]
    assert c["selector_conflict"] is False


def test_two_selects_with_disjoint_named_selectors_keep_other():
    text = ("{x, select, a{A} b{B} other{O}} "
            "{x, select, c{C} d{D} other{_}}")
    c = contracts(text)["x"]
    # 具名选择器无公共项，但两侧都有 other 兜底
    assert c["selectors"] == ["other"]


def test_two_selects_truly_disjoint_conflict():
    from icu import Select, Branch
    # 解析器强制 other 分支，这里直接构造两个无公共选择器的 Select AST
    src = "{x, select, a{} b{}} {x, select, c{} d{}}"
    s1 = Select("x", [Branch("a", [], 11), Branch("b", [], 14)], 0, "n1", 18)
    s2 = Select("x", [Branch("c", [], 30), Branch("d", [], 33)], 19, "n2", 37)
    from contract import build_contracts as _bc
    c = _bc([s1, s2], src)[0][0]
    assert c["selectors"] == []
    assert c["selector_conflict"] is True


def test_first_occurrence_line_col():
    text = "line1\n{count, plural, one{#} other{#s}}"
    c = contracts(text)["count"]
    assert c["line"] == 2
    assert c["col"] == 1


def test_structural_paths_locale_independent():
    # ru 有 one/few/many/other：结构路径不依赖 locale 可达性
    text = "{n, plural, one{a} few{b} many{c} other{d}}"
    path_sets, trunc = structural_path_vars(parse(text))
    assert trunc is False
    assert len(path_sets) == 4
    assert all(s == {"n"} for s in path_sets)


# ---------------- 场景审计 ----------------

TPL = ("{g, select, male{He} female{She} other{They}} "
       "{n, plural, =0{none} one{#} other{#s}} "
       "{p, selectordinal, one{#st} two{#nd} few{#rd} other{#th}} "
       "{name}")


def test_clean_scenarios_pass():
    r = audit_contract(TPL, [
        {"name": "s1", "locale": "en",
         "variables": {"g": "male", "n": 1, "p": 21, "name": "A"}},
        {"name": "s2", "locale": "en",
         "variables": {"g": "x", "n": 0, "p": 2, "name": "B"}},
    ])
    assert r["summary"]["failed_scenarios"] == 0
    assert r["summary"]["passed_scenarios"] == 2
    assert r["summary"]["error_count"] == 0


def test_missing_required_variable():
    r = audit_contract(TPL, [
        {"name": "缺 name", "variables": {"g": "male", "n": 1, "p": 1}},
    ])
    issues = [i for i in r["issues"] if i["variable"] == "name"]
    assert len(issues) == 1
    assert issues[0]["code"] == "missing"
    assert issues[0]["severity"] == "error"
    assert issues[0]["count"] == 1
    # 首次出现位置指向模板中 name 的位置
    assert issues[0]["pos"] == TPL.index("{name}")


def test_type_conflict_string_for_plural():
    r = audit_contract(TPL, [
        {"name": "坏", "variables": {"g": "male", "n": "many", "p": 1,
                                     "name": "A"}},
    ])
    issue = next(i for i in r["issues"] if i["variable"] == "n")
    assert issue["code"] == "type"
    assert "需要数字" in issue["message"]


def test_type_conflict_number_for_select():
    r = audit_contract(TPL, [
        {"name": "坏", "variables": {"g": 7, "n": 1, "p": 1, "name": "A"}},
    ])
    issue = next(i for i in r["issues"] if i["variable"] == "g")
    assert issue["code"] == "type"
    assert "需要字符串" in issue["message"]


def test_boolean_rejected_for_number_contexts():
    r = audit_contract(TPL, [
        {"name": "坏", "variables": {"g": "male", "n": True, "p": 1,
                                     "name": "A"}},
    ])
    issue = next(i for i in r["issues"] if i["variable"] == "n")
    assert issue["code"] == "type"


def test_selectordinal_fraction_is_invalid_plural():
    r = audit_contract(TPL, [
        {"name": "小数序数", "variables": {"g": "male", "n": 1, "p": 2.5,
                                           "name": "A"}},
    ])
    issue = next(i for i in r["issues"] if i["variable"] == "p")
    assert issue["code"] == "invalid_plural"
    assert "整数" in issue["message"]


def test_plural_fraction_is_fine():
    # plural（cardinal）允许小数；只有 selectordinal 要求整数
    r = audit_contract("{n, plural, one{#} other{#s}}",
                       [{"name": "小数复数", "variables": {"n": 1.5}}])
    assert r["summary"]["error_count"] == 0


def test_inf_nan_for_plural_are_invalid():
    r = audit_contract("{n, plural, one{#} other{#s}}",
                       [{"name": "inf", "variables": {"n": float("inf")}}])
    issue = r["issues"][0]
    assert issue["code"] == "invalid_plural"


def test_issues_aggregate_by_variable_with_first_occurrence():
    r = audit_contract("{n, plural, one{#} other{#s}}", [
        {"name": "s1", "variables": {"n": "x"}},
        {"name": "s2", "variables": {"n": "y"}},
        {"name": "s3", "variables": {"n": "z"}},
    ])
    issue = next(i for i in r["issues"] if i["variable"] == "n")
    assert issue["code"] == "type"
    assert issue["count"] == 3
    assert issue["first"]["scenario_name"] == "s1"
    assert [o["scenario_name"] for o in issue["occurrences"]] == ["s1", "s2", "s3"]
    # flat_issues 保留逐场景明细
    assert len(r["flat_issues"]) == 3


def test_unused_variable_is_warning():
    r = audit_contract("{n, plural, one{#} other{#s}}",
                       [{"name": "s1", "variables": {"n": 1, "extra": 9}}])
    issue = next(i for i in r["issues"] if i["variable"] == "extra")
    assert issue["code"] == "unused"
    assert issue["severity"] == "warning"
    assert issue["pos"] is None
    # 警告不影响场景通过
    assert r["scenarios"][0]["status"] == "passed"


def test_missing_optional_is_warning():
    text = "{g, select, male{Mr {name}} other{X}}"
    r = audit_contract(text, [{"name": "s1", "variables": {"g": "male"}}])
    issue = next(i for i in r["issues"] if i["variable"] == "name")
    assert issue["code"] == "missing_optional"
    assert issue["severity"] == "warning"
    assert r["scenarios"][0]["status"] == "passed"
    assert r["summary"]["missing_count"] == 0
    assert r["summary"]["missing_optional_count"] == 1


def test_object_and_array_values_rejected_in_simple():
    text = "{a} {b}"
    r = audit_contract(text, [
        {"name": "对象/数组", "variables": {"a": {"x": 1}, "b": [1, 2]}},
    ])
    codes = {i["variable"]: i["code"] for i in r["issues"]}
    assert codes == {"a": "type", "b": "type"}


def test_request_level_scenario_errors_do_not_abort_batch():
    r = audit_contract("{n, plural, one{#} other{#s}}", [
        {"name": "好", "locale": "en", "variables": {"n": 1}},
        {"name": "坏locale", "locale": 9, "variables": {}},
        {"name": "坏变量", "locale": "en", "variables": []},
    ])
    assert [s["status"] for s in r["scenarios"]] == ["passed", "failed", "failed"]
    assert r["summary"]["failed_scenarios"] == 2


def test_audit_without_scenarios_still_derives_contract():
    r = audit_contract(TPL, [])
    assert r["ok"] is True
    assert r["summary"]["variables_total"] == 4
    assert r["summary"]["required_total"] == 4
    assert r["scenarios"] == []


def test_template_syntax_error_returns_errors():
    r = audit_contract("{n, plural, one{a}}", [])
    assert r["ok"] is False
    assert r["errors"]


# ---------------- JSON Schema ----------------

def test_json_schema_required_and_types():
    r = audit_contract(
        "{g, select, male{He} other{They}} {n, number} {name}",
        [{"name": "s1", "variables": {"g": "male", "n": 1, "name": "A"}}])
    schema = r["json_schema"]
    assert schema["type"] == "object"
    assert set(schema["required"]) == {"g", "n", "name"}
    assert schema["properties"]["g"]["type"] == "string"
    assert schema["properties"]["g"]["enum"] == ["male", "other"]
    assert schema["properties"]["n"]["type"] == "number"
    assert schema["properties"]["name"]["type"] == ["string", "number", "boolean"]


def test_json_schema_optional_not_in_required():
    r = audit_contract("{g, select, male{{x}} other{O}}",
                       [{"name": "s1", "variables": {"g": "male", "x": 1}}])
    schema = r["json_schema"]
    assert "g" in schema["required"]
    assert "x" not in schema["required"]


def test_json_schema_selector_conflict_has_no_enum():
    from icu import Select, Branch
    from contract import audit_contract
    src = "{x, select, a{} b{}} {x, select, c{} d{}}"
    # 绕过解析器的 other 校验，直接注入 AST 审计
    s1 = Select("x", [Branch("a", [], 11), Branch("b", [], 14)], 0, "n1", 18)
    s2 = Select("x", [Branch("c", [], 30), Branch("d", [], 33)], 19, "n2", 37)
    import contract as cm
    orig = cm.Parser
    class FakeParser:
        def __init__(self, text):
            self.errors = []
        def parse(self):
            return [s1, s2]
    cm.Parser = FakeParser
    try:
        r = audit_contract(src, [])
    finally:
        cm.Parser = orig
    prop = r["json_schema"]["properties"]["x"]
    assert "enum" not in prop
    assert any("没有公共项" in n for n in r["contracts"][0]["notes"])


# ---------------- HTTP 接口 ----------------

@pytest.fixture()
def client():
    app.testing = True
    return app.test_client()


def test_endpoint_happy_path(client):
    resp = client.post("/api/contract-audit", json={
        "template": "{n, plural, one{#} other{#s}}",
        "scenarios": [
            {"name": "好", "locale": "en", "variables": {"n": 1}},
            {"name": "坏", "locale": "en", "variables": {"n": "x"}},
        ],
    })
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["summary"]["passed_scenarios"] == 1
    assert data["summary"]["failed_scenarios"] == 1
    assert "json_schema" in data
    assert data["contracts"][0]["name"] == "n"


def test_endpoint_rejects_non_dict_body(client):
    resp = client.post("/api/contract-audit",
                       data="[]", content_type="application/json")
    assert resp.status_code == 400
    assert resp.get_json()["ok"] is False


def test_endpoint_rejects_non_string_template(client):
    resp = client.post("/api/contract-audit", json={"template": 1})
    assert resp.status_code == 400


def test_endpoint_rejects_non_list_scenarios(client):
    resp = client.post("/api/contract-audit",
                       json={"template": "x", "scenarios": {}})
    assert resp.status_code == 400


def test_endpoint_too_many_scenarios(client, monkeypatch):
    import app as app_module
    monkeypatch.setattr(app_module, "MAX_SCENARIOS", 2)
    resp = client.post("/api/contract-audit", json={
        "template": "x",
        "scenarios": [{"name": str(i), "variables": {}} for i in range(3)],
    })
    assert resp.status_code == 400
    assert "最多" in resp.get_json()["error"]


def test_endpoint_default_locale(client):
    resp = client.post("/api/contract-audit", json={
        "template": "{n, plural, one{#} other{#s}}",
        "scenarios": [],
    })
    assert resp.status_code == 200
    assert resp.get_json()["locale"] == "en"
