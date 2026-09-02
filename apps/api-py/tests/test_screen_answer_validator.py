from __future__ import annotations

from dataclasses import replace

from app.services.screen_answer_validator import (
    ScreenAnswerIssueCode,
    ScreenAnswerValidationInput,
    StableCoverageRequirement,
    validate_screen_answer,
)


def _minimal_answer(*, body: str | None = None) -> str:
    code = (
        body
        or """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""
    )
    return (
        "Сначала выполню один параметризованный запрос, затем верну найденные строки.\n\n"
        f"```python\n{code}\n```"
    )


def _input(answer: str, **overrides: object) -> ScreenAnswerValidationInput:
    values: dict[str, object] = {
        "answer": answer,
        "stable_requirements": (
            StableCoverageRequirement(
                stable_id="public-contract",
                function_signatures=("def load(conn, order_id):",),
            ),
            StableCoverageRequirement(
                stable_id="data-source",
                python_calls=("rows.fetchall",),
                identifiers=("orders",),
            ),
        ),
        "visible_public_signature": "def load(conn, order_id):",
        "visible_literals": ("SELECT id FROM orders WHERE id = ?",),
        "simplify": True,
        "allow_join": False,
        "allow_cte": False,
        "allow_json": False,
        "allow_helper": False,
        "required_sql_bound_ids": ("order_id",),
        "trusted_sql_receivers": ("conn", "cursor"),
        "require_russian_intro": True,
        "require_russian_line_comments": True,
    }
    values.update(overrides)
    return ScreenAnswerValidationInput(**values)


def _codes(answer: str, **overrides: object) -> tuple[ScreenAnswerIssueCode, ...]:
    return validate_screen_answer(_input(answer, **overrides)).issue_codes


_TYPED_ORDER_SIGNATURE = "def get_order(conn, order_id: int) -> list[dict[str, Any]]:"
_TYPED_ORDER_QUERY = 'SELECT * FROM "Order" WHERE id = ?'


def _typed_order_answer(body: str) -> str:
    return f"""Сначала выполню один параметризованный запрос и преобразую строки в словари.

```python
{_TYPED_ORDER_SIGNATURE}
{body}
```"""


def _typed_order_input(
    answer: str,
    *,
    require_language_guidance: bool = False,
) -> ScreenAnswerValidationInput:
    return ScreenAnswerValidationInput(
        answer=answer,
        visible_public_signature=_TYPED_ORDER_SIGNATURE,
        required_sql_bound_ids=("order_id",),
        trusted_sql_receivers=("conn",),
        require_russian_intro=require_language_guidance,
        require_russian_line_comments=require_language_guidance,
        code_language="python",
        python_shape="function",
        expected_sql_statement_kind="select",
        required_sql_identifiers=("Order", "id"),
        required_sql_clauses=("select", "from", "where"),
    )


def test_accepts_terminal_dict_conversion_of_one_trusted_bound_select_result() -> None:
    answer = _typed_order_answer(
        f"""    # Сохраняю точную публичную сигнатуру.
    rows = conn.execute('{_TYPED_ORDER_QUERY}', (order_id,))
    # Передаю идентификатор отдельно от SQL.
    return [dict(row) for row in rows]
    # Преобразую каждую найденную строку в словарь."""
    )

    result = validate_screen_answer(_typed_order_input(answer, require_language_guidance=True))

    assert result.valid is True, result.issue_codes
    assert result.issue_codes == ()


def test_accepts_only_the_typing_any_import_required_by_the_visible_signature() -> None:
    body = f"""from typing import Any
# Сохраняю видимую аннотацию результата.

{_TYPED_ORDER_SIGNATURE}
    # Сохраняю точную публичную сигнатуру.
    rows = conn.execute('{_TYPED_ORDER_QUERY}', (order_id,))
    # Передаю идентификатор отдельно от SQL.
    return [dict(row) for row in rows]
    # Преобразую каждую найденную строку в словарь."""
    answer = f"""Сначала выполню один параметризованный запрос и преобразую строки в словари.

```python
{body}
```"""
    accepted = validate_screen_answer(_typed_order_input(answer, require_language_guidance=True))

    assert accepted.valid is True, accepted.issue_codes

    for forbidden_import in (
        "import typing",
        "from typing import Any as Anything",
        "from typing import Any, cast",
        "from pathlib import Path",
    ):
        candidate = body.replace("from typing import Any", forbidden_import)
        candidate_answer = answer.replace(body, candidate)
        codes = validate_screen_answer(
            _typed_order_input(candidate_answer, require_language_guidance=True)
        ).issue_codes
        assert ScreenAnswerIssueCode.PYTHON_FORBIDDEN_OPERATION in codes, forbidden_import


