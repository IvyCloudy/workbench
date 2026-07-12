#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ============================================================================
#  Copyright (c) 2026 yyy / cc. All rights reserved.
#  yaml-format-fix skill — Proprietary Internal-Use License (see ./LICENSE or ../LICENSE).
#  Unauthorized copy / modification / redistribution is strictly prohibited.
#  Integrity is verified at runtime against manifest.json.
# ============================================================================
"""
 scripts/fix_yaml.py  (Python edition)
 YAML 格式修复 CLI —— 与 VS Code 扩展 (utils/yamlRules.ts + yamlValidator.ts)
 行为完全一致的独立命令行版本

 设计原则：
   ①【纯确定性】不依赖 LLM 推理；所有规则/修复算法 1:1 移植自插件源码
   ②【日志完整】--verbose 打印每条规则命中详情、apply 前后行文本、跳过原因
   ③【零外部依赖 · 可选优化】默认仅需 Python 3.8+ 标准库；若已安装
      PyYAML (`pip install pyyaml`)，则启用 P1~P4 parser 级兜底修复

 规则覆盖（12 条，与插件完全对齐）：
   - 逐行规则 -
     R1  Tab 缩进           → 每个 \\t → 2 空格 (stopOnHit)
     R2  行内 Tab           → 未在引号内 & 非行末的 \\t → 单空格
     R3  行末空格            → rstrip
     R4  冒号后缺空格        → 插入单空格 (让位 R5/R7 时不产 fix)
     R5  歧义值(布尔/null)   → 加引号
     R6  值中 # 号           → 整个值加引号 (含注释文本)
     R7  YAML 保留字符       → 加引号
     R8  '-' 后缺空格        → 插入单空格
   - 文件级规则 -
     F1  重复 key            → 后续同名行改成 `# [duplicate key removed] ...`
   - Parser 兜底 -
     P1  嵌套 map 报错       → 序列/键值对整个值加引号
     P2  缺闭合引号           → 补上对应引号
     P3  same column         → 注释化该行
     P4  duplicate key       → 注释化该行

 用法：
   python3 scripts/fix_yaml.py <file>              修复并写回
   python3 scripts/fix_yaml.py <file> --dry-run    仅预览
   python3 scripts/fix_yaml.py <file> --json       机器可读输出
   python3 scripts/fix_yaml.py <file> --verbose    打印详细日志
============================================================================
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Callable, Dict, List, Optional, Tuple

# --- PyYAML 可选依赖（用于 P1~P4 parser 级错误捕获）---------------------------
try:
    import yaml as _yaml  # type: ignore
    _YAML_AVAILABLE = True
except Exception:  # noqa: BLE001
    _yaml = None  # type: ignore
    _YAML_AVAILABLE = False


# ═══════════════════════════════════════════════════════════════════════════
# 常量表（1:1 复刻 utils/yamlConstants.ts）
# ═══════════════════════════════════════════════════════════════════════════
RESERVED_CHARS_PATTERN = re.compile(r"[\[\]{},&*!>|]")

# R7 豁免正则：值起始位置是合法 YAML 指示符时，不应加引号。
#   - BLOCK_SCALAR: 块标量头 `|` / `>` / `|-` / `|+` / `>+` / `>-` / `|2` 等，后可跟注释
#   - ALIAS:        别名 `*name`，后可跟注释（不允许内联值）
#   - ANCHOR:       锚点 `&name`，后可跟空白+内联值（合法 YAML）
#   - TAG:          标签 `!name` / `!!type` / `!<uri>`，后可跟空白+内联值
#   - FLOW_SEQ:     内联序列 `[...]`（必须闭合），后可跟注释
#   - FLOW_MAP:     内联映射 `{...}`（必须闭合），后可跟注释
YAML_INDICATOR_PATTERNS = [
    re.compile(r"^[|>][+-]?\d*[+-]?\s*(?:#.*)?$"),
    re.compile(r"^\*[A-Za-z_][A-Za-z0-9_\-]*\s*(?:#.*)?$"),
    re.compile(r"^&[A-Za-z_][A-Za-z0-9_\-]*(?:\s+[^!&*|>].*)?$"),      # anchor + inline 值（非指示符起始）
    re.compile(r"^!<[^>]+>(?:\s+[^!&*|>].*)?$"),                       # verbatim tag + inline
    re.compile(r"^!!?[A-Za-z_][A-Za-z0-9_\-]*(?:\s+[^!&*|>].*)?$"),    # tag + inline
    re.compile(r"^\[.*\]\s*(?:#.*)?$"),
    re.compile(r"^\{.*\}\s*(?:#.*)?$"),
]


def is_yaml_indicator_value(raw_value: str) -> bool:
    """判定 trim 后的值是否是纯 YAML 指示符（应豁免 R7 保留字符检查）。"""
    for pat in YAML_INDICATOR_PATTERNS:
        if pat.match(raw_value):
            return True
    return False
RESERVED_CHAR_DESCRIPTIONS: Dict[str, str] = {
    "{": "开花括号通常用于内联映射 (flow mapping)",
    "}": "闭花括号通常用于内联映射结束",
    "[": "开方括号通常用于内联序列 (flow sequence)",
    "]": "闭方括号通常用于内联序列结束",
    ",": "逗号通常用于分隔内联集合项",
    "&": "& 符号用于定义 YAML 锚点 (anchor)",
    "*": "* 符号用于引用 YAML 别名 (alias)",
    "!": "! 符号用于声明 YAML 标签 (tag)",
    ">": "> 符号用于折叠块标量 (block scalar)",
    "|": "| 符号用于保留换行的块标量 (literal block scalar)",
}

BOOLEAN_KEYWORDS = {
    "true", "false", "TRUE", "FALSE", "True", "False",
    "yes", "no", "YES", "NO", "Yes", "No",
    "on", "off", "ON", "OFF", "On", "Off",
}
NULL_KEYWORDS = {"null", "NULL", "Null", "~"}
NUMERIC_SPECIAL_KEYWORDS = {".inf", ".nan", ".INF", ".NAN", "Infinity", "-Infinity"}
AMBIGUOUS_TYPE_LABEL = {"boolean": "布尔值", "null": "空值 null", "numeric": "特殊数值"}

# 支持中/日文引号
_QUOTE_CHARS = "'\"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02"
QUOTE_STRIP_LEADING = re.compile(rf"^[{re.escape(_QUOTE_CHARS)}]\s*")
QUOTE_STRIP_TRAILING = re.compile(rf"\s*[{re.escape(_QUOTE_CHARS)}]$")


def get_ambiguous_type(value: str) -> Optional[str]:
    if value in BOOLEAN_KEYWORDS:
        return "boolean"
    if value in NULL_KEYWORDS:
        return "null"
    if value in NUMERIC_SPECIAL_KEYWORDS:
        return "numeric"
    return None


# ═══════════════════════════════════════════════════════════════════════════
# Issue 数据类
# ═══════════════════════════════════════════════════════════════════════════
@dataclass
class Issue:
    id: str
    line: int
    column: int
    length: int
    title: str
    message: str
    severity: str  # 'error' | 'warning'
    fix: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════════════
# 日志器
# ═══════════════════════════════════════════════════════════════════════════
class Logger:
    def __init__(self, verbose: bool):
        self.verbose = verbose

    @staticmethod
    def _stamp() -> str:
        return datetime.now().strftime("%H:%M:%S.") + f"{datetime.now().microsecond // 1000:03d}"

    def info(self, *args):
        print(f"[{self._stamp()}] [INFO ]", *args)

    def warn(self, *args):
        print(f"[{self._stamp()}] [WARN ]", *args, file=sys.stderr)

    def error(self, *args):
        print(f"[{self._stamp()}] [ERROR]", *args, file=sys.stderr)

    def debug(self, *args):
        if self.verbose:
            print(f"[{self._stamp()}] [DEBUG]", *args)

    def rule(self, rule_id: str, line_num: int, line: str, msg: str):
        if not self.verbose:
            return
        print(f"[{self._stamp()}] [RULE ] {rule_id} L{line_num} {msg}")
        print(f"[{self._stamp()}] [RULE ]         BEFORE: {json.dumps(line, ensure_ascii=False)}")

    def rule_after(self, rule_id: str, line_num: int, fixed: Optional[str]):
        if not self.verbose:
            return
        text = "AFTER : " + json.dumps(fixed, ensure_ascii=False) if fixed is not None else "(no auto-fix)"
        print(f"[{self._stamp()}] [RULE ] {rule_id} L{line_num} {text}")


# ═══════════════════════════════════════════════════════════════════════════
# 引号/冒号定位辅助（1:1 复刻）
# ═══════════════════════════════════════════════════════════════════════════
def find_yaml_char(line: str, chars: str) -> int:
    in_single = in_double = False
    for i, c in enumerate(line):
        if not in_double and c == "'":
            in_single = not in_single
            continue
        if not in_single and c == '"':
            in_double = not in_double
            continue
        if not in_single and not in_double and c in chars:
            return i
    return -1


def find_yaml_colon(line: str) -> int:
    in_single = in_double = False
    for i, c in enumerate(line):
        if not in_double and c == "'":
            in_single = not in_single
            continue
        if not in_single and c == '"':
            in_double = not in_double
            continue
        if in_single or in_double:
            continue
        if c != ":":
            continue
        nxt = line[i + 1] if i + 1 < len(line) else ""
        nxt2 = line[i + 2] if i + 2 < len(line) else ""
        prv = line[i - 1] if i > 0 else ""
        if nxt == "/" and nxt2 == "/":
            continue  # :// URL
        if nxt == ":" or prv == ":":
            continue  # ::
        return i
    return -1


def strip_quotes(value: str) -> str:
    left = QUOTE_STRIP_LEADING.sub("", value, count=1)
    if len(left) == len(value):
        return value
    right = QUOTE_STRIP_TRAILING.sub("", left, count=1)
    if len(right) == len(left):
        return value
    return right


def wrap_value_with_quote(value: str) -> str:
    has_double = '"' in value
    has_single = "'" in value
    if has_double and has_single:
        return '"' + value.replace('"', '\\"') + '"'
    if has_double:
        return "'" + value + "'"
    return '"' + value + '"'


def replace_value_by_colon(line: str, colon_idx: int, wrapped: str) -> str:
    val_start = colon_idx + 1
    need_space = val_start < len(line) and line[val_start] != " "
    while val_start < len(line) and line[val_start] == " ":
        val_start += 1
    val_end = len(line)
    while val_end > val_start and re.match(r"[\s\u00A0\r]", line[val_end - 1]):
        val_end -= 1
    tail = line[val_end:]
    prefix = line[:val_start] + (" " if need_space else "")
    return prefix + wrapped + tail


@dataclass
class LineCtx:
    colon_idx: int
    hash_idx: int
    key_text: Optional[str] = None
    value_text: Optional[str] = None


def build_line_ctx(line: str) -> LineCtx:
    c_idx = find_yaml_colon(line)
    h_idx = find_yaml_char(line, "#")
    ctx = LineCtx(colon_idx=c_idx, hash_idx=h_idx)
    if c_idx > 0:
        ctx.key_text = line[:c_idx]
        ctx.value_text = line[c_idx + 1 :]
    return ctx


# ═══════════════════════════════════════════════════════════════════════════
# 逐行规则（R1~R8）
# ═══════════════════════════════════════════════════════════════════════════
_TAB_INDENT_RE = re.compile(r"^(\t+)")
_DASH_SPACE_RE = re.compile(r"^(\s*)-([^\s-])")


def rule_tab_indent(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    m = _TAB_INDENT_RE.match(line)
    if not m:
        return None
    tabs = m.group(1)
    fixed = re.sub(r"^\t+", lambda mm: "  " * len(mm.group(0)), line)
    return Issue(
        id="R1", line=line_num, column=1, length=len(tabs),
        title="Tab 缩进",
        message=f"第 {line_num} 行：使用了 Tab 缩进，YAML 规范不允许用 Tab 进行缩进，请改用空格",
        severity="error", fix=fixed,
    )


def rule_inline_tab(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    idx = line.find("\t")
    if idx <= 0:
        return None
    trimmed = line.rstrip()
    trailing_start = len(trimmed)
    in_single = in_double = False
    has_replaceable = False
    first_report_idx = -1
    out_chars = []
    for i, c in enumerate(line):
        if not in_double and c == "'":
            in_single = not in_single
            out_chars.append(c); continue
        if not in_single and c == '"':
            in_double = not in_double
            out_chars.append(c); continue
        if c == "\t" and not in_single and not in_double and i > 0 and i < trailing_start:
            has_replaceable = True
            if first_report_idx < 0:
                first_report_idx = i
            out_chars.append(" "); continue
        out_chars.append(c)
    if first_report_idx < 0:
        return None
    fixed = "".join(out_chars) if has_replaceable else None
    return Issue(
        id="R2", line=line_num, column=first_report_idx + 1, length=1,
        title="含 Tab 字符",
        message=f"第 {line_num} 行：字符串内容中包含 Tab 字符，可能被解析为缩进导致格式错误",
        severity="warning", fix=fixed,
    )


def rule_trailing_space(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    if not line:
        return None
    trimmed = line.rstrip()
    if trimmed == line:
        return None
    return Issue(
        id="R3", line=line_num, column=len(trimmed) + 1, length=len(line) - len(trimmed),
        title="行末多余空格",
        message=f"第 {line_num} 行：末尾有多余空格，可能导致缩进层级判断错误",
        severity="warning", fix=trimmed,
    )


def rule_colon_space(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    if ctx.colon_idx <= 0:
        return None
    colon_idx = ctx.colon_idx
    after = line[colon_idx + 1] if colon_idx + 1 < len(line) else ""
    if after in ("", " ", "\r"):
        return None
    if after == "\t":
        return None
    value_part = line[colon_idx + 1 :].strip()
    if not value_part:
        return None
    if value_part[0] in ("\"", "'") or value_part[0].isdigit():
        return None
    if get_ambiguous_type(value_part):
        return None
    if RESERVED_CHARS_PATTERN.search(value_part):
        return None
    fixed = line[: colon_idx + 1] + " " + line[colon_idx + 1 :]
    key_display = (ctx.key_text or "").strip()
    return Issue(
        id="R4", line=line_num, column=colon_idx + 1, length=1,
        title="缺少空格",
        message=f'第 {line_num} 行：冒号后缺少空格，字段 "{key_display}" 的值未被正确识别',
        severity="warning", fix=fixed,
    )


def rule_ambiguous_value(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    if ctx.colon_idx <= 0 or ctx.value_text is None:
        return None
    hash_raw = find_yaml_char(ctx.value_text, "#")
    if hash_raw > 0 and ctx.value_text[hash_raw - 1] == " " and ctx.value_text[hash_raw + 1 :].strip():
        return None
    raw_value_raw = ctx.value_text
    hash_in_val = find_yaml_char(raw_value_raw, "#")
    if hash_in_val > 0 and raw_value_raw[hash_in_val - 1] == " ":
        raw_value_raw = raw_value_raw[:hash_in_val]
    raw_value = raw_value_raw.strip()
    if not raw_value:
        return None
    if strip_quotes(raw_value) != raw_value:
        return None
    t = get_ambiguous_type(raw_value)
    if not t:
        return None
    return Issue(
        id="R5", line=line_num, column=ctx.colon_idx + 2, length=len(raw_value),
        title=f"{AMBIGUOUS_TYPE_LABEL[t]} 需引号",
        message=f'第 {line_num} 行：值 "{raw_value}" 会被 YAML 解析为{AMBIGUOUS_TYPE_LABEL[t]}，如需字符串请加引号',
        severity="warning",
        fix=replace_value_by_colon(line, ctx.colon_idx, wrap_value_with_quote(raw_value)),
    )


def rule_hash_in_value(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    if ctx.colon_idx <= 0 or ctx.hash_idx <= ctx.colon_idx:
        return None
    hash_idx = ctx.hash_idx
    value_section = line[ctx.colon_idx + 1 : hash_idx]
    if not value_section.strip():
        return None
    if line[hash_idx - 1] != " ":
        return None
    after_hash = line[hash_idx + 1 :].strip()
    if not after_hash:
        return None
    # 豁免：# 前的值段本身是合法 YAML 指示符（flow 集合 / block scalar / anchor / alias / tag），
    #   此时 `#note` 就是合法的行内注释，包引号反而破坏语义。
    if is_yaml_indicator_value(value_section.strip()):
        return None
    raw_value = line[ctx.colon_idx + 1 :].strip()
    fixed = line[: ctx.colon_idx + 1] + " " + wrap_value_with_quote(raw_value)
    return Issue(
        id="R6", line=line_num, column=hash_idx + 1, length=len(line) - hash_idx,
        title="值中 # 会被丢弃",
        message=f'第 {line_num} 行：值中包含 "#"，"{after_hash}" 会被 YAML 当作注释丢弃，如需保留请用引号包裹整个值',
        severity="warning", fix=fixed,
    )


def rule_reserved_char(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    if ctx.colon_idx <= 0 or ctx.value_text is None:
        return None
    hash_raw = find_yaml_char(ctx.value_text, "#")
    if hash_raw > 0 and ctx.value_text[hash_raw - 1] == " " and ctx.value_text[hash_raw + 1 :].strip():
        return None
    raw_value_raw = ctx.value_text
    hash_in_val = find_yaml_char(raw_value_raw, "#")
    if hash_in_val > 0 and raw_value_raw[hash_in_val - 1] == " ":
        raw_value_raw = raw_value_raw[:hash_in_val]
    raw_value = raw_value_raw.strip()
    if not raw_value:
        return None
    if strip_quotes(raw_value) != raw_value:
        return None
    # R7 豁免：值起始位置是合法 YAML 指示符（块标量 / 锚点 / 别名 / 标签）
    if is_yaml_indicator_value(raw_value):
        return None
    m = RESERVED_CHARS_PATTERN.search(raw_value)
    if not m:
        return None
    reserved_char = m.group(0)
    desc = RESERVED_CHAR_DESCRIPTIONS.get(reserved_char, "")
    char_pos = line.find(reserved_char, ctx.colon_idx + 1)
    return Issue(
        id="R7", line=line_num, column=(ctx.colon_idx + 2 if char_pos < 0 else char_pos + 1), length=1,
        title=f'保留字符 "{reserved_char}"',
        message=f'第 {line_num} 行：值中包含 YAML 保留字符 "{reserved_char}"'
                + (f"（{desc}）" if desc else "") + "，如需字符串请用引号包裹",
        severity="warning",
        fix=replace_value_by_colon(line, ctx.colon_idx, wrap_value_with_quote(raw_value)),
    )


def rule_dash_space(line: str, line_num: int, ctx: LineCtx) -> Optional[Issue]:
    m = _DASH_SPACE_RE.match(line)
    if not m:
        return None
    dash_col = len(m.group(1))
    fixed = line[: dash_col + 1] + " " + line[dash_col + 1 :]
    return Issue(
        id="R8", line=line_num, column=dash_col + 2, length=1,
        title="缺少空格",
        message=f'第 {line_num} 行：序列符号 "-" 后缺少空格，YAML 无法识别为列表项',
        severity="warning", fix=fixed,
    )


RuleFn = Callable[[str, int, LineCtx], Optional[Issue]]
RULES: List[Tuple[RuleFn, bool]] = [
    (rule_tab_indent, True),   # stopOnHit
    (rule_inline_tab, False),
    (rule_trailing_space, False),
    (rule_colon_space, False),
    (rule_dash_space, False),
    (rule_ambiguous_value, False),
    (rule_hash_in_value, False),
    (rule_reserved_char, False),
]


# ═══════════════════════════════════════════════════════════════════════════
# 文件级规则 F1：重复 key（跨行状态机；1:1 复刻）
# ═══════════════════════════════════════════════════════════════════════════
def rule_duplicate_key(lines: List[str]) -> List[Issue]:
    issues: List[Issue] = []
    # 栈元素：{'indent': int, 'keys': dict[key -> lineNum], 'is_seq_item': bool}
    stack: List[dict] = [{"indent": -1, "keys": {}, "is_seq_item": False}]

    def pop_deeper_than(t: int):
        while len(stack) > 1 and stack[-1]["indent"] > t:
            stack.pop()

    def pop_for_new_dash(dash_col: int):
        pop_deeper_than(dash_col)
        while len(stack) > 1:
            top = stack[-1]
            if top["is_seq_item"] and top["indent"] > dash_col:
                stack.pop(); continue
            break

    for i, line in enumerate(lines):
        line_num = i + 1
        trimmed = line.strip()
        if trimmed == "" or trimmed.startswith("#") or trimmed.startswith("---") or trimmed.startswith("..."):
            continue
        if line.startswith("\t"):
            continue
        indent = len(line) - len(line.lstrip())

        if trimmed == "-" or trimmed.startswith("- "):
            dash_col = indent
            pop_for_new_dash(dash_col)
            after_dash_start = dash_col + 2
            if after_dash_start > len(line):
                continue
            after_dash_text = line[after_dash_start:]
            colon_in_rest = find_yaml_colon(after_dash_text)
            if trimmed == "-":
                continue
            if colon_in_rest > 0:
                item_indent = after_dash_start
                key = after_dash_text[:colon_in_rest].strip()
                item_scope = {"indent": item_indent, "keys": {}, "is_seq_item": True}
                stack.append(item_scope)
                if key and not key.startswith("- "):
                    item_scope["keys"][key] = line_num
                after_colon_abs = after_dash_start + colon_in_rest + 1
                after_colon_text = line[after_colon_abs:].strip()
                if after_colon_text == "" or after_colon_text.startswith("#"):
                    stack.append({"indent": item_indent, "keys": {}, "is_seq_item": False})
            continue

        colon_idx = find_yaml_colon(line)
        if colon_idx <= 0:
            continue
        key = line[indent:colon_idx].strip()
        if not key:
            continue
        pop_deeper_than(indent)
        scope = stack[-1]
        if scope["indent"] != indent:
            new_scope = {"indent": indent, "keys": {}, "is_seq_item": False}
            stack.append(new_scope)
            scope = new_scope
        if key in scope["keys"]:
            first_line = scope["keys"][key]
            indent_str = line[:indent]
            rest = line[indent:]
            issues.append(Issue(
                id="F1", line=line_num, column=indent + 1, length=len(key),
                title="重复的 key",
                message=f'第 {line_num} 行：key "{key}" 与第 {first_line} 行重复，后者会覆盖前者',
                severity="warning",
                fix=f"{indent_str}# [duplicate key removed] {rest}",
            ))
        else:
            scope["keys"][key] = line_num
        after_colon = line[colon_idx + 1 :].strip()
        if after_colon == "" or after_colon.startswith("#"):
            stack.append({"indent": indent, "keys": {}, "is_seq_item": False})
    return issues


# ═══════════════════════════════════════════════════════════════════════════
# Parser 兜底修复（P1~P4；仅在 PyYAML 可用时启用）
# ═══════════════════════════════════════════════════════════════════════════
def generate_fix_for_parse_error(line_text: str, _col: int, err_msg: str) -> Optional[str]:
    if not line_text:
        return None
    lower = (err_msg or "").lower()
    # ─── P1: nested/compact map ─── 覆盖 js-yaml 与 PyYAML 两套描述
    #   js-yaml : "Nested mappings are not allowed in compact mappings"
    #   PyYAML  : "mapping values are not allowed here" / "could not find expected ':'"
    is_nested_map = (
        "nested map" in lower
        or "compact map" in lower
        or "nested mappings are not allowed" in lower
        or "mapping values are not allowed here" in lower
        or "could not find expected ':'" in lower
    )
    # ─── P2: missing closing quote ───
    is_missing_quote = ("missing closing" in lower and "quote" in lower) \
        or ("while scanning a quoted scalar" in lower and "found unexpected end" in lower)
    # ─── P4: duplicate key ───
    is_duplicate_key = ("map keys must be unique" in lower) or ("duplicate" in lower and "key" in lower) \
        or ("found duplicate key" in lower)
    # ─── P3: same-column / indent mismatch ───（收窄：不再把 mapping-values 归入此项）
    is_same_column = ("same column" in lower) or ("must start at" in lower)

    if is_duplicate_key:
        indent = len(line_text) - len(line_text.lstrip())
        if line_text.lstrip().startswith("#"):
            return None
        return f"{line_text[:indent]}# [duplicate key removed] {line_text[indent:]}"

    if is_same_column:
        indent = len(line_text) - len(line_text.lstrip())
        if line_text.lstrip().startswith("#"):
            return None
        return f"{line_text[:indent]}# [indent mismatch] {line_text[indent:]}"

    if is_nested_map:
        m = re.match(r"^(\s*-\s+)(.+)$", line_text)
        if m:
            prefix = m.group(1)
            value = re.sub(r"[\s\u00A0]+$", "", m.group(2))
            return prefix + wrap_value_with_quote(value)
        first_colon = find_yaml_colon(line_text)
        if first_colon < 0:
            first_colon = line_text.find(":")
        if 0 < first_colon < len(line_text) - 1:
            val_start = first_colon + 1
            while val_start < len(line_text) and line_text[val_start] == " ":
                val_start += 1
            if val_start < len(line_text):
                key_part = line_text[:val_start]
                value = re.sub(r"[\s\u00A0]+$", "", line_text[val_start:])
                return key_part + wrap_value_with_quote(value)
        return None

    if is_missing_quote:
        singles = line_text.count("'")
        doubles = line_text.count('"')
        if singles % 2 != 0:
            return line_text + "'"
        if doubles % 2 != 0:
            return line_text + '"'
    return None


def truncate_yaml_message(msg: str) -> str:
    if not msg:
        return ""
    idx = msg.find("\n")
    if idx > 0:
        desc = msg[:idx].strip()
        source = msg[idx + 1 :].strip()
        return desc + (" | " + source[:80] + "…" if len(source) > 80 else " | " + source)
    return msg


def _extract_pyyaml_error_line(err) -> Tuple[int, int]:
    """从 yaml.YAMLError 提取行/列（1-based）。"""
    line, col = 1, 1
    for mark_name in ("problem_mark", "context_mark"):
        mark = getattr(err, mark_name, None)
        if mark is not None:
            line = getattr(mark, "line", 0) + 1
            col = getattr(mark, "column", 0) + 1
            if mark_name == "problem_mark":
                break
    return line, col


# ═══════════════════════════════════════════════════════════════════════════
# 主校验函数
# ═══════════════════════════════════════════════════════════════════════════
def validate(content: str, logger: Logger) -> List[Issue]:
    issues: List[Issue] = []
    lines = content.split("\n")

    # BOM
    if content and ord(content[0]) == 0xFEFF:
        first_line = lines[0] if lines else ""
        fixed = first_line[1:] if first_line and ord(first_line[0]) == 0xFEFF else first_line
        logger.rule("BOM", 1, first_line, "file starts with U+FEFF")
        issues.append(Issue(
            id="BOM", line=1, column=1, length=1,
            title="BOM 头",
            message="文件开头包含 BOM (Byte Order Mark)，可能导致解析异常",
            severity="warning", fix=fixed,
        ))
        logger.rule_after("BOM", 1, fixed)

    # 逐行规则
    for i, line in enumerate(lines):
        line_num = i + 1
        trimmed = line.strip()
        if trimmed == "" or trimmed.startswith("#"):
            continue
        ctx = build_line_ctx(line)
        for rule_fn, stop_on_hit in RULES:
            issue = rule_fn(line, line_num, ctx)
            if issue is None:
                continue
            if issue.fix is not None and issue.fix == line:
                continue
            logger.rule(issue.id, line_num, line, issue.title)
            logger.rule_after(issue.id, line_num, issue.fix)
            issues.append(issue)
            if stop_on_hit:
                break

    # 文件级 F1 重复 key
    try:
        dup = rule_duplicate_key(lines)
        for iss in dup:
            logger.rule(iss.id, iss.line, lines[iss.line - 1] if iss.line - 1 < len(lines) else "", iss.title)
            logger.rule_after(iss.id, iss.line, iss.fix)
        issues.extend(dup)
    except Exception as e:  # noqa: BLE001
        logger.warn("duplicate-key rule crashed:", str(e))

    # Parser 兜底（P1~P4）—— 与 JS 版 (js-yaml `parseAllDocuments`) 对齐
    #
    # 【核心策略】PyYAML 一次只暴露首个 error，与 js-yaml 一次性拿到 doc.errors[] 差异极大。
    # 为让 Python 版报出的错误集合与 JS 版一致，这里采用「fix-then-retry」的贪心迭代：
    #   ① safe_load_all(content) → 拿首个 error，生成 fix 加入 issues
    #   ② 用 fix 后的行替换原内容，重新 safe_load_all
    #   ③ 直到 clean / 上限 32 轮 / 无法继续修 (fix 为 None 或结果不变)
    # 迭代上限 32 用于防止病态输入导致的死循环。
    if _YAML_AVAILABLE:
        current = content
        MAX_ITER = 32
        prev_err_line = -1
        prev_err_line_repeat = 0
        exit_reason = 'clean'
        for _iter in range(MAX_ITER):
            err = None
            try:
                list(_yaml.safe_load_all(current))
            except _yaml.YAMLError as e:  # noqa: F821
                err = e
            except Exception as e:  # noqa: BLE001
                logger.warn("PyYAML unexpected exception:", str(e))
                exit_reason = 'unexpected'
                break
            if err is None:
                exit_reason = 'clean'
                break
            err_line, err_col = _extract_pyyaml_error_line(err)
            # 若连续两轮同行同错 → 说明当前 fix 策略无法推进，主动退出防死循环
            if err_line == prev_err_line:
                prev_err_line_repeat += 1
                if prev_err_line_repeat >= 2:
                    exit_reason = 'stuck'
                    break
            else:
                prev_err_line = err_line
                prev_err_line_repeat = 0
            already = any(iss.line == err_line and iss.severity == "error" for iss in issues)
            cur_lines = current.split("\n")
            line_text = cur_lines[err_line - 1] if 0 < err_line <= len(cur_lines) else ""
            fix = generate_fix_for_parse_error(line_text, err_col, str(err))
            if fix is not None and fix == line_text:
                fix = None
            if not already:
                logger.rule("P*", err_line, line_text, f"parse error (iter {_iter + 1}): {err}")
                logger.rule_after("P*", err_line, fix)
                # issue.fix 必须基于原始 content 的对应行（apply_fixes 阶段基于 original 索引）
                orig_line_text = lines[err_line - 1] if 0 < err_line <= len(lines) else ""
                orig_fix = generate_fix_for_parse_error(orig_line_text, err_col, str(err))
                if orig_fix is not None and orig_fix == orig_line_text:
                    orig_fix = None
                issues.append(Issue(
                    id="P*", line=err_line, column=err_col, length=1,
                    title="YAML 解析错误",
                    message=f"YAML 解析错误 (第 {err_line} 行): {truncate_yaml_message(str(err))}",
                    severity="error", fix=orig_fix,
                ))
            if fix is None:
                exit_reason = 'unfixable'
                break
            if 0 < err_line <= len(cur_lines):
                cur_lines[err_line - 1] = fix
                new_current = "\n".join(cur_lines)
                if new_current == current:
                    exit_reason = 'no-progress'
                    break
                current = new_current
            else:
                exit_reason = 'out-of-bounds'
                break
        else:
            exit_reason = 'max-iter'
        logger.debug(f"parser-fallback loop exited: reason={exit_reason}, iterations={_iter + 1}")
    else:
        logger.warn("PyYAML 未安装；已跳过 P1~P4 parser 级兜底修复。可执行：pip install pyyaml")

    return issues


# ═══════════════════════════════════════════════════════════════════════════
# 批量 apply
# ═══════════════════════════════════════════════════════════════════════════
def apply_fixes(content: str, issues: List[Issue], logger: Logger) -> Tuple[str, int, int]:
    line_fixes: Dict[int, List[str]] = {}
    for iss in issues:
        if iss.fix is None:
            continue
        line_fixes.setdefault(iss.line, []).append(iss.fix)
    if not line_fixes:
        return content, 0, 0
    lines = content.split("\n")
    applied = skipped = 0
    for line_num in sorted(line_fixes.keys(), reverse=True):
        idx = line_num - 1
        if idx < 0 or idx >= len(lines):
            skipped += 1
            continue
        arr = line_fixes[line_num]
        final_fix = arr[-1]
        if lines[idx] == final_fix:
            skipped += 1
            continue
        logger.debug(
            f"APPLY L{line_num}: "
            f"{json.dumps(lines[idx], ensure_ascii=False)} → {json.dumps(final_fix, ensure_ascii=False)} "
            f"({len(arr)} fix candidate{'s' if len(arr) > 1 else ''}, kept last)"
        )
        lines[idx] = final_fix
        applied += 1
    return "\n".join(lines), applied, skipped


# ═══════════════════════════════════════════════════════════════════════════
# 完整性 & 水印（防复制/防篡改）
# ═══════════════════════════════════════════════════════════════════════════
import hashlib as _hashlib
import platform as _platform
import getpass as _getpass


def _sha256_file(fp: str) -> Optional[str]:
    try:
        with open(fp, "rb") as f:
            return _hashlib.sha256(f.read()).hexdigest()
    except Exception:  # noqa: BLE001
        return None


def _verify_integrity(logger: "Logger") -> Optional[dict]:
    """依据 skill 根目录下 manifest.json 逐文件校验 sha256。
    - 找不到 manifest.json：跳过（开发态运行）。
    - 校验失败：打印告警；若 env YAML_FIX_STRICT=1 则直接退出。
    """
    skill_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    manifest_path = os.path.join(skill_root, "manifest.json")
    if not os.path.isfile(manifest_path):
        logger.info("[integrity] manifest.json not found — skip (dev mode)")
        return None
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception as e:  # noqa: BLE001
        msg = f"[integrity] manifest.json parse failed: {e}"
        if os.environ.get("YAML_FIX_STRICT") == "1":
            print(msg, file=sys.stderr)
            sys.exit(97)
        logger.warn(msg)
        return None

    mismatches = []
    for rel, expected in (manifest.get("files") or {}).items():
        actual = _sha256_file(os.path.join(skill_root, rel))
        if actual != expected:
            mismatches.append((rel, expected, actual))
    if mismatches:
        summary = "\n".join(
            f"  - {rel}: expect {str(exp)[:12]}… got {str(act)[:12]}…"
            for rel, exp, act in mismatches
        )
        msg = f"[integrity] SKILL FILES TAMPERED ({len(mismatches)} file(s) mismatch):\n{summary}"
        if os.environ.get("YAML_FIX_STRICT") == "1":
            print(msg, file=sys.stderr)
            sys.exit(97)
        logger.warn(msg)
        return manifest
    logger.info(
        f"[integrity] OK — verified {len(manifest.get('files') or {})} file(s) "
        f"against manifest v{manifest.get('version', '?')}"
    )
    return manifest


def _machine_fingerprint() -> str:
    raw = "|".join([
        _platform.node() or "",
        (_getpass.getuser() if hasattr(_getpass, "getuser") else "") or "",
        _platform.system() or "",
        _platform.machine() or "",
    ])
    return _hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]


def _print_watermark(logger: "Logger", manifest: Optional[dict]) -> None:
    ver = (manifest or {}).get("version", "dev")
    fp = _machine_fingerprint()
    logger.info(f"[yaml-format-fix v{ver}] © 2026 myronliu · Proprietary · fingerprint={fp}")


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════
def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="fix_yaml.py",
        description="Fix YAML formatting issues (behavior-identical to VS Code extension).",
    )
    p.add_argument("file", help="Path to the YAML file to check/fix")
    p.add_argument("--dry-run", "-n", action="store_true", help="Do not modify the file; print what would be changed")
    p.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    p.add_argument("--verbose", "-v", action="store_true", help="Print each rule hit with BEFORE/AFTER line text")
    return p


def _issue_to_dict(iss: Issue) -> dict:
    d = asdict(iss)
    d["hasFix"] = iss.fix is not None
    d.pop("fix", None)
    return d


def main(argv: Optional[List[str]] = None) -> int:
    args = build_argparser().parse_args(argv)
    file_path = os.path.abspath(args.file)
    if not os.path.isfile(file_path):
        print(f"❌ File not found: {file_path}", file=sys.stderr)
        return 2
    logger = Logger(args.verbose)
    manifest = _verify_integrity(logger)
    _print_watermark(logger, manifest)
    logger.info(f"Reading {file_path}")
    with open(file_path, "r", encoding="utf-8") as f:
        original = f.read()
    logger.info(f"Size: {len(original.encode('utf-8'))} bytes, {original.count(chr(10)) + 1} lines")
    logger.info(f"YAML parser: {'available (P1~P4 enabled)' if _YAML_AVAILABLE else 'NOT AVAILABLE (line-rules only)'}")

    issues = validate(original, logger)
    new_content, applied, skipped = apply_fixes(original, issues, logger)

    silent_logger = Logger(False)
    remaining = validate(new_content, silent_logger)

    if args.json:
        out = {
            "file": file_path,
            "dryRun": args.dry_run,
            "totalIssues": len(issues),
            "errorCount": sum(1 for i in issues if i.severity == "error"),
            "warningCount": sum(1 for i in issues if i.severity == "warning"),
            "appliedLines": applied,
            "skippedLines": skipped,
            "remainingIssues": len(remaining),
            "yamlLibAvailable": _YAML_AVAILABLE,
            "issues": [_issue_to_dict(i) for i in issues],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        err_cnt = sum(1 for i in issues if i.severity == "error")
        warn_cnt = sum(1 for i in issues if i.severity == "warning")
        fix_cnt = sum(1 for i in issues if i.fix is not None)
        print("\n───────────── 检测结果 ─────────────")
        print(f"文件            ： {file_path}")
        print(f"总问题数        ： {len(issues)}  (error={err_cnt}, warning={warn_cnt})")
        print(f"可自动修复      ： {fix_cnt}")
        print(f"YAML 库         ： {'PyYAML 已加载（parser 兜底启用）' if _YAML_AVAILABLE else '未安装（仅逐行规则）'}")
        print("───────────────────────────────────")
        if issues:
            print("\n问题详单：")
            for iss in issues:
                sev = "⛔" if iss.severity == "error" else "⚠️ "
                fix_mark = "✅" if iss.fix is not None else "  "
                print(f"  {sev} {fix_mark} [{iss.id}] L{iss.line}:{iss.column}  {iss.title}  {iss.message}")
        print("\n───────────── 修复结果 ─────────────")
        print(f"应用修复行数    ： {applied}")
        print(f"跳过行数        ： {skipped}   (已一致 / 越界)")
        print(f"修复后剩余问题  ： {len(remaining)}")
        print("───────────────────────────────────")

    if args.dry_run:
        logger.info("DRY-RUN 模式：未写回文件。")
    elif applied > 0:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        logger.info(f"✅ 已写回文件（{applied} 行更新）")
    else:
        logger.info("无需修改（未发现可修复问题）。")

    return 2 if any(i.severity == "error" for i in remaining) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
