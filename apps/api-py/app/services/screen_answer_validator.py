"""Pure, bounded validation for generated screen-task answers.

Candidate code is parsed statically. It is never imported, evaluated, or
executed. The SQL-binding check accepts only a deliberately small, explicit
Python data-flow subset and fails closed outside it.
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal, TypeAlias

MAX_ANSWER_CHARS = 65_536
MAX_REQUIREMENTS = 64
MAX_FRAGMENTS_PER_REQUIREMENT = 16
MAX_COLLECTION_ITEMS = 64
MAX_FRAGMENT_CHARS = 4_096
MAX_SQL_TOKENS = 4_096
MAX_SQL_NESTING = 64

_FunctionNode: TypeAlias = ast.FunctionDef | ast.AsyncFunctionDef


class ScreenAnswerIssueCode(StrEnum):
    INPUT_TOO_LARGE = "input_too_large"
    INVALID_INPUT = "invalid_input"
    CODE_FENCE_UNBALANCED = "code_fence_unbalanced"
    CODE_FENCE_COUNT = "code_fence_count"
    CODE_FENCE_LANGUAGE_MISMATCH = "code_fence_language_mismatch"
    CODE_FENCE_TRAILING_CONTENT = "code_fence_trailing_content"
    PYTHON_SYNTAX_INVALID = "python_syntax_invalid"
    PYTHON_PROFILE_UNSUPPORTED = "python_profile_unsupported"
    PYTHON_TARGET_REQUIRED = "python_target_required"
    PYTHON_FORBIDDEN_OPERATION = "python_forbidden_operation"
    PYTHON_TOP_LEVEL_SCAFFOLDING = "python_top_level_scaffolding"
    SQL_LEX_INVALID = "sql_lex_invalid"
    SQL_SYNTAX_INVALID = "sql_syntax_invalid"
    SQL_STATEMENT_COUNT_INVALID = "sql_statement_count_invalid"
    SQL_STATEMENT_KIND_MISMATCH = "sql_statement_kind_mismatch"
    SQL_FORBIDDEN_STATEMENT = "sql_forbidden_statement"
    SQL_IDENTIFIER_MISSING = "sql_identifier_missing"
    SQL_CLAUSE_MISSING = "sql_clause_missing"
    REQUIRED_COVERAGE_MISSING = "required_coverage_missing"
    PUBLIC_SIGNATURE_MISSING = "public_signature_missing"
    VISIBLE_LITERAL_MISSING = "visible_literal_missing"
    EXTRA_TOP_LEVEL_LAYER = "extra_top_level_layer"
    UNREQUIRED_JOIN = "unrequired_join"
    UNREQUIRED_CTE = "unrequired_cte"
    UNREQUIRED_JSON_LAYER = "unrequired_json_layer"
    SQL_INTERPOLATION_UNSAFE = "sql_interpolation_unsafe"
    SQL_RECEIVER_UNTRUSTED = "sql_receiver_untrusted"
    SQL_DATAFLOW_UNSAFE = "sql_dataflow_unsafe"
    SQL_EXECUTE_COUNT_INVALID = "sql_execute_count_invalid"
    SQL_EXECUTE_UNREACHABLE = "sql_execute_unreachable"
    SQL_EXECUTE_OUTSIDE_TARGET = "sql_execute_outside_target"
    SQL_BINDING_MISSING = "sql_binding_missing"
    RUSSIAN_INTRO_MISSING = "russian_intro_missing"
    INLINE_CODE_COMMENT = "inline_code_comment"
    RUSSIAN_LINE_COMMENT_MISSING = "russian_line_comment_missing"


@dataclass(frozen=True, slots=True)
class StableCoverageRequirement:
    stable_id: str
    function_signatures: tuple[str, ...] = ()
    python_calls: tuple[str, ...] = ()
    identifiers: tuple[str, ...] = ()
    sql_clauses: tuple[str, ...] = ()
    literals: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ScreenAnswerValidationInput:
    answer: str
    stable_requirements: tuple[StableCoverageRequirement, ...] = ()
    visible_public_signature: str | None = None
    visible_literals: tuple[str, ...] = ()
    simplify: bool = False
    allow_join: bool = False
    allow_cte: bool = False
    allow_json: bool = False
    allow_helper: bool = False
    required_sql_bound_ids: tuple[str, ...] = ()
    trusted_sql_receivers: tuple[str, ...] = ("conn", "cursor")
    require_russian_intro: bool = False
    require_russian_line_comments: bool = False
    code_language: Literal["python", "sql"] = "python"
    python_shape: Literal["function", "script", "class", "pytest"] = "function"
    expected_sql_statement_kind: Literal["select", "insert", "update", "delete"] | None = None
    required_sql_identifiers: tuple[str, ...] = ()
    required_sql_clauses: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ScreenAnswerIssue:
    code: ScreenAnswerIssueCode
    stable_id: str | None = None


@dataclass(frozen=True, slots=True)
class ScreenAnswerValidationResult:
    valid: bool
    issues: tuple[ScreenAnswerIssue, ...]
    covered_stable_ids: tuple[str, ...] = ()
    missing_stable_ids: tuple[str, ...] = ()
    _issue_codes: tuple[ScreenAnswerIssueCode, ...] = field(default=(), repr=False)

    @property
    def issue_codes(self) -> tuple[ScreenAnswerIssueCode, ...]:
        """Unique stable codes for one bounded repair request."""
        return self._issue_codes


@dataclass(frozen=True, slots=True)
class _Placeholder:
    kind: Literal["qmark", "format", "named", "dollar"]
    key: str | int | None = None


@dataclass(frozen=True, slots=True)
class _SqlToken:
    kind: Literal["word", "identifier", "literal", "number", "symbol", "semicolon"]
    value: str
    depth: int


@dataclass(frozen=True, slots=True)
class _SqlFacts:
    statement_kind: str
    identifiers: frozenset[str]
    clauses: frozenset[str]
    literals: frozenset[str]
    has_join: bool
    has_cte: bool
    has_json: bool


@dataclass(frozen=True, slots=True)
class _StructuralFacts:
    function_signatures: frozenset[str] = frozenset()
    python_calls: frozenset[str] = frozenset()
    identifiers: frozenset[str] = frozenset()
    sql_clauses: frozenset[str] = frozenset()
    literals: frozenset[str] = frozenset()


@dataclass(slots=True)
class _SqlScan:
    trusted_receivers: set[str]
    protected_names: set[str]
    bindings: dict[str, ast.expr] = field(default_factory=dict)
    reachable_calls: list[ast.Call] = field(default_factory=list)
    reachable_call_ids: set[int] = field(default_factory=set)
    rejected_inside_ids: set[int] = field(default_factory=set)
    has_valid_binding: bool = False
    unsafe_interpolation: bool = False
    untrusted_receiver: bool = False
    unsafe_dataflow: bool = False
    sql_issue_codes: list[ScreenAnswerIssueCode] = field(default_factory=list)


_FENCE_LINE_RE = re.compile(r"(?m)^[ \t]*```([^\r\n`]*)[ \t]*$")
_RUSSIAN_RE = re.compile(r"[А-Яа-яЁё]{2,}")
_SQL_JOIN_RE = re.compile(r"\bJOIN\b", re.IGNORECASE)
_SQL_CTE_RE = re.compile(r"\bWITH\b[\s\S]*?\bAS\s*\(", re.IGNORECASE)
_NAME_RE = re.compile(r"[A-Za-z_]\w*")
_CONTROL_STATEMENTS = (
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.Try,
    ast.With,
    ast.AsyncWith,
    ast.Match,
)
_CONTROL_EXPRESSIONS = (
    ast.BoolOp,
    ast.IfExp,
    ast.Lambda,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
    ast.NamedExpr,
    ast.Yield,
    ast.YieldFrom,
)

_SQL_STATEMENT_KINDS = {"select", "insert", "update", "delete"}
_SQL_ALLOWED_CLAUSES = {
    "select",
    "from",
    "where",
    "group by",
    "having",
    "order by",
    "limit",
    "join",
    "with",
    "values",
    "set",
    "returning",
    "into",
}
_SQL_KEYWORDS = _SQL_ALLOWED_CLAUSES | {
    "as",
    "on",
    "and",
    "or",
    "not",
    "null",
    "is",
    "in",
    "like",
    "distinct",
    "all",
    "asc",
    "desc",
    "case",
    "when",
    "then",
    "else",
    "end",
    "left",
    "right",
    "inner",
    "outer",
    "full",
    "cross",
    "union",
    "offset",
    "fetch",
    "only",
    "by",
    "delete",
    "insert",
    "update",
}
_FORBIDDEN_SQL_HEADS = {
    "alter",
    "analyze",
    "attach",
    "begin",
    "call",
    "commit",
    "copy",
    "create",
    "delete",  # allowed only through the explicit statement-kind branch
    "detach",
    "drop",
    "execute",
    "explain",
    "grant",
    "insert",  # allowed only through the explicit statement-kind branch
    "merge",
    "pragma",
    "prepare",
    "reindex",
    "release",
    "revoke",
    "rollback",
    "savepoint",
    "set",  # session/transaction SET, not an UPDATE clause
    "truncate",
    "update",  # allowed only through the explicit statement-kind branch
    "vacuum",
}
_FORBIDDEN_SQL_ANYWHERE = _FORBIDDEN_SQL_HEADS - {
    "delete",
    "insert",
    "set",
    "update",
}
_MUTATING_METHODS = {
    "add",
    "append",
    "clear",
    "close",
    "discard",
    "extend",
    "insert",
    "pop",
    "remove",
    "reverse",
    "sort",
    "update",
    "__delitem__",
    "__setitem__",
}

_SQL_BINARY_SYMBOLS = {
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "<",
    ">",
    "<=",
    ">=",
    "!=",
    "<>",
    "||",
    "->",
    "->>",
}
_SQL_TRAILING_WORDS = {
    "and",
    "as",
    "by",
    "else",
    "from",
    "group",
    "having",
    "in",
    "into",
    "is",
    "join",
    "like",
    "limit",
    "not",
    "on",
    "or",
    "order",
    "returning",
    "set",
    "then",
    "union",
    "values",
    "when",
    "where",
    "with",
}
_SAFE_DEFAULT_UNARY_OPERATORS = (ast.UAdd, ast.USub)
_SAFE_ANNOTATION_NAMES = {
    "Any",
    "Callable",
    "Collection",
    "Dict",
    "Iterable",
    "Iterator",
    "List",
    "Mapping",
    "Optional",
    "Sequence",
    "Set",
    "Tuple",
    "Union",
    "bool",
    "bytes",
    "complex",
    "dict",
    "float",
    "frozenset",
    "int",
    "list",
    "object",
    "set",
    "str",
    "tuple",
    "type",
}


def _unique_codes(issues: list[ScreenAnswerIssue]) -> tuple[ScreenAnswerIssueCode, ...]:
    return tuple(dict.fromkeys(issue.code for issue in issues))


def _result(
    issues: list[ScreenAnswerIssue],
    *,
    covered: tuple[str, ...] = (),
    missing: tuple[str, ...] = (),
) -> ScreenAnswerValidationResult:
    return ScreenAnswerValidationResult(
        valid=not issues,
        issues=tuple(issues),
        covered_stable_ids=covered,
        missing_stable_ids=missing,
        _issue_codes=_unique_codes(issues),
    )


def _collection_is_bounded(values: tuple[str, ...]) -> bool:
    return len(values) <= MAX_COLLECTION_ITEMS and all(
        isinstance(value, str) and len(value) <= MAX_FRAGMENT_CHARS for value in values
    )


def _input_is_bounded(data: ScreenAnswerValidationInput) -> bool:
    if not isinstance(data.answer, str) or len(data.answer) > MAX_ANSWER_CHARS:
        return False
    if data.visible_public_signature is not None and (
        not isinstance(data.visible_public_signature, str)
        or len(data.visible_public_signature) > MAX_FRAGMENT_CHARS
    ):
        return False
    collections = (
        data.visible_literals,
        data.required_sql_bound_ids,
        data.trusted_sql_receivers,
        data.required_sql_identifiers,
        data.required_sql_clauses,
    )
    if any(not _collection_is_bounded(values) for values in collections):
        return False
    if len(data.stable_requirements) > MAX_REQUIREMENTS:
        return False
    for requirement in data.stable_requirements:
        evidence = (
            requirement.function_signatures,
            requirement.python_calls,
            requirement.identifiers,
            requirement.sql_clauses,
            requirement.literals,
        )
        if not (
            isinstance(requirement.stable_id, str)
            and 0 < len(requirement.stable_id) <= 128
            and sum(map(len, evidence)) <= MAX_FRAGMENTS_PER_REQUIREMENT
            and all(_collection_is_bounded(values) for values in evidence)
        ):
            return False
    return True


def _input_is_valid(data: ScreenAnswerValidationInput) -> bool:
    stable_ids = [requirement.stable_id for requirement in data.stable_requirements]
    identifier_collections = (data.required_sql_bound_ids, data.trusted_sql_receivers)
    stable_evidence = (
        (
            requirement.function_signatures,
            requirement.python_calls,
            requirement.identifiers,
            requirement.sql_clauses,
            requirement.literals,
        )
        for requirement in data.stable_requirements
    )
    return (
        data.code_language in {"python", "sql"}
        and data.python_shape in {"function", "script", "class", "pytest"}
        and (
            data.expected_sql_statement_kind is None
            or data.expected_sql_statement_kind in _SQL_STATEMENT_KINDS
        )
        and (data.code_language != "sql" or data.expected_sql_statement_kind is not None)
        and len(stable_ids) == len(set(stable_ids))
        and all(any(evidence) for evidence in stable_evidence)
        and all(
            value.isidentifier() for collection in identifier_collections for value in collection
        )
        and all(clause.casefold() in _SQL_ALLOWED_CLAUSES for clause in data.required_sql_clauses)
        and all(
            clause.casefold() in _SQL_ALLOWED_CLAUSES
            for requirement in data.stable_requirements
            for clause in requirement.sql_clauses
        )
        and all(
            all(part.isidentifier() for part in call.split("."))
            for requirement in data.stable_requirements
            for call in requirement.python_calls
        )
        and all(
            _parse_expected_function(signature) is not None
            for requirement in data.stable_requirements
            for signature in requirement.function_signatures
        )
        and all(
            all(part.isidentifier() for part in identifier.split("."))
            for identifier in data.required_sql_identifiers
        )
        and len(data.required_sql_bound_ids) == len(set(data.required_sql_bound_ids))
        and len(data.trusted_sql_receivers) == len(set(data.trusted_sql_receivers))
    )


def _extract_fenced_code(
    answer: str,
    *,
    expected_language: Literal["python", "sql"],
) -> tuple[str, str] | ScreenAnswerIssueCode:
    fences = list(_FENCE_LINE_RE.finditer(answer))
    if len(fences) % 2:
        return ScreenAnswerIssueCode.CODE_FENCE_UNBALANCED
    if len(fences) != 2:
        return ScreenAnswerIssueCode.CODE_FENCE_COUNT
    opening, closing = fences
    if closing.group(1).strip():
        return ScreenAnswerIssueCode.CODE_FENCE_UNBALANCED
    if opening.group(1).strip().casefold() != expected_language:
        return ScreenAnswerIssueCode.CODE_FENCE_LANGUAGE_MISMATCH
    if answer[closing.end() :].strip():
        return ScreenAnswerIssueCode.CODE_FENCE_TRAILING_CONTENT
    return answer[: opening.start()].strip(), answer[opening.end() : closing.start()].strip("\r\n")


def _parse_expected_function(signature: str | None) -> _FunctionNode | None:
    if not signature:
        return None
    try:
        parsed = ast.parse(f"{signature.rstrip()}\n    pass", mode="exec")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None
    if len(parsed.body) != 1 or not isinstance(
        parsed.body[0], (ast.FunctionDef, ast.AsyncFunctionDef)
    ):
        return None
    return parsed.body[0]


def _signature_matches(candidate: _FunctionNode, expected: _FunctionNode) -> bool:
    returns_match = (
        candidate.returns is None
        and expected.returns is None
        or candidate.returns is not None
        and expected.returns is not None
        and ast.dump(candidate.returns, include_attributes=False)
        == ast.dump(expected.returns, include_attributes=False)
    )
    return (
        type(candidate) is type(expected)
        and candidate.name == expected.name
        and ast.dump(candidate.args, include_attributes=False)
        == ast.dump(expected.args, include_attributes=False)
        and returns_match
    )


def _target_function(tree: ast.Module, expected: _FunctionNode | None) -> _FunctionNode | None:
    functions = [
        node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if expected is not None:
        return next((node for node in functions if node.name == expected.name), None)
    return functions[0] if len(functions) == 1 else None


def _canonical_signature(function: _FunctionNode) -> str:
    prefix = "async def" if isinstance(function, ast.AsyncFunctionDef) else "def"
    returns = f" -> {ast.unparse(function.returns)}" if function.returns is not None else ""
    return f"{prefix} {function.name}({ast.unparse(function.args)}){returns}:"


def _is_docstring_statement(statement: ast.stmt) -> bool:
    return bool(
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def _straight_line_statements(function: _FunctionNode) -> list[ast.stmt]:
    statements: list[ast.stmt] = []
    for statement in function.body:
        if _is_docstring_statement(statement):
            continue
        if isinstance(
            statement, (_CONTROL_STATEMENTS, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ) or _statement_has_expression_control(statement):
            continue
        statements.append(statement)
        if isinstance(statement, (ast.Return, ast.Raise)):
            break
    return statements


def _assigned_names(statement: ast.stmt) -> tuple[str, ...]:
    if isinstance(statement, ast.Assign):
        return tuple(target.id for target in statement.targets if isinstance(target, ast.Name))
    if isinstance(statement, (ast.AnnAssign, ast.AugAssign)) and isinstance(
        statement.target, ast.Name
    ):
        return (statement.target.id,)
    return ()


def _effective_statements(function: _FunctionNode) -> list[ast.stmt]:
    statements = _straight_line_statements(function)
    effective: list[ast.stmt] = []
    for index, statement in enumerate(statements):
        assigned = _assigned_names(statement)
        if assigned:
            later_loaded = {
                node.id
                for later in statements[index + 1 :]
                for node in ast.walk(later)
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
            }
            has_execute = bool(_execute_calls(statement))
            if not has_execute and not any(name in later_loaded for name in assigned):
                continue
        effective.append(statement)
    return effective


def _effective_source(code: str, target: _FunctionNode | None) -> tuple[str, list[ast.stmt]]:
    if target is None:
        return "", []
    statements = _effective_statements(target)
    segments = [_canonical_signature(target)]
    segments.extend(
        segment
        for statement in statements
        if (segment := ast.get_source_segment(code, statement)) is not None
    )
    return "\n".join(segments), statements


def _dotted_name(expression: ast.expr) -> str | None:
    if isinstance(expression, ast.Name):
        return expression.id
    if isinstance(expression, ast.Attribute):
        parent = _dotted_name(expression.value)
        return f"{parent}.{expression.attr}" if parent else None
    return None


def _python_structural_facts(
    target: _FunctionNode,
    effective_statements: list[ast.stmt],
) -> _StructuralFacts:
    calls = {
        dotted
        for statement in effective_statements
        for node in ast.walk(statement)
        if isinstance(node, ast.Call) and (dotted := _dotted_name(node.func)) is not None
    }
    identifiers = {
        node.id.casefold()
        for statement in effective_statements
        for node in ast.walk(statement)
        if isinstance(node, ast.Name)
    }
    identifiers.update(
        node.attr.casefold()
        for statement in effective_statements
        for node in ast.walk(statement)
        if isinstance(node, ast.Attribute)
    )
    literals = _visible_constants(effective_statements)
    sql_identifiers: set[str] = set()
    sql_clauses: set[str] = set()
    sql_literals: set[str] = set()
    bindings: dict[str, ast.expr] = {}
    for statement in _straight_line_statements(target):
        for call in _execute_calls(statement):
            if not call.args:
                continue
            query = _literal_text(call.args[0], bindings)
            if query is None:
                continue
            tokens = _lex_sql(query)
            facts = _sql_facts(tokens) if tokens is not None else None
            if facts is not None and facts.statement_kind in _SQL_STATEMENT_KINDS:
                sql_identifiers.update(facts.identifiers)
                sql_clauses.update(facts.clauses)
                sql_literals.update(facts.literals)
        if isinstance(statement, (ast.Assign, ast.AnnAssign)) and statement.value is not None:
            for name in _assigned_names(statement):
                bindings[name] = statement.value
    identifiers.update(sql_identifiers)
    literals.update(sql_literals)
    return _StructuralFacts(
        function_signatures=frozenset({_canonical_signature(target)}),
        python_calls=frozenset(calls),
        identifiers=frozenset(identifiers),
        sql_clauses=frozenset(sql_clauses),
        literals=frozenset(literals),
    )


def _sql_structural_facts(facts: _SqlFacts) -> _StructuralFacts:
    return _StructuralFacts(
        identifiers=facts.identifiers,
        sql_clauses=facts.clauses,
        literals=facts.literals,
    )


def _requirement_is_covered(
    requirement: StableCoverageRequirement,
    facts: _StructuralFacts,
) -> bool:
    expected_signatures: set[str] = set()
    for signature in requirement.function_signatures:
        parsed = _parse_expected_function(signature)
        if parsed is None:
            return False
        expected_signatures.add(_canonical_signature(parsed))
    return (
        expected_signatures.issubset(facts.function_signatures)
        and set(requirement.python_calls).issubset(facts.python_calls)
        and {identifier.casefold() for identifier in requirement.identifiers}.issubset(
            facts.identifiers
        )
        and {clause.casefold() for clause in requirement.sql_clauses}.issubset(facts.sql_clauses)
        and set(requirement.literals).issubset(facts.literals)
    )


def _visible_constants(statements: list[ast.stmt]) -> set[str]:
    return {
        str(node.value)
        for statement in statements
        if not isinstance(statement, ast.Expr) or _direct_execute_call(statement) is not None
        for node in ast.walk(statement)
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bytes))
    }


def _resolved_expr(expr: ast.expr, bindings: dict[str, ast.expr]) -> ast.expr:
    seen: set[str] = set()
    while isinstance(expr, ast.Name) and expr.id in bindings and expr.id not in seen:
        seen.add(expr.id)
        expr = bindings[expr.id]
    return expr


def _literal_text(expr: ast.expr, bindings: dict[str, ast.expr]) -> str | None:
    resolved = _resolved_expr(expr, bindings)
    return (
        resolved.value
        if isinstance(resolved, ast.Constant) and isinstance(resolved.value, str)
        else None
    )


def _query_is_interpolated(expr: ast.expr, bindings: dict[str, ast.expr]) -> bool:
    resolved = _resolved_expr(expr, bindings)
    if isinstance(resolved, (ast.JoinedStr, ast.BinOp)):
        return True
    return (
        isinstance(resolved, ast.Call)
        and isinstance(resolved.func, ast.Attribute)
        and resolved.func.attr == "format"
    )


def _quoted_sql_token(
    sql: str,
    start: int,
    opening: str,
    closing: str,
) -> tuple[str, int] | None:
    value: list[str] = []
    index = start + 1
    while index < len(sql):
        char = sql[index]
        next_char = sql[index + 1] if index + 1 < len(sql) else ""
        if char == closing:
            if next_char == closing:
                value.append(closing)
                index += 2
                continue
            return "".join(value), index + 1
        if char == "\\" and opening != "[":
            # Backslash escaping is dialect/session dependent (notably PostgreSQL's
            # standard_conforming_strings). Fail closed instead of hiding a quote.
            return None
        value.append(char)
        index += 1
    return None


def _lex_sql(sql: str) -> tuple[_SqlToken, ...] | None:
    tokens: list[_SqlToken] = []
    index = 0
    depth = 0
    while index < len(sql):
        if len(tokens) >= MAX_SQL_TOKENS:
            return None
        char = sql[index]
        next_char = sql[index + 1] if index + 1 < len(sql) else ""
        if char.isspace():
            index += 1
            continue
        if char == "-" and next_char == "-":
            newline = sql.find("\n", index + 2)
            index = len(sql) if newline < 0 else newline + 1
            continue
        if char == "/" and next_char == "*":
            closing_comment = sql.find("*/", index + 2)
            if closing_comment < 0:
                return None
            if "\n" in sql[index:closing_comment] or "\r" in sql[index:closing_comment]:
                return None
            index = closing_comment + 2
            continue
        if char == "$":
            tag_match = re.match(r"\$[A-Za-z_]*\$", sql[index:])
            if tag_match:
                tag = tag_match.group(0)
                closing_tag = sql.find(tag, index + len(tag))
                if closing_tag < 0:
                    return None
                if (
                    "\n" in sql[index + len(tag) : closing_tag]
                    or "\r" in sql[index + len(tag) : closing_tag]
                ):
                    return None
                tokens.append(
                    _SqlToken(
                        "literal",
                        sql[index + len(tag) : closing_tag],
                        depth,
                    )
                )
                index = closing_tag + len(tag)
                continue
            positional = re.match(r"\$\d+", sql[index:])
            if positional:
                tokens.append(_SqlToken("symbol", positional.group(0), depth))
                index += len(positional.group(0))
                continue
        if char in {"'", '"', "`", "["}:
            closing = "]" if char == "[" else char
            quoted = _quoted_sql_token(sql, index, char, closing)
            if quoted is None:
                return None
            value, index = quoted
            kind: Literal["literal", "identifier"] = "literal" if char == "'" else "identifier"
            tokens.append(_SqlToken(kind, value, depth))
            continue
        if char == "(":
            tokens.append(_SqlToken("symbol", char, depth))
            depth += 1
            if depth > MAX_SQL_NESTING:
                return None
            index += 1
            continue
        if char == ")":
            depth -= 1
            if depth < 0:
                return None
            tokens.append(_SqlToken("symbol", char, depth))
            index += 1
            continue
        if char == ";":
            if depth != 0:
                return None
            tokens.append(_SqlToken("semicolon", char, depth))
            index += 1
            continue
        if char == ":" and next_char != ":":
            parameter = _NAME_RE.match(sql, index + 1)
            if parameter:
                tokens.append(_SqlToken("symbol", f":{parameter.group(0)}", depth))
                index = parameter.end()
                continue
        if sql.startswith("%(", index):
            closing_parameter = sql.find(")s", index + 2)
            if closing_parameter < 0:
                return None
            parameter_name = sql[index + 2 : closing_parameter]
            if not parameter_name.isidentifier():
                return None
            tokens.append(_SqlToken("symbol", sql[index : closing_parameter + 2], depth))
            index = closing_parameter + 2
            continue
        if sql.startswith("%s", index):
            tokens.append(_SqlToken("symbol", "%s", depth))
            index += 2
            continue
        if char == "?":
            tokens.append(_SqlToken("symbol", char, depth))
            index += 1
            continue
        if char.isalpha() or char == "_":
            end = index + 1
            while end < len(sql) and (sql[end].isalnum() or sql[end] in {"_", "$"}):
                end += 1
            tokens.append(_SqlToken("word", sql[index:end], depth))
            index = end
            continue
        if char.isdigit():
            number = re.match(r"\d+(?:\.\d+)?", sql[index:])
            assert number is not None
            tokens.append(_SqlToken("number", number.group(0), depth))
            index += len(number.group(0))
            continue
        operator = next(
            (
                candidate
                for candidate in ("::", "->>", "->", "<=", ">=", "!=", "<>", "||")
                if sql.startswith(candidate, index)
            ),
            None,
        )
        if operator:
            tokens.append(_SqlToken("symbol", operator, depth))
            index += len(operator)
            continue
        if char in ".,+-*/%=<>!":
            tokens.append(_SqlToken("symbol", char, depth))
            index += 1
            continue
        return None
    return tuple(tokens) if depth == 0 else None


def _sql_facts(tokens: tuple[_SqlToken, ...]) -> _SqlFacts | None:
    if not tokens:
        return None
    semicolons = [index for index, token in enumerate(tokens) if token.kind == "semicolon"]
    if semicolons and (len(semicolons) != 1 or semicolons[0] != len(tokens) - 1):
        return None
    body = tokens[:-1] if semicolons else tokens
    words_at_root = [
        token.value.casefold() for token in body if token.kind == "word" and token.depth == 0
    ]
    if not words_at_root:
        return None
    head = words_at_root[0]
    if head == "with":
        statement_kind = next(
            (word for word in words_at_root[1:] if word in _SQL_STATEMENT_KINDS),
            "",
        )
    else:
        statement_kind = head if head in _SQL_STATEMENT_KINDS else ""
    if not statement_kind:
        return _SqlFacts(
            statement_kind=head,
            identifiers=frozenset(),
            clauses=frozenset(),
            literals=frozenset(),
            has_join=False,
            has_cte=head == "with",
            has_json=False,
        )

    word_values = [token.value.casefold() for token in body if token.kind == "word"]
    clauses = {word for word in word_values if word in _SQL_ALLOWED_CLAUSES}
    for first, second in zip(word_values, word_values[1:]):
        combined = f"{first} {second}"
        if combined in _SQL_ALLOWED_CLAUSES:
            clauses.add(combined)
    identifiers: set[str] = {
        token.value.casefold()
        for token in body
        if token.kind == "identifier"
        or token.kind == "word"
        and token.value.casefold() not in _SQL_KEYWORDS
    }
    for index, token in enumerate(body):
        if token.kind not in {"word", "identifier"}:
            continue
        parts = [token.value.casefold()]
        cursor = index + 1
        while (
            cursor + 1 < len(body)
            and body[cursor].kind == "symbol"
            and body[cursor].value == "."
            and body[cursor + 1].kind in {"word", "identifier"}
        ):
            parts.append(body[cursor + 1].value.casefold())
            identifiers.add(".".join(parts))
            cursor += 2
    literals = {token.value for token in body if token.kind in {"literal", "number"}}
    has_json_function = any(
        token.kind == "word"
        and token.value.casefold().startswith(("json_", "jsonb_"))
        and index + 1 < len(body)
        and body[index + 1].kind == "symbol"
        and body[index + 1].value == "("
        for index, token in enumerate(body)
    )
    has_json_cast = any(
        token.kind == "symbol"
        and token.value == "::"
        and index + 1 < len(body)
        and body[index + 1].kind == "word"
        and body[index + 1].value.casefold() in {"json", "jsonb"}
        for index, token in enumerate(body)
    )
    return _SqlFacts(
        statement_kind=statement_kind,
        identifiers=frozenset(identifiers),
        clauses=frozenset(clauses),
        literals=frozenset(literals),
        has_join="join" in clauses,
        has_cte=head == "with",
        has_json=has_json_function
        or has_json_cast
        or any(token.value in {"->", "->>"} for token in body),
    )


def _sql_safety_issue(tokens: tuple[_SqlToken, ...]) -> ScreenAnswerIssueCode | None:
    body = tokens[:-1] if tokens and tokens[-1].kind == "semicolon" else tokens
    all_words = [token.value.casefold() for token in body if token.kind == "word"]
    if any(word in _FORBIDDEN_SQL_ANYWHERE for word in all_words):
        return ScreenAnswerIssueCode.SQL_FORBIDDEN_STATEMENT

    root_words = [
        token.value.casefold() for token in body if token.kind == "word" and token.depth == 0
    ]
    if not root_words:
        return None
    main_kind = next(
        (word for word in root_words if word in _SQL_STATEMENT_KINDS),
        "",
    )
    mutation_words = {"delete", "insert", "update"}
    mutation_occurrences = [word for word in all_words if word in mutation_words]
    expected_mutations = [main_kind] if main_kind in mutation_words else []
    if mutation_occurrences != expected_mutations:
        return ScreenAnswerIssueCode.SQL_FORBIDDEN_STATEMENT
    if "set" in all_words and main_kind != "update":
        return ScreenAnswerIssueCode.SQL_FORBIDDEN_STATEMENT

    root_select_indexes = [index for index, word in enumerate(root_words) if word == "select"]
    permitted_first_select = 1 if main_kind in {"select", "insert"} else 0
    for occurrence, index in enumerate(root_select_indexes):
        if occurrence < permitted_first_select:
            continue
        previous = root_words[index - 1] if index else ""
        before_previous = root_words[index - 2] if index > 1 else ""
        if previous != "union" and not (previous == "all" and before_previous == "union"):
            return ScreenAnswerIssueCode.SQL_STATEMENT_COUNT_INVALID
    return None


def _sql_body(tokens: tuple[_SqlToken, ...]) -> tuple[_SqlToken, ...]:
    return tokens[:-1] if tokens and tokens[-1].kind == "semicolon" else tokens


def _matching_sql_paren(tokens: tuple[_SqlToken, ...], opening_index: int) -> int | None:
    opening = tokens[opening_index]
    if opening.kind != "symbol" or opening.value != "(":
        return None
    return next(
        (
            index
            for index in range(opening_index + 1, len(tokens))
            if tokens[index].kind == "symbol"
            and tokens[index].value == ")"
            and tokens[index].depth == opening.depth
        ),
        None,
    )


def _shift_sql_depth(tokens: tuple[_SqlToken, ...], amount: int) -> tuple[_SqlToken, ...]:
    return tuple(_SqlToken(token.kind, token.value, token.depth - amount) for token in tokens)


def _sql_segment_is_valid(tokens: tuple[_SqlToken, ...], *, projection: bool = False) -> bool:
    if not tokens:
        return False
    first = tokens[0]
    last = tokens[-1]
    if first.kind == "symbol" and first.value in {",", ")", ".", "=", "||", "->", "->>"}:
        return False
    if first.kind == "word" and first.value.casefold() in {
        "and",
        "as",
        "by",
        "else",
        "from",
        "having",
        "on",
        "or",
        "then",
        "where",
    }:
        return False
    if last.kind == "symbol" and (
        last.value in _SQL_BINARY_SYMBOLS | {",", ".", "("}
        and not (projection and len(tokens) == 1 and last.value == "*")
    ):
        return False
    if last.kind == "word" and last.value.casefold() in _SQL_TRAILING_WORDS:
        return False
    for index, token in enumerate(tokens):
        if token.kind == "word" and token.value.casefold() in {"and", "or"}:
            if (
                index + 1 >= len(tokens)
                or tokens[index + 1].kind == "word"
                and tokens[index + 1].value.casefold() in {"and", "or"}
            ):
                return False
        if token.kind != "symbol" or token.value not in _SQL_BINARY_SYMBOLS:
            continue
        if index == 0:
            if projection and len(tokens) == 1 and token.value == "*":
                continue
            if token.value not in {"+", "-"}:
                return False
            continue
        previous = tokens[index - 1]
        if previous.kind == "symbol" and previous.value in _SQL_BINARY_SYMBOLS:
            if token.value not in {"+", "-"}:
                return False
    return True


def _select_clause_at(tokens: tuple[_SqlToken, ...], index: int) -> tuple[str, int] | None:
    token = tokens[index]
    if token.kind != "word" or token.depth != 0:
        return None
    word = token.value.casefold()
    next_word = (
        tokens[index + 1].value.casefold()
        if index + 1 < len(tokens)
        and tokens[index + 1].kind == "word"
        and tokens[index + 1].depth == 0
        else ""
    )
    if word in {"group", "order"}:
        return (f"{word} by", index + 2) if next_word == "by" else ("invalid", index + 1)
    if word in {"left", "right", "full"}:
        cursor = index + 1
        if next_word == "outer":
            cursor += 1
        if (
            cursor < len(tokens)
            and tokens[cursor].kind == "word"
            and tokens[cursor].depth == 0
            and tokens[cursor].value.casefold() == "join"
        ):
            return "join", cursor + 1
        return "invalid", index + 1
    if word in {"inner", "cross"}:
        if next_word == "join":
            return ("cross join" if word == "cross" else "join"), index + 2
        return "invalid", index + 1
    if word in {
        "fetch",
        "from",
        "having",
        "join",
        "limit",
        "offset",
        "on",
        "using",
        "where",
    }:
        return word, index + 1
    if word in {
        "delete",
        "insert",
        "into",
        "returning",
        "select",
        "set",
        "update",
        "values",
        "with",
    }:
        return "invalid", index + 1
    return None


def _sql_select_shape_is_valid(tokens: tuple[_SqlToken, ...]) -> bool:
    union_indexes = [
        index
        for index, token in enumerate(tokens)
        if token.kind == "word" and token.depth == 0 and token.value.casefold() == "union"
    ]
    if union_indexes:
        start = 0
        for union_index in (*union_indexes, len(tokens)):
            part = tokens[start:union_index]
            if not part or not _sql_select_shape_is_valid(part):
                return False
            if union_index == len(tokens):
                break
            start = union_index + 1
            if (
                start < len(tokens)
                and tokens[start].kind == "word"
                and tokens[start].depth == 0
                and tokens[start].value.casefold() == "all"
            ):
                start += 1
        return True

    if not tokens or tokens[0].kind != "word" or tokens[0].value.casefold() != "select":
        return False
    projection_start = 1
    if (
        projection_start < len(tokens)
        and tokens[projection_start].kind == "word"
        and tokens[projection_start].depth == 0
        and tokens[projection_start].value.casefold() in {"all", "distinct"}
    ):
        projection_start += 1

    clauses: list[tuple[str, int, int]] = []
    index = projection_start
    while index < len(tokens):
        clause = _select_clause_at(tokens, index)
        if clause is None:
            index += 1
            continue
        name, content_start = clause
        if name == "invalid":
            return False
        clauses.append((name, index, content_start))
        index = content_start

    projection_end = clauses[0][1] if clauses else len(tokens)
    if not _sql_segment_is_valid(tokens[projection_start:projection_end], projection=True):
        return False

    order = {
        "from": 1,
        "join": 2,
        "cross join": 2,
        "on": 2,
        "using": 2,
        "where": 3,
        "group by": 4,
        "having": 5,
        "order by": 6,
        "limit": 7,
        "offset": 8,
        "fetch": 9,
    }
    previous_order = 0
    pending_join: str | None = None
    seen_from = False
    for position, (name, _start, content_start) in enumerate(clauses):
        current_order = order[name]
        if current_order < previous_order and not (current_order == 2 and previous_order == 2):
            return False
        if name == "from":
            if seen_from:
                return False
            seen_from = True
        elif name in {"join", "cross join"}:
            if not seen_from or pending_join == "join":
                return False
            pending_join = name
        elif name in {"on", "using"}:
            if pending_join != "join":
                return False
            pending_join = None
        elif pending_join == "join":
            return False
        content_end = clauses[position + 1][1] if position + 1 < len(clauses) else len(tokens)
        if not _sql_segment_is_valid(tokens[content_start:content_end]):
            return False
        previous_order = max(previous_order, current_order)
    return pending_join != "join"


def _root_word_index(tokens: tuple[_SqlToken, ...], word: str, *, start: int = 0) -> int | None:
    return next(
        (
            index
            for index in range(start, len(tokens))
            if tokens[index].kind == "word"
            and tokens[index].depth == 0
            and tokens[index].value.casefold() == word
        ),
        None,
    )


def _sql_update_shape_is_valid(tokens: tuple[_SqlToken, ...]) -> bool:
    if not tokens or tokens[0].value.casefold() != "update":
        return False
    set_index = _root_word_index(tokens, "set", start=1)
    if set_index is None or not _sql_segment_is_valid(tokens[1:set_index]):
        return False
    where_index = _root_word_index(tokens, "where", start=set_index + 1)
    returning_index = _root_word_index(tokens, "returning", start=set_index + 1)
    set_end = min(
        (index for index in (where_index, returning_index, len(tokens)) if index is not None),
        default=len(tokens),
    )
    assignment = tokens[set_index + 1 : set_end]
    if not _sql_segment_is_valid(assignment) or not any(
        token.kind == "symbol" and token.value == "=" and token.depth == 0 for token in assignment
    ):
        return False
    if where_index is not None:
        where_end = returning_index if returning_index is not None else len(tokens)
        if returning_index is not None and returning_index < where_index:
            return False
        if not _sql_segment_is_valid(tokens[where_index + 1 : where_end]):
            return False
    return returning_index is None or _sql_segment_is_valid(tokens[returning_index + 1 :])


def _sql_delete_shape_is_valid(tokens: tuple[_SqlToken, ...]) -> bool:
    if len(tokens) < 3 or tokens[0].value.casefold() != "delete":
        return False
    if tokens[1].kind != "word" or tokens[1].value.casefold() != "from":
        return False
    where_index = _root_word_index(tokens, "where", start=2)
    returning_index = _root_word_index(tokens, "returning", start=2)
    target_end = min(
        (index for index in (where_index, returning_index, len(tokens)) if index is not None),
        default=len(tokens),
    )
    if not _sql_segment_is_valid(tokens[2:target_end]):
        return False
    if where_index is not None:
        where_end = returning_index if returning_index is not None else len(tokens)
        if returning_index is not None and returning_index < where_index:
            return False
        if not _sql_segment_is_valid(tokens[where_index + 1 : where_end]):
            return False
    return returning_index is None or _sql_segment_is_valid(tokens[returning_index + 1 :])


def _sql_insert_shape_is_valid(tokens: tuple[_SqlToken, ...]) -> bool:
    if len(tokens) < 4 or tokens[0].value.casefold() != "insert":
        return False
    if tokens[1].kind != "word" or tokens[1].value.casefold() != "into":
        return False
    values_index = _root_word_index(tokens, "values", start=2)
    select_index = _root_word_index(tokens, "select", start=2)
    returning_index = _root_word_index(tokens, "returning", start=2)
    source_indexes = [index for index in (values_index, select_index) if index is not None]
    if len(source_indexes) != 1:
        return False
    source_index = source_indexes[0]
    if not _sql_segment_is_valid(tokens[2:source_index]):
        return False
    source_end = returning_index if returning_index is not None else len(tokens)
    if returning_index is not None and returning_index < source_index:
        return False
    if values_index is not None:
        if not _sql_segment_is_valid(tokens[values_index + 1 : source_end]):
            return False
    elif not _sql_select_shape_is_valid(tokens[select_index:source_end]):
        return False
    return returning_index is None or _sql_segment_is_valid(tokens[returning_index + 1 :])


def _sql_with_main_index(tokens: tuple[_SqlToken, ...]) -> int | None:
    candidates = [
        index
        for index, token in enumerate(tokens[1:], start=1)
        if token.kind == "word"
        and token.depth == 0
        and token.value.casefold() in _SQL_STATEMENT_KINDS
    ]
    return candidates[0] if candidates else None


def _sql_with_prefix_is_valid(tokens: tuple[_SqlToken, ...], main_index: int) -> bool:
    index = 1
    if (
        index < main_index
        and tokens[index].kind == "word"
        and tokens[index].value.casefold() == "recursive"
    ):
        index += 1
    while index < main_index:
        if tokens[index].kind not in {"word", "identifier"}:
            return False
        if tokens[index].value.casefold() in _SQL_KEYWORDS:
            return False
        index += 1
        if index < main_index and tokens[index].kind == "symbol" and tokens[index].value == "(":
            columns_end = _matching_sql_paren(tokens, index)
            if columns_end is None or columns_end >= main_index:
                return False
            index = columns_end + 1
        if (
            index >= main_index
            or tokens[index].kind != "word"
            or tokens[index].depth != 0
            or tokens[index].value.casefold() != "as"
        ):
            return False
        index += 1
        if (
            index >= main_index
            or tokens[index].kind != "symbol"
            or tokens[index].value != "("
            or tokens[index].depth != 0
        ):
            return False
        closing = _matching_sql_paren(tokens, index)
        if closing is None or closing >= main_index:
            return False
        inner = _shift_sql_depth(tokens[index + 1 : closing], 1)
        if not _sql_shape_is_valid(inner):
            return False
        index = closing + 1
        if index == main_index:
            return True
        if tokens[index].kind != "symbol" or tokens[index].value != ",":
            return False
        index += 1
    return False


def _nested_sql_shapes_are_valid(tokens: tuple[_SqlToken, ...]) -> bool:
    for index, token in enumerate(tokens):
        if token.kind != "symbol" or token.value != "(":
            continue
        closing = _matching_sql_paren(tokens, index)
        if closing is None or closing == index + 1:
            continue
        inner = tokens[index + 1 : closing]
        first_word = next((item for item in inner if item.kind == "word"), None)
        if first_word is None or first_word.depth != token.depth + 1:
            continue
        if first_word.value.casefold() not in _SQL_STATEMENT_KINDS | {"with"}:
            continue
        if not _sql_shape_is_valid(_shift_sql_depth(inner, token.depth + 1)):
            return False
    return True


def _sql_shape_is_valid(tokens: tuple[_SqlToken, ...]) -> bool:
    body = _sql_body(tokens)
    if not body or not _nested_sql_shapes_are_valid(body):
        return False
    main = body
    head = body[0].value.casefold() if body[0].kind == "word" else ""
    if head == "with":
        main_index = _sql_with_main_index(body)
        if main_index is None or not _sql_with_prefix_is_valid(body, main_index):
            return False
        main = body[main_index:]
        head = main[0].value.casefold()
    if head == "select":
        root_words = {
            token.value.casefold() for token in main if token.kind == "word" and token.depth == 0
        }
        if "into" in root_words or "outfile" in root_words or "dumpfile" in root_words:
            return False
        return _sql_select_shape_is_valid(main)
    if head == "insert":
        return _sql_insert_shape_is_valid(main)
    if head == "update":
        return _sql_update_shape_is_valid(main)
    if head == "delete":
        return _sql_delete_shape_is_valid(main)
    return False


def _sql_placeholders(query: str) -> tuple[_Placeholder, ...] | None:
    tokens = _lex_sql(query)
    if tokens is None:
        return None
    placeholders: list[_Placeholder] = []
    for token in tokens:
        if token.kind != "symbol":
            continue
        value = token.value
        if value == "?":
            placeholders.append(_Placeholder("qmark"))
        elif value == "%s":
            placeholders.append(_Placeholder("format"))
        elif value.startswith("%(") and value.endswith(")s"):
            placeholders.append(_Placeholder("named", value[2:-2]))
        elif value.startswith(":") and len(value) > 1 and value[1:].isidentifier():
            placeholders.append(_Placeholder("named", value[1:]))
        elif value.startswith("$") and value[1:].isdigit():
            placeholders.append(_Placeholder("dollar", int(value[1:])))
    return tuple(placeholders)


def _parameter_expr(call: ast.Call, bindings: dict[str, ast.expr]) -> ast.expr | None:
    if len(call.args) == 2 and not call.keywords:
        return _resolved_expr(call.args[1], bindings)
    if len(call.args) == 1 and len(call.keywords) == 1:
        keyword = call.keywords[0]
        if keyword.arg in {"params", "parameters"}:
            return _resolved_expr(keyword.value, bindings)
    return None


def _positional_names(parameters: ast.expr | None) -> tuple[str, ...] | None:
    if not isinstance(parameters, (ast.Tuple, ast.List)):
        return None
    names: list[str] = []
    for element in parameters.elts:
        if not isinstance(element, ast.Name):
            return None
        names.append(element.id)
    return tuple(names)


def _named_bindings(parameters: ast.expr | None) -> dict[str, str] | None:
    if not isinstance(parameters, ast.Dict) or any(key is None for key in parameters.keys):
        return None
    bindings: dict[str, str] = {}
    for key, value in zip(parameters.keys, parameters.values, strict=True):
        if not (
            isinstance(key, ast.Constant)
            and isinstance(key.value, str)
            and isinstance(value, ast.Name)
        ):
            return None
        if key.value in bindings:
            return None
        bindings[key.value] = value.id
    return bindings


def _consume_sql_identifier_path(
    tokens: tuple[_SqlToken, ...],
    start: int,
    end: int,
) -> tuple[tuple[str, ...], int] | None:
    if start >= end:
        return None
    first = tokens[start]
    if (
        first.depth != 0
        or first.kind not in {"word", "identifier"}
        or first.kind == "word"
        and first.value.casefold() in _SQL_KEYWORDS
    ):
        return None
    parts = [first.value.casefold()]
    cursor = start + 1
    while cursor + 1 < end:
        dot = tokens[cursor]
        part = tokens[cursor + 1]
        if not (
            dot.depth == 0
            and dot.kind == "symbol"
            and dot.value == "."
            and part.depth == 0
            and part.kind in {"word", "identifier"}
            and not (part.kind == "word" and part.value.casefold() in _SQL_KEYWORDS)
        ):
            break
        parts.append(part.value.casefold())
        cursor += 2
    return tuple(parts), cursor


def _required_predicate_column(
    required_ids: tuple[str, ...],
    required_identifiers: tuple[str, ...],
) -> str | None:
    if len(required_ids) != 1:
        return None
    bound_id = required_ids[0].casefold()
    tails = {identifier.casefold().split(".")[-1] for identifier in required_identifiers}
    exact = {tail for tail in tails if tail == bound_id}
    candidates = exact or {tail for tail in tails if bound_id.endswith(f"_{tail}")}
    return next(iter(candidates)) if len(candidates) == 1 else None


def _is_sql_placeholder_token(token: _SqlToken) -> bool:
    if token.kind != "symbol":
        return False
    value = token.value
    return bool(
        value in {"?", "%s"}
        or value.startswith("%(")
        and value.endswith(")s")
        or value.startswith(":")
        and len(value) > 1
        and value[1:].isidentifier()
        or value.startswith("$")
        and value[1:].isdigit()
    )


def _required_select_predicate_binding_matches(
    query: str,
    required_ids: tuple[str, ...],
    required_identifiers: tuple[str, ...],
    required_clauses: tuple[str, ...],
) -> bool:
    required_clause_set = {clause.casefold() for clause in required_clauses}
    predicate_column = _required_predicate_column(required_ids, required_identifiers)
    if predicate_column is None or not {"select", "from", "where"}.issubset(required_clause_set):
        return True
    normalized_identifiers = {
        identifier.casefold(): identifier.casefold().split(".")[-1]
        for identifier in required_identifiers
    }
    required_tables = {
        name
        for identifier, tail in normalized_identifiers.items()
        if tail != predicate_column
        for name in (identifier, tail)
    }
    if not required_tables:
        return True

    tokens = _lex_sql(query)
    if tokens is None:
        return False
    body = _sql_body(tokens)
    if (
        not body
        or body[0].kind != "word"
        or body[0].value.casefold() != "select"
        or sum(token.kind == "word" and token.value.casefold() == "select" for token in body) != 1
        or any(
            token.kind == "word" and token.depth == 0 and token.value.casefold() in {"or", "union"}
            for token in body
        )
    ):
        return False
    from_index = _root_word_index(body, "from", start=1)
    where_index = _root_word_index(body, "where", start=1)
    if from_index is None or where_index is None or from_index >= where_index:
        return False

    source = _consume_sql_identifier_path(body, from_index + 1, where_index)
    if source is None:
        return False
    source_parts, source_end = source
    source_alias: str | None = None
    if source_end < where_index:
        if body[source_end].kind == "word" and body[source_end].value.casefold() == "as":
            source_end += 1
        alias = _consume_sql_identifier_path(body, source_end, where_index)
        if alias is None or len(alias[0]) != 1:
            return False
        (source_alias,), source_end = alias
    if source_end != where_index:
        return False
    source_names = {".".join(source_parts), source_parts[-1]}
    if source_names.isdisjoint(required_tables):
        return False

    later_clause_indexes = [
        index
        for index in range(where_index + 1, len(body))
        if _select_clause_at(body, index) is not None
    ]
    predicate_end = min(later_clause_indexes, default=len(body))
    predicate = body[where_index + 1 : predicate_end]
    equals = [
        index
        for index, token in enumerate(predicate)
        if token.kind == "symbol" and token.value == "=" and token.depth == 0
    ]
    if len(equals) != 1:
        return False
    equals_index = equals[0]
    left = predicate[:equals_index]
    right = predicate[equals_index + 1 :]
    qualifiers = {source_parts[-1]}
    if source_alias is not None:
        qualifiers.add(source_alias)

    def is_required_column(operand: tuple[_SqlToken, ...]) -> bool:
        parsed = _consume_sql_identifier_path(operand, 0, len(operand))
        if parsed is None or parsed[1] != len(operand):
            return False
        parts = parsed[0]
        return bool(parts[-1] == predicate_column and (len(parts) == 1 or parts[-2] in qualifiers))

    def is_placeholder(operand: tuple[_SqlToken, ...]) -> bool:
        return len(operand) == 1 and _is_sql_placeholder_token(operand[0])

    return bool(
        is_required_column(left)
        and is_placeholder(right)
        or is_placeholder(left)
        and is_required_column(right)
    )


def _binding_matches(
    call: ast.Call,
    query: str,
    required_ids: tuple[str, ...],
    bindings: dict[str, ast.expr],
) -> bool:
    placeholders = _sql_placeholders(query)
    if placeholders is None:
        return False
    if not required_ids:
        return not placeholders and _parameter_expr(call, bindings) is None and len(call.args) == 1
    if not placeholders:
        return False
    kinds = {placeholder.kind for placeholder in placeholders}
    parameters = _parameter_expr(call, bindings)
    if len(kinds) != 1:
        return False
    kind = next(iter(kinds))
    if kind in {"qmark", "format"}:
        names = _positional_names(parameters)
        return len(placeholders) == len(required_ids) and names == required_ids
    if kind == "dollar":
        names = _positional_names(parameters)
        indexes = tuple(placeholder.key for placeholder in placeholders)
        return indexes == tuple(range(1, len(required_ids) + 1)) and names == required_ids
    named = _named_bindings(parameters)
    placeholder_keys = {str(placeholder.key) for placeholder in placeholders}
    return bool(
        named is not None
        and placeholder_keys == set(required_ids)
        and set(named) == set(required_ids)
        and all(named[identifier] == identifier for identifier in required_ids)
    )


def _pure_sql_placeholders_match(query: str, required_ids: tuple[str, ...]) -> bool:
    placeholders = _sql_placeholders(query)
    if placeholders is None:
        return False
    if not required_ids:
        return not placeholders
    if not placeholders:
        return False
    kinds = {placeholder.kind for placeholder in placeholders}
    if len(kinds) != 1:
        return False
    kind = next(iter(kinds))
    if kind in {"qmark", "format"}:
        return len(placeholders) == len(required_ids)
    if kind == "dollar":
        return tuple(placeholder.key for placeholder in placeholders) == tuple(
            range(1, len(required_ids) + 1)
        )
    return {str(placeholder.key) for placeholder in placeholders} == set(required_ids)


def _execute_calls(node: ast.AST) -> list[ast.Call]:
    return [
        candidate
        for candidate in ast.walk(node)
        if isinstance(candidate, ast.Call)
        and isinstance(candidate.func, ast.Attribute)
        and candidate.func.attr == "execute"
    ]


def _trusted_cursor_value(value: ast.expr | None, trusted: set[str]) -> bool:
    return bool(
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Attribute)
        and value.func.attr == "cursor"
        and isinstance(value.func.value, ast.Name)
        and value.func.value.id in trusted
        and not value.args
        and not value.keywords
    )


def _statement_has_expression_control(statement: ast.stmt) -> bool:
    return any(isinstance(node, _CONTROL_EXPRESSIONS) for node in ast.walk(statement))


def _root_expression_name(expression: ast.expr) -> str | None:
    while isinstance(expression, (ast.Attribute, ast.Subscript)):
        expression = expression.value
    return expression.id if isinstance(expression, ast.Name) else None


def _statement_mutates_tracked_container(statement: ast.stmt, scan: _SqlScan) -> bool:
    tracked = set(scan.bindings).union(scan.protected_names)
    for node in ast.walk(statement):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Delete)):
            targets: tuple[ast.expr, ...]
            if isinstance(node, ast.Assign):
                targets = tuple(node.targets)
            elif isinstance(node, ast.Delete):
                targets = tuple(node.targets)
            else:
                targets = (node.target,)
            if any(
                not isinstance(target, ast.Name) and _root_expression_name(target) in tracked
                for target in targets
            ):
                return True
    for node in ast.walk(statement):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute) and node.func.attr == "execute":
            continue
        if isinstance(node.func, ast.Name) and node.func.id in {"bool", "len"}:
            continue
        passed_values = [*node.args, *(keyword.value for keyword in node.keywords)]
        if any(_root_expression_name(value) in tracked for value in passed_values):
            return True
    for node in ast.walk(statement):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in _MUTATING_METHODS
        ):
            continue
        receiver_name = _root_expression_name(node.func.value)
        if receiver_name in tracked:
            return True
        if any(isinstance(argument, ast.Name) and argument.id in tracked for argument in node.args):
            return True
    return False


def _direct_execute_call(statement: ast.stmt) -> ast.Call | None:
    expression: ast.expr | None = None
    if isinstance(statement, ast.Assign):
        expression = statement.value
    elif isinstance(statement, ast.AnnAssign):
        expression = statement.value
    elif isinstance(statement, (ast.Expr, ast.Return)):
        expression = statement.value
    if isinstance(expression, ast.Await):
        expression = expression.value
    if not (
        isinstance(expression, ast.Call)
        and isinstance(expression.func, ast.Attribute)
        and expression.func.attr == "execute"
    ):
        return None
    return expression


def _inspect_execute(
    call: ast.Call,
    scan: _SqlScan,
    required_ids: tuple[str, ...],
    required_identifiers: tuple[str, ...],
    required_clauses: tuple[str, ...],
    expected_statement_kind: str,
) -> None:
    scan.reachable_calls.append(call)
    scan.reachable_call_ids.add(id(call))
    function = call.func
    if not isinstance(function, ast.Attribute) or not isinstance(function.value, ast.Name):
        scan.untrusted_receiver = True
        return
    if function.value.id not in scan.trusted_receivers:
        scan.untrusted_receiver = True
        return
    if not call.args:
        return
    query_expr = call.args[0]
    unsafe = _query_is_interpolated(query_expr, scan.bindings)
    scan.unsafe_interpolation |= unsafe
    query = _literal_text(query_expr, scan.bindings)
    if not unsafe and query is not None:
        tokens = _lex_sql(query)
        if tokens is None:
            scan.sql_issue_codes.append(ScreenAnswerIssueCode.SQL_LEX_INVALID)
        else:
            facts = _sql_facts(tokens)
            safety_issue = _sql_safety_issue(tokens)
            if safety_issue is not None:
                scan.sql_issue_codes.append(safety_issue)
            if facts is None or not _sql_shape_is_valid(tokens):
                scan.sql_issue_codes.append(ScreenAnswerIssueCode.SQL_SYNTAX_INVALID)
            elif facts.statement_kind not in _SQL_STATEMENT_KINDS:
                scan.sql_issue_codes.append(ScreenAnswerIssueCode.SQL_FORBIDDEN_STATEMENT)
            elif facts.statement_kind != expected_statement_kind:
                scan.sql_issue_codes.append(ScreenAnswerIssueCode.SQL_STATEMENT_KIND_MISMATCH)
    if (
        not unsafe
        and query is not None
        and _binding_matches(call, query, required_ids, scan.bindings)
        and (
            expected_statement_kind != "select"
            or _required_select_predicate_binding_matches(
                query,
                required_ids,
                required_identifiers,
                required_clauses,
            )
        )
    ):
        scan.has_valid_binding = True


def _update_assignment(statement: ast.stmt, scan: _SqlScan, required_ids: tuple[str, ...]) -> None:
    names = _assigned_names(statement)
    if isinstance(statement, ast.AugAssign):
        if any(name in scan.protected_names or name in scan.bindings for name in names):
            scan.unsafe_dataflow = True
            for name in names:
                scan.trusted_receivers.discard(name)
                scan.bindings.pop(name, None)
        return
    if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
        if isinstance(statement, ast.Delete):
            for target in statement.targets:
                deleted_name = _root_expression_name(target)
                if deleted_name in scan.protected_names or deleted_name in scan.bindings:
                    scan.unsafe_dataflow = True
                    if deleted_name is not None:
                        scan.trusted_receivers.discard(deleted_name)
                        scan.bindings.pop(deleted_name, None)
        return
    value = statement.value
    exact_single_name = bool(
        len(names) == 1
        and (
            isinstance(statement, ast.AnnAssign)
            and isinstance(statement.target, ast.Name)
            or isinstance(statement, ast.Assign)
            and len(statement.targets) == 1
            and isinstance(statement.targets[0], ast.Name)
        )
    )
    if not exact_single_name or value is None:
        scan.unsafe_dataflow = True
        return
    cursor_value = _trusted_cursor_value(value, scan.trusted_receivers)
    for name in names:
        if name in required_ids:
            scan.unsafe_dataflow = True
        if name in scan.bindings:
            scan.unsafe_dataflow = True
            scan.bindings.pop(name, None)
        if name in scan.protected_names and not cursor_value:
            scan.unsafe_dataflow = True
            scan.trusted_receivers.discard(name)
        if cursor_value:
            scan.trusted_receivers.add(name)
            scan.protected_names.add(name)
        scan.bindings[name] = value


def _is_terminal_trusted_dict_rows_return(
    statement: ast.stmt,
    *,
    tree: ast.Module,
    target: _FunctionNode,
    scan: _SqlScan,
) -> bool:
    docstring_offset = int(bool(target.body and _is_docstring_statement(target.body[0])))
    statements = target.body[docstring_offset:]
    if len(statements) != 2 or statements[-1] is not statement:
        return False
    assignment = statements[0]
    assigned_names = _assigned_names(assignment)
    execute = _direct_execute_call(assignment)
    if (
        len(assigned_names) != 1
        or assigned_names[0] == "dict"
        or execute is None
        or scan.bindings.get(assigned_names[0]) is not execute
        or scan.reachable_calls != [execute]
        or not scan.has_valid_binding
        or scan.unsafe_interpolation
        or scan.untrusted_receiver
        or scan.unsafe_dataflow
        or scan.sql_issue_codes
        or any(
            isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
            and item is not target
            and item.name == "dict"
            for item in tree.body
        )
    ):
        return False
    if not isinstance(statement, ast.Return) or not isinstance(statement.value, ast.ListComp):
        return False
    comprehension = statement.value
    if len(comprehension.generators) != 1:
        return False
    generator = comprehension.generators[0]
    if (
        generator.is_async
        or generator.ifs
        or not isinstance(generator.target, ast.Name)
        or generator.target.id == "dict"
        or not isinstance(generator.iter, ast.Name)
        or generator.iter.id != assigned_names[0]
    ):
        return False
    conversion = comprehension.elt
    if not (
        isinstance(conversion, ast.Call)
        and isinstance(conversion.func, ast.Name)
        and conversion.func.id == "dict"
        and len(conversion.args) == 1
        and isinstance(conversion.args[0], ast.Name)
        and conversion.args[0].id == generator.target.id
        and not conversion.keywords
    ):
        return False
    calls = [node for node in ast.walk(target) if isinstance(node, ast.Call)]
    return len(calls) == 2 and execute in calls and conversion in calls


def _scan_target(
    tree: ast.Module,
    target: _FunctionNode,
    *,
    configured_receivers: tuple[str, ...],
    required_ids: tuple[str, ...],
    required_identifiers: tuple[str, ...],
    required_clauses: tuple[str, ...],
    expected_statement_kind: str,
) -> _SqlScan:
    arguments = {
        argument.arg
        for argument in (
            *target.args.posonlyargs,
            *target.args.args,
            *target.args.kwonlyargs,
            *((target.args.vararg,) if target.args.vararg is not None else ()),
            *((target.args.kwarg,) if target.args.kwarg is not None else ()),
        )
    }
    trusted = arguments.intersection(configured_receivers)
    scan = _SqlScan(
        trusted_receivers=set(trusted),
        protected_names=set(configured_receivers).union(required_ids),
    )
    if not set(required_ids).issubset(arguments):
        scan.unsafe_dataflow = True
    terminated = False
    for statement in target.body:
        if _is_docstring_statement(statement):
            continue
        calls = _execute_calls(statement)
        if terminated:
            scan.rejected_inside_ids.update(map(id, calls))
            _update_assignment(statement, scan, required_ids)
            continue
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            scan.rejected_inside_ids.update(map(id, calls))
            continue
        expression_control = _statement_has_expression_control(statement)
        if (
            isinstance(statement, _CONTROL_STATEMENTS)
            or isinstance(statement, ast.Assert)
            or expression_control
            and not _is_terminal_trusted_dict_rows_return(
                statement,
                tree=tree,
                target=target,
                scan=scan,
            )
            or _statement_mutates_tracked_container(statement, scan)
        ):
            scan.unsafe_dataflow = True
            scan.rejected_inside_ids.update(map(id, calls))
            continue
        direct_call = _direct_execute_call(statement)
        if calls:
            if direct_call is None:
                scan.rejected_inside_ids.update(map(id, calls))
                scan.unsafe_dataflow = True
            else:
                rejected = [call for call in calls if call is not direct_call]
                scan.rejected_inside_ids.update(map(id, rejected))
                if rejected:
                    scan.unsafe_dataflow = True
                _inspect_execute(
                    direct_call,
                    scan,
                    required_ids,
                    required_identifiers,
                    required_clauses,
                    expected_statement_kind,
                )
        _update_assignment(statement, scan, required_ids)
        if isinstance(statement, (ast.Return, ast.Raise)):
            terminated = True
    return scan


def _is_allowed_typing_any_import(node: ast.AST, *, required: bool) -> bool:
    return bool(
        required
        and isinstance(node, ast.ImportFrom)
        and node.level == 0
        and node.module == "typing"
        and len(node.names) == 1
        and node.names[0].name == "Any"
        and node.names[0].asname is None
    )


def _has_forbidden_python_operation(
    tree: ast.AST,
    *,
    allow_typing_any_import: bool = False,
) -> bool:
    forbidden_calls = {"__import__", "compile", "eval", "exec"}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)) and not _is_allowed_typing_any_import(
            node,
            required=allow_typing_any_import,
        ):
            return True
        if (
            isinstance(node, ast.Name)
            and isinstance(node.ctx, ast.Load)
            and node.id in forbidden_calls
        ):
            return True
        if isinstance(node, ast.Attribute) and node.attr in forbidden_calls | {"import_module"}:
            return True
        if not isinstance(node, ast.Call):
            continue
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "getattr"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value in forbidden_calls | {"import_module"}
        ):
            return True
        dotted = _dotted_name(node.func)
        if dotted is None:
            continue
        tail = dotted.rsplit(".", 1)[-1]
        if tail in forbidden_calls or tail == "import_module":
            return True
    return False


def _safe_default_expression(expression: ast.expr) -> bool:
    if isinstance(expression, ast.Constant):
        return isinstance(expression.value, (str, bytes, int, float, complex, bool, type(None)))
    return bool(
        isinstance(expression, ast.UnaryOp)
        and isinstance(expression.op, _SAFE_DEFAULT_UNARY_OPERATORS)
        and isinstance(expression.operand, ast.Constant)
        and isinstance(expression.operand.value, (int, float, complex))
    )


def _safe_annotation_expression(expression: ast.expr) -> bool:
    if isinstance(expression, ast.Constant):
        return expression.value is None or isinstance(expression.value, str)
    if isinstance(expression, ast.Name):
        return expression.id in _SAFE_ANNOTATION_NAMES
    if isinstance(expression, ast.Subscript):
        return bool(
            isinstance(expression.value, ast.Name)
            and expression.value.id in _SAFE_ANNOTATION_NAMES
            and _safe_annotation_expression(expression.slice)
        )
    if isinstance(expression, ast.Tuple):
        return bool(expression.elts) and all(
            _safe_annotation_expression(element) for element in expression.elts
        )
    return bool(
        isinstance(expression, ast.BinOp)
        and isinstance(expression.op, ast.BitOr)
        and _safe_annotation_expression(expression.left)
        and _safe_annotation_expression(expression.right)
    )


def _function_definition_is_safe(function: _FunctionNode) -> bool:
    if function.decorator_list:
        return False
    defaults = [
        *function.args.defaults,
        *(default for default in function.args.kw_defaults if default is not None),
    ]
    annotations: list[ast.expr] = [
        *(argument.annotation for argument in function.args.posonlyargs if argument.annotation),
        *(argument.annotation for argument in function.args.args if argument.annotation),
        *(argument.annotation for argument in function.args.kwonlyargs if argument.annotation),
    ]
    if function.args.vararg is not None and function.args.vararg.annotation is not None:
        annotations.append(function.args.vararg.annotation)
    if function.args.kwarg is not None and function.args.kwarg.annotation is not None:
        annotations.append(function.args.kwarg.annotation)
    if function.returns is not None:
        annotations.append(function.returns)
    return all(_safe_default_expression(default) for default in defaults) and all(
        _safe_annotation_expression(annotation) for annotation in annotations
    )


def _has_nested_definition(function: _FunctionNode) -> bool:
    return any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda))
        for statement in function.body
        for node in ast.walk(statement)
    )


def _has_top_level_scaffolding(
    tree: ast.Module,
    target: _FunctionNode | None,
    *,
    allow_helper: bool,
    allow_typing_any_import: bool = False,
) -> bool:
    if target is None or _has_nested_definition(target):
        return True
    functions = [
        node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    allowed_imports = sum(
        _is_allowed_typing_any_import(node, required=allow_typing_any_import) for node in tree.body
    )
    if (
        len(functions) + allowed_imports != len(tree.body)
        or sum(node is target for node in functions) != 1
    ):
        return True
    if len({function.name for function in functions}) != len(functions):
        return True
    if len(functions) > 1 and not allow_helper:
        return False
    if any(_has_nested_definition(function) for function in functions):
        return True
    return any(not _function_definition_is_safe(function) for function in functions)


def _has_disallowed_helper_layer(
    tree: ast.Module,
    target: _FunctionNode | None,
    *,
    allow_helper: bool,
) -> bool:
    if target is None or allow_helper:
        return False
    return any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and node is not target
        for node in tree.body
    )


def _has_json_layer(tree: ast.AST) -> bool:
    module_aliases = {"json", "orjson"}
    function_aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in {"json", "orjson"}:
                    module_aliases.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module in {"json", "orjson"}:
            for alias in node.names:
                if alias.name in {"dumps", "loads", "dump", "load"}:
                    function_aliases.add(alias.asname or alias.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            value = node.value
            if not (
                isinstance(value, ast.Call)
                and value.args
                and isinstance(value.args[0], ast.Constant)
                and value.args[0].value in {"json", "orjson"}
            ):
                continue
            dotted = _dotted_name(value.func)
            if dotted not in {"__import__", "importlib.import_module"}:
                continue
            for name in _assigned_names(node):
                module_aliases.add(name)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if (
            isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in module_aliases
            and node.func.attr in {"dumps", "loads", "dump", "load"}
        ) or (isinstance(node.func, ast.Name) and node.func.id in function_aliases):
            return True
    return False


def _python_comment_issues(code: str) -> tuple[bool, bool]:
    lines = code.splitlines()
    comments_by_line: dict[int, tokenize.TokenInfo] = {}
    try:
        for token in tokenize.generate_tokens(io.StringIO(code).readline):
            if token.type == tokenize.COMMENT:
                comments_by_line[token.start[0]] = token
    except (IndentationError, tokenize.TokenError):
        return False, True
    inline = False
    missing = False
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        comment = comments_by_line.get(line_number)
        if comment is not None and line[: comment.start[1]].strip():
            inline = True
        next_line = lines[line_number].strip() if line_number < len(lines) else ""
        if not next_line.startswith("#") or not _RUSSIAN_RE.search(next_line):
            missing = True
    return inline, missing


def _sql_comment_index(line: str) -> int | None:
    index = 0
    while index < len(line) - 1:
        char = line[index]
        next_char = line[index + 1]
        if char == "/" and next_char == "*":
            closing = line.find("*/", index + 2)
            if closing < 0:
                return None
            index = closing + 2
            continue
        if char == "$":
            tag_match = re.match(r"\$[A-Za-z_]*\$", line[index:])
            if tag_match:
                tag = tag_match.group(0)
                closing = line.find(tag, index + len(tag))
                if closing < 0:
                    return None
                index = closing + len(tag)
                continue
        if char in {"'", '"', "`", "["}:
            closing_char = "]" if char == "[" else char
            quoted = _quoted_sql_token(line, index, char, closing_char)
            if quoted is None:
                return None
            _, index = quoted
            continue
        if char == "-" and next_char == "-":
            return index
        index += 1
    return None


def _sql_comment_issues(code: str) -> tuple[bool, bool]:
    lines = code.splitlines()
    inline = False
    missing = False
    for index, line in enumerate(lines):
        comment_index = _sql_comment_index(line)
        before_comment = line[:comment_index] if comment_index is not None else line
        if not before_comment.strip():
            continue
        if comment_index is not None:
            inline = True
        next_line = lines[index + 1].strip() if index + 1 < len(lines) else ""
        if not next_line.startswith("--") or not _RUSSIAN_RE.search(next_line):
            missing = True
    return inline, missing


def _append_language_issues(
    issues: list[ScreenAnswerIssue],
    *,
    intro: str,
    code: str,
    language: Literal["python", "sql"],
    require_intro: bool,
    require_comments: bool,
) -> None:
    if require_intro and not _RUSSIAN_RE.search(intro):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.RUSSIAN_INTRO_MISSING))
    if not require_comments:
        return
    inline, missing = (
        _python_comment_issues(code) if language == "python" else _sql_comment_issues(code)
    )
    if inline:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.INLINE_CODE_COMMENT))
    if missing:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.RUSSIAN_LINE_COMMENT_MISSING))


def _append_coverage_issues(
    issues: list[ScreenAnswerIssue],
    requirements: tuple[StableCoverageRequirement, ...],
    facts: _StructuralFacts,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    covered: list[str] = []
    missing: list[str] = []
    for requirement in requirements:
        if _requirement_is_covered(requirement, facts):
            covered.append(requirement.stable_id)
        else:
            missing.append(requirement.stable_id)
            issues.append(
                ScreenAnswerIssue(
                    ScreenAnswerIssueCode.REQUIRED_COVERAGE_MISSING,
                    stable_id=requirement.stable_id,
                )
            )
    return tuple(covered), tuple(missing)


def _validate_sql_answer(
    data: ScreenAnswerValidationInput,
    *,
    intro: str,
    code: str,
) -> ScreenAnswerValidationResult:
    issues: list[ScreenAnswerIssue] = []
    tokens = _lex_sql(code)
    if tokens is None:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_LEX_INVALID))
        facts = None
    else:
        facts = _sql_facts(tokens)
        safety_issue = _sql_safety_issue(tokens)
        if safety_issue is not None:
            issues.append(ScreenAnswerIssue(safety_issue))
        if facts is None:
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_STATEMENT_COUNT_INVALID))
        elif facts.statement_kind not in _SQL_STATEMENT_KINDS:
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_FORBIDDEN_STATEMENT))
        elif facts.statement_kind != data.expected_sql_statement_kind:
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_STATEMENT_KIND_MISMATCH))
        if not _sql_shape_is_valid(tokens):
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_SYNTAX_INVALID))

    if not (
        _pure_sql_placeholders_match(code, data.required_sql_bound_ids)
        and (
            data.expected_sql_statement_kind != "select"
            or _required_select_predicate_binding_matches(
                code,
                data.required_sql_bound_ids,
                data.required_sql_identifiers,
                data.required_sql_clauses,
            )
        )
    ):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_BINDING_MISSING))

    structural = _sql_structural_facts(facts) if facts is not None else _StructuralFacts()
    covered, missing = _append_coverage_issues(issues, data.stable_requirements, structural)
    if facts is not None:
        if any(
            identifier.casefold() not in facts.identifiers
            for identifier in data.required_sql_identifiers
        ):
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_IDENTIFIER_MISSING))
        if any(clause.casefold() not in facts.clauses for clause in data.required_sql_clauses):
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_CLAUSE_MISSING))
        if any(literal not in facts.literals for literal in data.visible_literals):
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.VISIBLE_LITERAL_MISSING))
        if facts.has_join and not data.allow_join:
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.UNREQUIRED_JOIN))
        if facts.has_cte and not data.allow_cte:
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.UNREQUIRED_CTE))
        if facts.has_json and not data.allow_json:
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER))
    elif data.required_sql_identifiers:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_IDENTIFIER_MISSING))
    if facts is None and data.required_sql_clauses:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_CLAUSE_MISSING))
    if facts is None and data.visible_literals:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.VISIBLE_LITERAL_MISSING))

    _append_language_issues(
        issues,
        intro=intro,
        code=code,
        language="sql",
        require_intro=data.require_russian_intro,
        require_comments=data.require_russian_line_comments,
    )
    return _result(issues, covered=covered, missing=missing)


def validate_screen_answer(data: ScreenAnswerValidationInput) -> ScreenAnswerValidationResult:
    """Validate one answer deterministically without running candidate code."""
    if not _input_is_bounded(data):
        return _result([ScreenAnswerIssue(ScreenAnswerIssueCode.INPUT_TOO_LARGE)])
    if not _input_is_valid(data):
        return _result([ScreenAnswerIssue(ScreenAnswerIssueCode.INVALID_INPUT)])
    fenced = _extract_fenced_code(data.answer, expected_language=data.code_language)
    if isinstance(fenced, ScreenAnswerIssueCode):
        return _result([ScreenAnswerIssue(fenced)])
    intro, code = fenced
    if data.code_language == "sql":
        return _validate_sql_answer(data, intro=intro, code=code)
    if data.python_shape != "function":
        profile_issues = [ScreenAnswerIssue(ScreenAnswerIssueCode.PYTHON_PROFILE_UNSUPPORTED)]
        _append_language_issues(
            profile_issues,
            intro=intro,
            code=code,
            language="python",
            require_intro=data.require_russian_intro,
            require_comments=data.require_russian_line_comments,
        )
        return _result(profile_issues)
    if data.visible_public_signature is None:
        target_issues = [ScreenAnswerIssue(ScreenAnswerIssueCode.PYTHON_TARGET_REQUIRED)]
        _append_language_issues(
            target_issues,
            intro=intro,
            code=code,
            language="python",
            require_intro=data.require_russian_intro,
            require_comments=data.require_russian_line_comments,
        )
        return _result(target_issues)
    try:
        tree = ast.parse(code, mode="exec")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return _result([ScreenAnswerIssue(ScreenAnswerIssueCode.PYTHON_SYNTAX_INVALID)])

    expected = _parse_expected_function(data.visible_public_signature)
    if data.visible_public_signature and expected is None:
        return _result([ScreenAnswerIssue(ScreenAnswerIssueCode.INVALID_INPUT)])
    target = _target_function(tree, expected)
    issues: list[ScreenAnswerIssue] = []
    allow_typing_any_import = bool(
        expected is not None
        and any(isinstance(node, ast.Name) and node.id == "Any" for node in ast.walk(expected))
    )
    if _has_forbidden_python_operation(
        tree,
        allow_typing_any_import=allow_typing_any_import,
    ):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.PYTHON_FORBIDDEN_OPERATION))
    if _has_top_level_scaffolding(
        tree,
        target,
        allow_helper=data.allow_helper,
        allow_typing_any_import=allow_typing_any_import,
    ):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.PYTHON_TOP_LEVEL_SCAFFOLDING))
    if target is None:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.PYTHON_TARGET_REQUIRED))
        structural = _StructuralFacts()
    else:
        _, effective_statements = _effective_source(code, target)
        structural = _python_structural_facts(target, effective_statements)
    covered, missing = _append_coverage_issues(issues, data.stable_requirements, structural)
    if expected is not None and (target is None or not _signature_matches(target, expected)):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.PUBLIC_SIGNATURE_MISSING))
    if any(literal not in structural.literals for literal in data.visible_literals):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.VISIBLE_LITERAL_MISSING))

    if _has_disallowed_helper_layer(tree, target, allow_helper=data.allow_helper):
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.EXTRA_TOP_LEVEL_LAYER))
    if "with" in structural.sql_clauses and not data.allow_cte:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.UNREQUIRED_CTE))
    if "join" in structural.sql_clauses and not data.allow_join:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.UNREQUIRED_JOIN))
    if _has_json_layer(tree) and not data.allow_json:
        issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER))

    all_execute_calls = _execute_calls(tree)
    needs_sql_validation = bool(
        all_execute_calls
        or data.required_sql_bound_ids
        or data.required_sql_identifiers
        or data.required_sql_clauses
        or data.expected_sql_statement_kind is not None
    )
    if needs_sql_validation:
        expected_statement_kind = data.expected_sql_statement_kind or "select"
        scan = (
            _scan_target(
                tree,
                target,
                configured_receivers=data.trusted_sql_receivers,
                required_ids=data.required_sql_bound_ids,
                required_identifiers=data.required_sql_identifiers,
                required_clauses=data.required_sql_clauses,
                expected_statement_kind=expected_statement_kind,
            )
            if target is not None
            else None
        )
        if scan is None:
            if all_execute_calls:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_EXECUTE_OUTSIDE_TARGET))
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_EXECUTE_COUNT_INVALID))
            issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_BINDING_MISSING))
        else:
            outside_ids = (
                {id(call) for call in all_execute_calls}
                - scan.reachable_call_ids
                - scan.rejected_inside_ids
            )
            if scan.unsafe_interpolation:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_INTERPOLATION_UNSAFE))
            if scan.untrusted_receiver:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_RECEIVER_UNTRUSTED))
            if scan.unsafe_dataflow:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE))
            issues.extend(ScreenAnswerIssue(code) for code in scan.sql_issue_codes)
            if len(scan.reachable_calls) != 1:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_EXECUTE_COUNT_INVALID))
            if scan.rejected_inside_ids:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_EXECUTE_UNREACHABLE))
            if outside_ids:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_EXECUTE_OUTSIDE_TARGET))
            if not scan.has_valid_binding or len(scan.reachable_calls) != 1:
                issues.append(ScreenAnswerIssue(ScreenAnswerIssueCode.SQL_BINDING_MISSING))

    _append_language_issues(
        issues,
        intro=intro,
        code=code,
        language="python",
        require_intro=data.require_russian_intro,
        require_comments=data.require_russian_line_comments,
    )
    return _result(issues, covered=covered, missing=missing)