def test_terminal_dict_conversion_allowance_fails_closed_on_nearby_shapes() -> None:
    query = f"rows = conn.execute('{_TYPED_ORDER_QUERY}', (order_id,))"
    cases = (
        (
            "general comprehension",
            f"    {query}\n    return [row for row in rows]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "filtered comprehension",
            f"    {query}\n    return [dict(row) for row in rows if row]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "wrong iterable",
            f"    {query}\n    return [dict(row) for row in other_rows]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "execute embedded in iterable",
            f"    return [dict(row) for row in conn.execute('{_TYPED_ORDER_QUERY}', (order_id,))]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "wrong constructor",
            f"    {query}\n    return [list(row) for row in rows]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "nested conversion call",
            f"    {query}\n    return [dict(transform(row)) for row in rows]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "extra standalone call",
            f"    {query}\n    audit()\n    return [dict(row) for row in rows]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "result rebinding",
            f"    {query}\n    rows = other_rows\n    return [dict(row) for row in rows]",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "interpolated query",
            "    rows = conn.execute(f'SELECT * FROM \"Order\" WHERE id = {order_id}')\n"
            "    return [dict(row) for row in rows]",
            ScreenAnswerIssueCode.SQL_INTERPOLATION_UNSAFE,
        ),
        (
            "wrong parameter binding",
            f"    rows = conn.execute('{_TYPED_ORDER_QUERY}', (wrong_id,))\n"
            "    return [dict(row) for row in rows]",
            ScreenAnswerIssueCode.SQL_BINDING_MISSING,
        ),
        (
            "nonterminal conversion",
            f"    {query}\n    converted = [dict(row) for row in rows]\n    return converted",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "unreachable trailing statement",
            f"    {query}\n    return [dict(row) for row in rows]\n    audit()",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
        (
            "unreachable trailing string decoy",
            f"    {query}\n    return [dict(row) for row in rows]\n    'unreachable decoy'",
            ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE,
        ),
    )
    for label, body, expected_issue in cases:
        result = validate_screen_answer(_typed_order_input(_typed_order_answer(body)))

        assert result.valid is False, label
        assert expected_issue in result.issue_codes, (label, result.issue_codes)


def test_terminal_dict_conversion_rejects_every_builtin_dict_shadowing_scope() -> None:
    query = f"conn.execute('{_TYPED_ORDER_QUERY}', (order_id,))"
    canonical = _typed_order_answer(f"    rows = {query}\n    return [dict(row) for row in rows]")
    cases = (
        _typed_order_answer(f"    dict = {query}\n    return [dict(row) for row in dict]"),
        _typed_order_answer(f"    rows = {query}\n    return [dict(dict) for dict in rows]"),
        canonical.replace(
            "```python\n",
            "```python\ndef dict(value):\n    return value\n\n",
            1,
        ),
    )
    for answer in cases:
        result = validate_screen_answer(replace(_typed_order_input(answer), allow_helper=True))

        assert result.valid is False
        assert ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE in result.issue_codes


def test_embedded_select_binds_required_id_only_in_exact_required_predicate() -> None:
    unsafe_queries = (
        'SELECT ? FROM "Order" WHERE id = id',
        'SELECT * FROM "Order" WHERE id = id ORDER BY ?',
        'SELECT * FROM "Order" WHERE id = ? OR 1 = 1',
        'SELECT * FROM "Order" WHERE id = ? UNION SELECT * FROM "Order" WHERE id = id',
        'SELECT "Order", id FROM other WHERE id = ?',
        'SELECT id FROM "Order" WHERE other = ?',
    )
    for query in unsafe_queries:
        answer = _typed_order_answer(
            f"    rows = conn.execute({query!r}, (order_id,))\n"
            "    return [dict(row) for row in rows]"
        )
        result = validate_screen_answer(_typed_order_input(answer))

        assert result.valid is False, query
        assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in result.issue_codes, query


def test_pure_select_binds_required_id_only_in_exact_required_predicate() -> None:
    unsafe_queries = (
        'SELECT ? FROM "Order" WHERE id = id',
        'SELECT * FROM "Order" WHERE id = id ORDER BY ?',
        'SELECT * FROM "Order" WHERE id = ? OR 1 = 1',
        'SELECT * FROM "Order" WHERE id = ? UNION SELECT * FROM "Order" WHERE id = id',
    )
    for query in unsafe_queries:
        result = validate_screen_answer(
            ScreenAnswerValidationInput(
                answer=f"Проверю один запрос.\n\n```sql\n{query}\n```",
                code_language="sql",
                expected_sql_statement_kind="select",
                required_sql_bound_ids=("order_id",),
                required_sql_identifiers=("Order", "id"),
                required_sql_clauses=("select", "from", "where"),
            )
        )

        assert result.valid is False, query
        assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in result.issue_codes, query


def test_accepts_minimal_parameterized_answer_with_complete_contract() -> None:
    result = validate_screen_answer(_input(_minimal_answer()))

    assert result.valid is True
    assert result.issue_codes == ()
    assert result.covered_stable_ids == ("public-contract", "data-source")


def test_reports_stable_id_when_required_code_evidence_is_missing() -> None:
    result = validate_screen_answer(
        _input(
            _minimal_answer(),
            stable_requirements=(
                StableCoverageRequirement(
                    stable_id="missing-behaviour",
                    python_calls=("conn.commit",),
                ),
            ),
        )
    )

    assert result.valid is False
    assert result.issue_codes == (ScreenAnswerIssueCode.REQUIRED_COVERAGE_MISSING,)
    assert result.missing_stable_ids == ("missing-behaviour",)


def test_requires_exact_visible_signature_and_literals_in_executable_code() -> None:
    body = """def load(connection, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = connection.execute("SELECT id FROM invoices WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(
        _minimal_answer(body=body),
        stable_requirements=(),
        trusted_sql_receivers=("connection",),
    )

    assert codes == (
        ScreenAnswerIssueCode.PUBLIC_SIGNATURE_MISSING,
        ScreenAnswerIssueCode.VISIBLE_LITERAL_MISSING,
    )


def test_does_not_accept_contract_text_hidden_in_a_comment_or_spoken_intro() -> None:
    body = """def other(conn, order_id):
    # Требование def load(conn, order_id): здесь только процитировано.
    rows = conn.execute("SELECT id FROM invoices WHERE id = ?", (order_id,))
    # Строка SELECT id FROM orders WHERE id = ? здесь только процитирована.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body), stable_requirements=())

    assert ScreenAnswerIssueCode.PUBLIC_SIGNATURE_MISSING in codes
    assert ScreenAnswerIssueCode.VISIBLE_LITERAL_MISSING in codes


def test_compares_public_signature_from_function_ast_not_source_spacing() -> None:
    body = """def   load( conn , order_id ):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    result = validate_screen_answer(_input(_minimal_answer(body=body)))

    assert result.valid is True


def test_coverage_ignores_docstrings_and_unused_string_assignments() -> None:
    body = '''def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    """FROM orders and rows.fetchall() are only quoted here."""
    note = "FROM orders and rows.fetchall() are still unused"
    # Сохраняю неиспользуемую строку, которая не реализует требование.
    return conn.execute("SELECT 1 WHERE id = ?", (order_id,))
    # Выполняю другой запрос с отдельным параметром.'''

    result = validate_screen_answer(
        _input(
            _minimal_answer(body=body),
            visible_literals=(),
            require_russian_line_comments=False,
        )
    )

    assert result.missing_stable_ids == ("data-source",)
    assert ScreenAnswerIssueCode.REQUIRED_COVERAGE_MISSING in result.issue_codes


def test_rejects_unbalanced_or_multiple_code_fences() -> None:
    unbalanced = _minimal_answer().removesuffix("```")
    multiple = _minimal_answer() + "\n\n```python\nvalue = 1\n# Сохраняю значение.\n```"

    assert _codes(unbalanced) == (ScreenAnswerIssueCode.CODE_FENCE_UNBALANCED,)
    assert _codes(multiple) == (ScreenAnswerIssueCode.CODE_FENCE_COUNT,)


def test_rejects_a_language_marker_on_the_closing_fence() -> None:
    malformed = _minimal_answer().removesuffix("```") + "```python"

    assert _codes(malformed) == (ScreenAnswerIssueCode.CODE_FENCE_UNBALANCED,)


def test_rejects_python_that_does_not_parse_without_executing_it() -> None:
    body = """def load(conn, order_id)
    # Принимаю соединение и идентификатор заказа.
    raise RuntimeError("this must never execute")
    # Оставляю опасный код только как синтаксический пример."""

    assert _codes(
        _minimal_answer(body=body),
        stable_requirements=(),
        visible_literals=(),
        required_sql_bound_ids=(),
    ) == (ScreenAnswerIssueCode.PYTHON_SYNTAX_INVALID,)


def test_simplify_mode_rejects_extra_top_level_definition() -> None:
    body = """def helper(value):
    # Добавляю лишний вспомогательный слой.
    return value
    # Возвращаю значение без изменения.

def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body))

    assert ScreenAnswerIssueCode.EXTRA_TOP_LEVEL_LAYER in codes


def test_simplify_mode_rejects_unrequested_query_and_serialization_layers() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    query = "WITH picked AS (SELECT id FROM orders) SELECT * FROM picked JOIN users ON users.id = picked.id WHERE picked.id = ?"
    # Создаю избыточный запрос с несколькими слоями.
    rows = conn.execute(query, (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return json.dumps(rows.fetchall())
    # Добавляю избыточную сериализацию результата."""

    codes = _codes(
        _minimal_answer(body=body),
        visible_literals=(),
        stable_requirements=(),
    )

    assert ScreenAnswerIssueCode.UNREQUIRED_CTE in codes
    assert ScreenAnswerIssueCode.UNREQUIRED_JOIN in codes
    assert ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER in codes


def test_simplify_mode_allows_a_layer_explicitly_named_by_requirements() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT orders.id FROM orders JOIN users ON users.id = orders.user_id WHERE orders.id = ?", (order_id,))
    # Соединяю таблицы по явному требованию и передаю параметр отдельно.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    result = validate_screen_answer(
        _input(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_literals=(),
            allow_join=True,
        )
    )

    assert result.valid is True


