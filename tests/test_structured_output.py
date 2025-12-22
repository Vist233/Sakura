"""测试结构化输出解析"""
import pytest
from pydantic import BaseModel

from sakura.utils.parsing import parse_structured_output, _strip_markdown_code_block


class LabelOutput(BaseModel):
    label: str


class PersonOutput(BaseModel):
    name: str
    age: int


class TestStripMarkdownCodeBlock:
    """测试 Markdown 代码块剥离"""

    def test_plain_json(self):
        content = '{"label": "破冰"}'
        assert _strip_markdown_code_block(content) == '{"label": "破冰"}'

    def test_json_code_block(self):
        content = '```json\n{"label": "破冰"}\n```'
        assert _strip_markdown_code_block(content) == '{"label": "破冰"}'

    def test_plain_code_block(self):
        content = '```\n{"label": "破冰"}\n```'
        assert _strip_markdown_code_block(content) == '{"label": "破冰"}'

    def test_with_whitespace(self):
        content = '  ```json\n{"label": "破冰"}\n```  '
        assert _strip_markdown_code_block(content) == '{"label": "破冰"}'


class TestParseStructuredOutput:
    """测试结构化输出解析"""

    def test_simple_json(self):
        content = '{"label": "破冰"}'
        result = parse_structured_output(content, LabelOutput)
        assert result is not None
        assert result.label == "破冰"

    def test_json_with_markdown(self):
        content = '```json\n{"label": "破冰"}\n```'
        result = parse_structured_output(content, LabelOutput)
        assert result is not None
        assert result.label == "破冰"

    def test_complex_model(self):
        content = '{"name": "张三", "age": 25}'
        result = parse_structured_output(content, PersonOutput)
        assert result is not None
        assert result.name == "张三"
        assert result.age == 25

    def test_invalid_json_returns_none(self):
        content = "这不是 JSON"
        result = parse_structured_output(content, LabelOutput)
        assert result is None

    def test_empty_content_returns_none(self):
        result = parse_structured_output("", LabelOutput)
        assert result is None

    def test_validation_error_returns_none(self):
        # age 应该是 int，但传了 string
        content = '{"name": "张三", "age": "二十五"}'
        result = parse_structured_output(content, PersonOutput)
        assert result is None
