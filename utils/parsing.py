"""
结构化输出解析工具

从 LLM 响应中解析 Pydantic 模型
"""

from typing import Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from .log import log_debug

T = TypeVar("T", bound=BaseModel)


def parse_structured_output(
    content: str,
    schema: Type[T],
) -> Optional[T]:
    """
    从 LLM 输出内容解析为 Pydantic 模型
    
    Args:
        content: LLM 返回的原始文本（可能包含 JSON 或 Markdown 代码块）
        schema: 目标 Pydantic 模型类
    
    Returns:
        解析成功返回 Pydantic 模型实例，失败返回 None
    """
    if not content:
        return None
    
    # 去除 Markdown 代码块包裹
    cleaned = _strip_markdown_code_block(content)
    
    try:
        return schema.model_validate_json(cleaned)
    except ValidationError as e:
        log_debug(f"Structured output validation failed: {e}")
        return None
    except Exception as e:
        log_debug(f"Structured output parsing failed: {e}")
        return None


def _strip_markdown_code_block(content: str) -> str:
    """
    去除可能的 Markdown 代码块包裹
    
    支持格式:
    - ```json\n{...}\n```
    - ```\n{...}\n```
    - 纯 JSON
    """
    content = content.strip()
    
    if not content.startswith("```"):
        return content
    
    # 移除开头的 ```json 或 ```
    lines = content.split("\n", 1)
    if len(lines) > 1:
        content = lines[1]
    else:
        # 单行情况，移除 ``` 前缀
        content = content[3:]
    
    # 移除结尾的 ```
    if content.endswith("```"):
        content = content[:-3]
    
    return content.strip()