def test_denial_text_cannot_enable_a_disallowed_layer() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT orders.id FROM orders JOIN users ON users.id = orders.user_id WHERE orders.id = ?", (order_id,))
    # Добавляю соединение, хотя текст требования его запрещает.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(
        _minimal_answer(body=body),
        stable_requirements=(
            StableCoverageRequirement(
                stable_id="denial",
                identifiers=("users",),
            ),
        ),
        visible_literals=(),
        allow_join=False,
    )

    assert ScreenAnswerIssueCode.UNREQUIRED_JOIN in codes


def test_detects_json_layer_through_an_import_alias() -> None:
    body = """import json as codec
# Подключаю модуль сериализации через псевдоним.

def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return codec.dumps(rows.fetchall())
    # Сериализую результат в JSON."""

    codes = _codes(
        _minimal_answer(body=body),
        stable_requirements=(),
        visible_literals=(),
    )

    assert ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER in codes


def test_rejects_interpolated_sql_even_when_the_identifier_is_named() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute(f"SELECT id FROM orders WHERE id = {order_id}")
    # Подставляю идентификатор прямо в текст запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body), visible_literals=())

    assert ScreenAnswerIssueCode.SQL_INTERPOLATION_UNSAFE in codes
    assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in codes


def test_requires_placeholder_and_separate_bound_identifier() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?")
    # Выполняю запрос без отдельного набора параметров.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body))

    assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in codes


def test_accepts_exact_supported_placeholder_and_binding_shapes() -> None:
    cases = (
        ('"SELECT id FROM orders WHERE id = %s", [order_id]',),
        ('"SELECT id FROM orders WHERE id = :order_id", {"order_id": order_id}',),
        ('"SELECT id FROM orders WHERE id = %(order_id)s", {"order_id": order_id}',),
        ('"SELECT id FROM orders WHERE id = $1", (order_id,)',),
    )
    for (execute_arguments,) in cases:
        body = f"""def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute({execute_arguments})
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

        result = validate_screen_answer(
            _input(
                _minimal_answer(body=body),
                stable_requirements=(),
                visible_literals=(),
            )
        )

        assert result.valid is True, execute_arguments


def test_rejects_scalar_wrong_mapping_and_placeholder_inside_sql_literal() -> None:
    cases = (
        '"SELECT id FROM orders WHERE id = ?", order_id',
        '"SELECT id FROM orders WHERE id = :order_id", {"wrong": order_id}',
        "\"SELECT '?' AS marker\", (order_id,)",
    )
    for execute_arguments in cases:
        body = f"""def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute({execute_arguments})
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

        codes = _codes(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_literals=(),
        )

        assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in codes, execute_arguments


def test_accepts_cursor_created_from_trusted_connection() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    cursor = conn.cursor()
    # Создаю курсор из доверенного соединения.
    cursor.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return cursor.fetchall()
    # Возвращаю найденные строки."""

    result = validate_screen_answer(_input(_minimal_answer(body=body), stable_requirements=()))

    assert result.valid is True


