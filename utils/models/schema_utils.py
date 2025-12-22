"""
Sakura Schema Utilities - Schema 转换工具

为不同模型提供商转换响应 Schema
"""

from typing import Any, Dict, Optional, Type, Union
from pydantic import BaseModel


def get_response_schema_for_provider(
    response_format: Type[BaseModel],
    provider: str = "openai",
) -> Dict[str, Any]:
    """
    为指定提供商获取响应 Schema
    
    Args:
        response_format: Pydantic 模型类
        provider: 提供商名称 ("openai", "anthropic", "google" 等)
    
    Returns:
        转换后的 JSON Schema
    """
    # 获取 Pydantic 模型的 JSON Schema
    schema = response_format.model_json_schema()
    
    if provider.lower() == "openai":
        return _prepare_openai_schema(schema)
    elif provider.lower() in ["anthropic", "claude"]:
        return _prepare_anthropic_schema(schema)
    else:
        return schema


def _prepare_openai_schema(schema: Dict[str, Any]) -> Dict[str, Any]:
    """为 OpenAI 准备 Schema"""
    # OpenAI 需要移除 $defs 引用并展开它们
    schema = _resolve_refs(schema)
    
    # 确保所有对象类型都有 additionalProperties: false
    _ensure_additional_properties_false(schema)
    
    # 移除不支持的字段
    _remove_unsupported_fields(schema)
    
    return schema


def _prepare_anthropic_schema(schema: Dict[str, Any]) -> Dict[str, Any]:
    """为 Anthropic 准备 Schema"""
    schema = _resolve_refs(schema)
    _ensure_additional_properties_false(schema)
    return schema


def _resolve_refs(schema: Dict[str, Any], defs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    解析并展开 $ref 引用
    """
    if defs is None:
        defs = schema.get("$defs", schema.get("definitions", {}))
        # 移除顶层的 $defs
        if "$defs" in schema:
            schema = {k: v for k, v in schema.items() if k != "$defs"}
        if "definitions" in schema:
            schema = {k: v for k, v in schema.items() if k != "definitions"}
    
    if isinstance(schema, dict):
        # 如果有 $ref，替换为实际定义
        if "$ref" in schema:
            ref_path = schema["$ref"]
            # 解析 #/$defs/ClassName 格式
            if ref_path.startswith("#/$defs/"):
                ref_name = ref_path[8:]  # 移除 "#/$defs/"
                if ref_name in defs:
                    return _resolve_refs(defs[ref_name].copy(), defs)
            elif ref_path.startswith("#/definitions/"):
                ref_name = ref_path[14:]  # 移除 "#/definitions/"
                if ref_name in defs:
                    return _resolve_refs(defs[ref_name].copy(), defs)
            return schema
        
        # 递归处理所有字段
        result = {}
        for key, value in schema.items():
            if isinstance(value, dict):
                result[key] = _resolve_refs(value, defs)
            elif isinstance(value, list):
                result[key] = [
                    _resolve_refs(item, defs) if isinstance(item, dict) else item
                    for item in value
                ]
            else:
                result[key] = value
        return result
    
    return schema


def _ensure_additional_properties_false(schema: Dict[str, Any]) -> None:
    """
    递归确保所有对象类型都有 additionalProperties: false
    """
    if isinstance(schema, dict):
        if schema.get("type") == "object":
            schema["additionalProperties"] = False
        
        # 递归处理嵌套 schema
        for key, value in schema.items():
            if key in ["properties", "items", "allOf", "anyOf", "oneOf"]:
                if isinstance(value, dict):
                    _ensure_additional_properties_false(value)
                elif isinstance(value, list):
                    for item in value:
                        if isinstance(item, dict):
                            _ensure_additional_properties_false(item)


def _remove_unsupported_fields(schema: Dict[str, Any]) -> None:
    """
    移除 API 不支持的字段
    """
    unsupported = ["title", "description", "examples", "default"]
    
    if isinstance(schema, dict):
        for field in unsupported:
            schema.pop(field, None)
        
        for value in schema.values():
            if isinstance(value, dict):
                _remove_unsupported_fields(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        _remove_unsupported_fields(item)