def test_accepts_arbitrarily_named_cursor_created_from_trusted_connection() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    cur = conn.cursor()
    # Создаю курсор из доверенного соединения.
    cur.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return cur.fetchall()
    # Возвращаю найденные строки."""

    result = validate_screen_answer(_input(_minimal_answer(body=body), stable_requirements=()))

    assert result.valid is True


def test_rejects_shadowed_trusted_receiver_and_string_adversary() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    conn = make_client()
    # Подменяю доверенное соединение неизвестным объектом.
    note = "conn.execute('SELECT id FROM orders WHERE id = ?', (order_id,))"
    # Сохраняю вызов только как строку, а не выполняю его.
    return conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Вызываю метод на подменённом объекте."""

    codes = _codes(_minimal_answer(body=body))

    assert ScreenAnswerIssueCode.SQL_RECEIVER_UNTRUSTED in codes
    assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in codes


def test_rejects_cursor_shadowed_by_untrusted_factory() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    cursor = make_client().cursor()
    # Создаю курсор из неизвестного объекта.
    cursor.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Передаю идентификатор отдельно от текста запроса.
    return cursor.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body))

    assert ScreenAnswerIssueCode.SQL_RECEIVER_UNTRUSTED in codes
    assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in codes


def test_rejects_multiple_reachable_execute_calls() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Выполняю первый запрос.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Выполняю второй запрос.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body), stable_requirements=())

    assert ScreenAnswerIssueCode.SQL_EXECUTE_COUNT_INVALID in codes


def test_rejects_execute_after_return_or_inside_never_called_nested_function() -> None:
    after_return = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    return []
    # Завершаю функцию до запроса.
    conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Этот запрос недостижим."""
    nested = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    def hidden():
        # Объявляю функцию, которая не вызывается.
        return conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
        # Прячу запрос во вложенной функции.
    return []
    # Возвращаю пустой результат."""

    for body in (after_return, nested):
        codes = _codes(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_literals=(),
            simplify=False,
        )

        assert ScreenAnswerIssueCode.SQL_EXECUTE_UNREACHABLE in codes
        assert ScreenAnswerIssueCode.SQL_BINDING_MISSING in codes


def test_rejects_additional_execute_outside_target_or_on_untrusted_receiver() -> None:
    body = """def other(conn, order_id):
    # Объявляю дополнительную функцию.
    return conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Выполняю запрос вне целевой функции.

def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Выполняю целевой запрос.
    logger.execute("SELECT 1")
    # Добавляю вызов на недоверенном объекте.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(
        _minimal_answer(body=body),
        stable_requirements=(),
        simplify=False,
    )

    assert ScreenAnswerIssueCode.SQL_EXECUTE_OUTSIDE_TARGET in codes
    assert ScreenAnswerIssueCode.SQL_RECEIVER_UNTRUSTED in codes
    assert ScreenAnswerIssueCode.SQL_EXECUTE_COUNT_INVALID in codes


def test_rejects_protected_identifier_or_receiver_shadowing_and_control_flow() -> None:
    cases = (
        "order_id = replacement",
        "conn: object = replacement",
        "order_id += 1",
        'if ready:\n        conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))',
    )
    for unsafe_statement in cases:
        body = f"""def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    {unsafe_statement}
    # Вношу небезопасное изменение в поток данных.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Выполняю запрос после неоднозначного изменения.
    return rows.fetchall()
    # Возвращаю найденные строки."""

        codes = _codes(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_literals=(),
            require_russian_line_comments=False,
        )

        assert ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE in codes, unsafe_statement


def test_requires_russian_spoken_intro() -> None:
    answer = _minimal_answer().replace(
        "Сначала выполню один параметризованный запрос, затем верну найденные строки.",
        "Run one parameterized query and return the rows.",
    )

    assert _codes(answer) == (ScreenAnswerIssueCode.RUSSIAN_INTRO_MISSING,)


def test_requires_russian_comment_immediately_below_each_code_line() -> None:
    body = """def load(conn, order_id):  # Принимаю параметры.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))

    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Return the rows."""

    codes = _codes(_minimal_answer(body=body))

    assert ScreenAnswerIssueCode.INLINE_CODE_COMMENT in codes
    assert ScreenAnswerIssueCode.RUSSIAN_LINE_COMMENT_MISSING in codes


def test_detects_an_inline_comment_on_an_indented_code_line() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))  # Плохо.
    # Передаю идентификатор отдельно от текста запроса.
    return rows.fetchall()
    # Возвращаю найденные строки."""

    codes = _codes(_minimal_answer(body=body))

    assert ScreenAnswerIssueCode.INLINE_CODE_COMMENT in codes


def test_sql_mode_accepts_one_bounded_select_with_russian_dash_comments() -> None:
    answer = """Сначала выберу строку по идентификатору.

```sql
SELECT id FROM records WHERE id = :record_id
-- Передаю идентификатор отдельно от текста запроса.
```"""

    result = validate_screen_answer(
        ScreenAnswerValidationInput(
            answer=answer,
            code_language="sql",
            expected_sql_statement_kind="select",
            required_sql_bound_ids=("record_id",),
            required_sql_identifiers=("records", "id"),
            required_sql_clauses=("select", "from", "where"),
            require_russian_intro=True,
            require_russian_line_comments=True,
        )
    )

    assert result.valid is True


def test_sql_mode_reports_missing_russian_dash_comment_without_parsing_sql() -> None:
    answer = """Сначала выберу строку по идентификатору.

```sql
SELECT id FROM records
-- Return the records.
```"""

    result = validate_screen_answer(
        ScreenAnswerValidationInput(
            answer=answer,
            code_language="sql",
            expected_sql_statement_kind="select",
            require_russian_intro=True,
            require_russian_line_comments=True,
        )
    )

    assert result.issue_codes == (ScreenAnswerIssueCode.RUSSIAN_LINE_COMMENT_MISSING,)


def test_python_requires_exactly_one_explicit_expected_target_function() -> None:
    no_expected = _input(
        _minimal_answer(),
        visible_public_signature=None,
        stable_requirements=(),
        visible_literals=(),
        required_sql_bound_ids=(),
    )
    extra_target = """Сначала верну переданное значение.

```python
def helper(value):
    # Принимаю значение во вспомогательной функции.
    return value
    # Возвращаю значение без изменения.

def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    return order_id
    # Возвращаю идентификатор заказа.
```"""

    assert validate_screen_answer(no_expected).issue_codes == (
        ScreenAnswerIssueCode.PYTHON_TARGET_REQUIRED,
    )
    assert validate_screen_answer(
        _input(
            extra_target,
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            allow_helper=True,
        )
    ).valid


def test_rejects_imports_dynamic_loading_and_code_execution_builtins() -> None:
    forbidden_lines = (
        "import os",
        "from os import path",
        'value = __import__("os")',
        'value = importlib.import_module("os")',
        'value = eval("1")',
        'value = exec("result = 1")',
        'value = compile("1", "candidate", "eval")',
        'runner = eval\n    value = runner("1")',
        'loader = __import__\n    value = loader("os")',
        'value = getattr(builtins, "eval")("1")',
    )
    for forbidden in forbidden_lines:
        body = f"""def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    {forbidden}
    # Выполняю запрещённую динамическую операцию.
    return order_id
    # Возвращаю идентификатор заказа."""

        codes = _codes(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            require_russian_line_comments=False,
        )

        assert ScreenAnswerIssueCode.PYTHON_FORBIDDEN_OPERATION in codes, forbidden


def test_rejects_top_level_executable_code_and_scaffolding() -> None:
    body = """setup()
# Запускаю лишнюю операцию на уровне модуля.

def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    return order_id
    # Возвращаю идентификатор заказа."""

    codes = _codes(
        _minimal_answer(body=body),
        stable_requirements=(),
        visible_literals=(),
        required_sql_bound_ids=(),
    )

    assert ScreenAnswerIssueCode.PYTHON_TOP_LEVEL_SCAFFOLDING in codes


def test_rejects_decorator_and_default_expression_that_execute_at_definition_time() -> None:
    cases = (
        "@register()\ndef load(conn, order_id):",
        "def load(conn=connect(), order_id=1):",
    )
    for header in cases:
        body = f"""{header}
    # Принимаю аргументы целевой функции.
    return order_id
    # Возвращаю идентификатор заказа."""

        codes = _codes(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_public_signature=header.splitlines()[-1].replace("connect()", "None"),
            visible_literals=(),
            required_sql_bound_ids=(),
            require_russian_line_comments=False,
        )

        assert ScreenAnswerIssueCode.PYTHON_TOP_LEVEL_SCAFFOLDING in codes, header


def test_structural_coverage_rejects_used_string_and_decoy_sql_literals() -> None:
    cases = (
        'print("orders")',
        'decoy = "SELECT id FROM orders WHERE id = ?"',
    )
    for decoy in cases:
        body = f"""def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    {decoy}
    # Упоминаю требование только в посторонней строке.
    return conn.execute("SELECT 1 WHERE 1 = ?", (order_id,))
    # Выполняю другой запрос.
"""
        result = validate_screen_answer(
            _input(
                _minimal_answer(body=body),
                stable_requirements=(
                    StableCoverageRequirement(
                        stable_id="real-source",
                        identifiers=("orders",),
                    ),
                ),
                visible_literals=(),
                require_russian_line_comments=False,
            )
        )

        assert result.missing_stable_ids == ("real-source",), decoy


def test_rejects_named_expression_and_container_mutation_in_sql_dataflow() -> None:
    unsafe_blocks = (
        "value = (order_id := replacement)",
        "params = [order_id]\n    params.append(replacement)",
        "params = [order_id]\n    params[0] = replacement",
    )
    for unsafe in unsafe_blocks:
        parameters = "params" if "params" in unsafe else "(order_id,)"
        body = f"""def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    {unsafe}
    # Изменяю защищённый поток данных.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", {parameters})
    # Выполняю запрос с параметром.
    return rows.fetchall()
    # Возвращаю найденные строки."""

        codes = _codes(
            _minimal_answer(body=body),
            stable_requirements=(),
            visible_literals=(),
            require_russian_line_comments=False,
        )

        assert ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE in codes, unsafe


def test_rejects_dynamic_json_import_even_through_assignment_alias() -> None:
    body = """def load(conn, order_id):
    # Принимаю соединение и идентификатор заказа.
    codec = __import__("json")
    # Загружаю модуль JSON динамически.
    rows = conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))
    # Выполняю параметризованный запрос.
    return codec.dumps(rows.fetchall())
    # Сериализую результат через динамический модуль."""

    codes = _codes(
        _minimal_answer(body=body),
        stable_requirements=(),
        visible_literals=(),
    )

    assert ScreenAnswerIssueCode.PYTHON_FORBIDDEN_OPERATION in codes
    assert ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER in codes


def _sql_input(sql: str, **overrides: object) -> ScreenAnswerValidationInput:
    values: dict[str, object] = {
        "answer": f"Сначала выполню один запрос и проверю результат.\n\n```sql\n{sql}\n```",
        "code_language": "sql",
        "expected_sql_statement_kind": "select",
        "require_russian_intro": True,
    }
    values.update(overrides)
    return ScreenAnswerValidationInput(**values)


def test_sql_lexer_accepts_optional_final_semicolon_casts_and_semicolons_in_literals_comments() -> (
    None
):
    cases = (
        "SELECT created_at::date FROM records",
        "SELECT 'a;b' AS value FROM records",
        "SELECT id FROM records /* ; DROP TABLE hidden */;",
        "SELECT id FROM records -- ; DROP TABLE hidden",
    )
    for sql in cases:
        result = validate_screen_answer(_sql_input(sql))

        assert result.valid is True, sql


def test_sql_lexer_rejects_unbalanced_quotes_comments_or_parentheses() -> None:
    cases = (
        "SELECT 'broken FROM records",
        "SELECT id FROM records /* broken",
        "SELECT (id FROM records",
        "SELECT id) FROM records",
    )
    for sql in cases:
        codes = validate_screen_answer(_sql_input(sql)).issue_codes

        assert ScreenAnswerIssueCode.SQL_LEX_INVALID in codes, sql


def test_sql_lexer_rejects_excessive_token_or_nesting_budgets() -> None:
    deeply_nested = "SELECT " + "(" * 80 + "1" + ")" * 80
    too_many_tokens = "SELECT " + ", ".join(f"column_{index}" for index in range(2_100))

    for sql in (deeply_nested, too_many_tokens):
        assert (
            ScreenAnswerIssueCode.SQL_LEX_INVALID
            in validate_screen_answer(_sql_input(sql)).issue_codes
        )


def test_sql_validator_rejects_extra_statement_and_forbidden_statement_families() -> None:
    cases = (
        "SELECT id FROM records; SELECT id FROM other",
        "SELECT id FROM records SELECT id FROM other",
        "SELECT id FROM records DROP TABLE hidden",
        "CREATE TABLE records(id int)",
        "GRANT SELECT ON records TO guest",
        "BEGIN",
        "COMMIT",
    )
    for sql in cases:
        codes = validate_screen_answer(_sql_input(sql)).issue_codes

        assert (
            ScreenAnswerIssueCode.SQL_STATEMENT_COUNT_INVALID in codes
            or ScreenAnswerIssueCode.SQL_FORBIDDEN_STATEMENT in codes
        ), sql


def test_sql_mutations_are_allowed_only_when_exact_kind_is_explicit() -> None:
    cases = (
        ("INSERT INTO records(id) VALUES (1)", "insert"),
        ("UPDATE records SET name = 'new' WHERE id = 1", "update"),
        ("DELETE FROM records WHERE id = 1", "delete"),
    )
    for sql, kind in cases:
        denied = validate_screen_answer(_sql_input(sql))
        allowed = validate_screen_answer(_sql_input(sql, expected_sql_statement_kind=kind))

        assert ScreenAnswerIssueCode.SQL_STATEMENT_KIND_MISMATCH in denied.issue_codes
        assert allowed.valid is True


def test_sql_requires_explicit_expected_statement_kind() -> None:
    result = validate_screen_answer(
        _sql_input("SELECT id FROM records", expected_sql_statement_kind=None)
    )

    assert result.issue_codes == (ScreenAnswerIssueCode.INVALID_INPUT,)


def test_sql_structural_requirements_ignore_identifiers_in_strings_and_comments() -> None:
    cases = (
        "SELECT 'secret_table' AS value FROM records",
        "SELECT id FROM records -- secret_table",
    )
    for sql in cases:
        result = validate_screen_answer(_sql_input(sql, required_sql_identifiers=("secret_table",)))

        assert ScreenAnswerIssueCode.SQL_IDENTIFIER_MISSING in result.issue_codes, sql


def test_sql_validates_required_identifiers_clauses_aliases_and_exact_literals() -> None:
    sql = "SELECT r.id FROM records AS r WHERE r.name = 'ready' ORDER BY r.id"

    result = validate_screen_answer(
        _sql_input(
            sql,
            required_sql_identifiers=("records", "r", "id", "name"),
            required_sql_clauses=("select", "from", "where", "order by"),
            visible_literals=("ready",),
        )
    )

    assert result.valid is True


def test_sql_rejects_unrequested_join_cte_and_json_but_explicit_flags_allow_them() -> None:
    cases = (
        (
            "SELECT r.id FROM records r JOIN owners o ON o.id = r.owner_id",
            "allow_join",
            ScreenAnswerIssueCode.UNREQUIRED_JOIN,
        ),
        (
            "WITH picked AS (SELECT id FROM records) SELECT id FROM picked",
            "allow_cte",
            ScreenAnswerIssueCode.UNREQUIRED_CTE,
        ),
        (
            "SELECT JSON_OBJECT('id', id) FROM records",
            "allow_json",
            ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER,
        ),
    )
    for sql, flag, issue in cases:
        denied = validate_screen_answer(_sql_input(sql))
        allowed = validate_screen_answer(_sql_input(sql, **{flag: True}))

        assert issue in denied.issue_codes, sql
        assert allowed.valid is True, sql


def test_rejects_duplicate_or_empty_stable_requirement_descriptors() -> None:
    duplicate = (
        StableCoverageRequirement(stable_id="same", python_calls=("load",)),
        StableCoverageRequirement(stable_id="same", identifiers=("orders",)),
    )
    empty_fragments = (StableCoverageRequirement(stable_id="empty"),)

    assert validate_screen_answer(
        _input(_minimal_answer(), stable_requirements=duplicate)
    ).issue_codes == (ScreenAnswerIssueCode.INVALID_INPUT,)
    assert validate_screen_answer(
        _input(_minimal_answer(), stable_requirements=empty_fragments)
    ).issue_codes == (ScreenAnswerIssueCode.INVALID_INPUT,)


def test_rejects_oversized_or_excessively_nested_validation_input() -> None:
    huge_answer = "я" * 70_000
    too_many_requirements = tuple(
        StableCoverageRequirement(stable_id=f"req-{index}", identifiers=("x",))
        for index in range(80)
    )

    assert validate_screen_answer(_input(huge_answer)).issue_codes == (
        ScreenAnswerIssueCode.INPUT_TOO_LARGE,
    )
    assert validate_screen_answer(
        _input(_minimal_answer(), stable_requirements=too_many_requirements)
    ).issue_codes == (ScreenAnswerIssueCode.INPUT_TOO_LARGE,)


def test_sql_mode_requires_exact_placeholders_only_for_declared_external_params() -> None:
    fixed = validate_screen_answer(_sql_input("SELECT id FROM orders WHERE id = 42"))
    exact_named = validate_screen_answer(
        _sql_input(
            "SELECT id FROM orders WHERE id = :order_id",
            required_sql_bound_ids=("order_id",),
        )
    )
    invalid_cases = (
        _sql_input("SELECT id FROM orders WHERE id = :untracked"),
        _sql_input(
            "SELECT id FROM orders WHERE id = 42",
            required_sql_bound_ids=("order_id",),
        ),
        _sql_input(
            "SELECT id FROM orders WHERE id = :wrong",
            required_sql_bound_ids=("order_id",),
        ),
        _sql_input(
            "SELECT id FROM orders WHERE id = ? AND user_id = ?",
            required_sql_bound_ids=("order_id",),
        ),
    )

    assert fixed.valid is True
    assert exact_named.valid is True
    for candidate in invalid_cases:
        assert (
            ScreenAnswerIssueCode.SQL_BINDING_MISSING
            in validate_screen_answer(candidate).issue_codes
        )


def test_rejects_wrong_fence_language_and_non_whitespace_tail() -> None:
    wrong_language = _sql_input("SELECT id FROM records")
    wrong_language = replace(
        wrong_language,
        answer=wrong_language.answer.replace("```sql", "```python", 1),
    )
    trailing = _sql_input("SELECT id FROM records")
    trailing = replace(trailing, answer=trailing.answer + "\nDROP TABLE records;")

    assert validate_screen_answer(wrong_language).valid is False
    assert validate_screen_answer(trailing).valid is False


def test_sql_shape_fails_closed_on_malformed_or_write_capable_selects() -> None:
    invalid_sql = (
        "SELECT FROM",
        "SELECT id FROM records WHERE",
        "WITH SELECT id FROM records",
        "SELECT 1 + FROM records",
        "SELECT id FROM records UNION SELECT",
        "SELECT id FROM records VALUES (1)",
        "SELECT id FROM records WHERE AND active = 1",
        "SELECT id FROM records WHERE id = = 1",
        "SELECT id FROM records WHERE id AND OR active",
        "SELECT id INTO copied_records FROM records",
        "SELECT id INTO OUTFILE '/tmp/records' FROM records",
        "SELECT 'safe\\'; DROP TABLE records; -- 'hidden",
    )

    for sql in invalid_sql:
        assert validate_screen_answer(_sql_input(sql)).valid is False, sql


def test_sql_identifier_chains_and_json_detection_are_structural() -> None:
    dotted = validate_screen_answer(
        _sql_input(
            "SELECT s.orders.id FROM s.orders",
            required_sql_identifiers=("s.orders", "s.orders.id"),
        )
    )
    ordinary_json_prefixed_table = validate_screen_answer(_sql_input("SELECT id FROM json_events"))
    actual_json_call = validate_screen_answer(
        _sql_input("SELECT JSON_OBJECT('id', id) FROM records")
    )

    assert dotted.valid is True
    assert ordinary_json_prefixed_table.valid is True
    assert ScreenAnswerIssueCode.UNREQUIRED_JSON_LAYER in actual_json_call.issue_codes


def test_embedded_sql_reuses_statement_shape_and_kind_validation() -> None:
    invalid_queries = (
        "DROP TABLE orders WHERE id = ?",
        "UPDATE orders SET admin = 1 WHERE id = ?",
        "SELECT FROM WHERE id = ?",
    )
    for query in invalid_queries:
        body = f'''def load(conn, order_id):
    return conn.execute("{query}", (order_id,))'''
        result = validate_screen_answer(
            _input(
                _minimal_answer(body=body),
                stable_requirements=(),
                visible_literals=(),
                required_sql_bound_ids=("order_id",),
                require_russian_line_comments=False,
            )
        )

        assert result.valid is False, query

    explicit_update = """def load(conn, order_id):
    return conn.execute("UPDATE orders SET active = 1 WHERE id = ?", (order_id,))"""
    assert validate_screen_answer(
        _input(
            _minimal_answer(body=explicit_update),
            stable_requirements=(),
            visible_literals=(),
            expected_sql_statement_kind="update",
            required_sql_bound_ids=("order_id",),
            require_russian_line_comments=False,
        )
    ).valid


def test_execute_contract_is_enforced_even_without_bound_identifiers() -> None:
    cases = (
        """def load(conn, order_id):
    conn.execute("SELECT 1")
    return conn.execute("SELECT 2")""",
        """def load(conn, order_id):
    return logger.execute("SELECT 1")""",
        """def load(conn, order_id):
    def hidden():
        return conn.execute("SELECT 1")
    return 1""",
    )
    for body in cases:
        result = validate_screen_answer(
            _input(
                _minimal_answer(body=body),
                stable_requirements=(),
                visible_literals=(),
                required_sql_bound_ids=(),
                require_russian_line_comments=False,
            )
        )

        assert result.valid is False, body

    direct = """def load(conn, order_id):
    return conn.execute("SELECT 1")"""
    assert validate_screen_answer(
        _input(
            _minimal_answer(body=direct),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            require_russian_line_comments=False,
        )
    ).valid


def test_sql_execute_must_be_direct_and_bound_ids_must_be_target_arguments() -> None:
    short_circuit = """def load(conn, order_id):
    return ready and conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,))"""
    undeclared_global = """def load(conn, order_id):
    return conn.execute("SELECT id FROM orders WHERE id = ?", (global_id,))"""

    first = validate_screen_answer(
        _input(
            _minimal_answer(body=short_circuit),
            stable_requirements=(),
            visible_literals=(),
            require_russian_line_comments=False,
        )
    )
    second = validate_screen_answer(
        _input(
            _minimal_answer(body=undeclared_global),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=("global_id",),
            require_russian_line_comments=False,
        )
    )

    assert first.valid is False
    assert ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE in second.issue_codes


def test_rejects_every_rebind_delete_or_indirect_mutation_of_sql_bindings() -> None:
    unsafe_blocks = (
        'query = "SELECT id FROM orders WHERE id = ?"\n    query += " OR admin = 1"\n    params = (order_id,)',
        'query = "SELECT id FROM orders WHERE id = ?"\n    del query\n    params = (order_id,)',
        'query = "SELECT id FROM orders WHERE id = ?"\n    params = [order_id]\n    params += [other_id]',
        'query = "SELECT id FROM orders WHERE id = :order_id"\n    params = {"order_id": order_id}\n    params.__setitem__("order_id", other_id)',
        'query = "SELECT id FROM orders WHERE id = :order_id"\n    params = {"order_id": order_id}\n    dict.__setitem__(params, "order_id", other_id)',
        'query = "SELECT id FROM orders WHERE id = ?"\n    params = [order_id]\n    mutate(params)',
    )
    for unsafe in unsafe_blocks:
        body = f"""def load(conn, order_id):
    {unsafe}
    return conn.execute(query, params)"""
        result = validate_screen_answer(
            _input(
                _minimal_answer(body=body),
                stable_requirements=(),
                visible_literals=(),
                require_russian_line_comments=False,
            )
        )

        assert ScreenAnswerIssueCode.SQL_DATAFLOW_UNSAFE in result.issue_codes, unsafe


def test_definition_time_expressions_use_a_safe_whitelist() -> None:
    unsafe_headers = (
        "def load(conn=1 / 0):",
        "def load(conn=dangerous[0]):",
        "def load(conn=dangerous.value):",
        "def load(conn: dangerous[0]):",
    )
    for header in unsafe_headers:
        body = f"{header}\n    return conn"
        result = validate_screen_answer(
            _input(
                _minimal_answer(body=body),
                stable_requirements=(),
                visible_public_signature=header,
                visible_literals=(),
                required_sql_bound_ids=(),
                require_russian_line_comments=False,
            )
        )

        assert ScreenAnswerIssueCode.PYTHON_TOP_LEVEL_SCAFFOLDING in result.issue_codes, header

    safe = """def load(values: list[int] | None = None) -> list[int]:
    return [] if values is None else values"""
    assert validate_screen_answer(
        _input(
            _minimal_answer(body=safe),
            stable_requirements=(),
            visible_public_signature="def load(values: list[int] | None = None) -> list[int]:",
            visible_literals=(),
            required_sql_bound_ids=(),
            require_russian_line_comments=False,
        )
    ).valid


def test_helper_flag_controls_top_level_helpers_and_nested_helpers_fail_closed() -> None:
    top_level = """def normalize(value):
    return value

def load(conn, order_id):
    return normalize(order_id)"""
    nested = """def load(conn, order_id):
    def normalize(value):
        return value
    return normalize(order_id)"""
    nested_lambda = """def load(conn, order_id):
    normalize = lambda value: value
    return normalize(order_id)"""

    denied = validate_screen_answer(
        _input(
            _minimal_answer(body=top_level),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            allow_helper=False,
            require_russian_line_comments=False,
        )
    )
    allowed = validate_screen_answer(
        _input(
            _minimal_answer(body=top_level),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            allow_helper=True,
            require_russian_line_comments=False,
        )
    )
    nested_result = validate_screen_answer(
        _input(
            _minimal_answer(body=nested),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            allow_helper=True,
            require_russian_line_comments=False,
        )
    )
    nested_lambda_result = validate_screen_answer(
        _input(
            _minimal_answer(body=nested_lambda),
            stable_requirements=(),
            visible_literals=(),
            required_sql_bound_ids=(),
            allow_helper=True,
            require_russian_line_comments=False,
        )
    )

    assert ScreenAnswerIssueCode.EXTRA_TOP_LEVEL_LAYER in denied.issue_codes
    assert allowed.valid is True
    assert ScreenAnswerIssueCode.PYTHON_TOP_LEVEL_SCAFFOLDING in nested_result.issue_codes
    assert ScreenAnswerIssueCode.PYTHON_TOP_LEVEL_SCAFFOLDING in nested_lambda_result.issue_codes


def test_short_circuit_and_print_decoys_do_not_cover_structural_evidence() -> None:
    body = """def load(conn, order_id):
    ready and rows.fetchall()
    print("required-visible-value")
    return order_id"""
    result = validate_screen_answer(
        _input(
            _minimal_answer(body=body),
            stable_requirements=(
                StableCoverageRequirement(
                    stable_id="call",
                    python_calls=("rows.fetchall",),
                ),
                StableCoverageRequirement(
                    stable_id="literal",
                    literals=("required-visible-value",),
                ),
            ),
            visible_literals=(),
            required_sql_bound_ids=(),
            require_russian_line_comments=False,
        )
    )

    assert result.missing_stable_ids == ("call", "literal")


def test_non_function_python_profiles_fail_with_an_explicit_routable_code() -> None:
    answer = """Объясню, почему этот профиль требует отдельного валидатора.

```python
value = 1
```"""
    for profile in ("script", "class", "pytest"):
        result = validate_screen_answer(
            ScreenAnswerValidationInput(
                answer=answer,
                code_language="python",
                python_shape=profile,
            )
        )

        assert result.issue_codes == (ScreenAnswerIssueCode.PYTHON_PROFILE_UNSUPPORTED,)


def test_sql_comment_check_ignores_comment_markers_inside_supported_quoted_tokens() -> None:
    cases = (
        "SELECT $$-- not a comment$$ AS value FROM records",
        "SELECT `name--suffix` FROM records",
        "SELECT id /* -- not a line comment */ FROM records",
    )
    for sql in cases:
        answer = f"""Сначала выполню один запрос.

```sql
{sql}
-- Объясняю строку запроса по-русски.
```"""
        result = validate_screen_answer(
            ScreenAnswerValidationInput(
                answer=answer,
                code_language="sql",
                expected_sql_statement_kind="select",
                require_russian_line_comments=True,
            )
        )

        assert result.valid is True, sql
