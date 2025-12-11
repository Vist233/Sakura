"""
Sakura Tools Utilities - 工具辅助函数

提供工具调用相关的辅助函数
"""

import json
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..tools.function import Function, FunctionCall


def get_function_call_for_tool_call(
    tool_call: Dict[str, Any],
    functions: Dict[str, "Function"],
) -> Optional["FunctionCall"]:
    """
    从工具调用中创建 FunctionCall 对象
    
    Args:
        tool_call: OpenAI 格式的工具调用
        functions: 可用函数字典
    
    Returns:
        FunctionCall 对象，如果函数不存在则返回 None
    """
    from ..tools.function import FunctionCall
    
    tool_name = tool_call.get("function", {}).get("name")
    if not tool_name:
        return None
    
    if tool_name not in functions:
        return None
    
    function = functions[tool_name]
    
    # 解析参数
    arguments_str = tool_call.get("function", {}).get("arguments", "{}")
    try:
        arguments = json.loads(arguments_str) if isinstance(arguments_str, str) else arguments_str
    except json.JSONDecodeError:
        arguments = {}
    
    return FunctionCall(
        function=function,
        arguments=arguments,
        call_id=tool_call.get("id"),
    )


def get_function_call_for_tool_execution(
    tool_execution: Dict[str, Any],
    functions: Dict[str, "Function"],
) -> Optional["FunctionCall"]:
    """
    从工具执行记录中创建 FunctionCall 对象
    
    Args:
        tool_execution: 工具执行记录
        functions: 可用函数字典
    
    Returns:
        FunctionCall 对象，如果函数不存在则返回 None
    """
    from ..tools.function import FunctionCall
    
    tool_name = tool_execution.get("tool_name")
    if not tool_name:
        return None
    
    if tool_name not in functions:
        return None
    
    function = functions[tool_name]
    
    return FunctionCall(
        function=function,
        arguments=tool_execution.get("tool_args", {}),
        call_id=tool_execution.get("tool_call_id"),
        result=tool_execution.get("result"),
    )


def format_tool_calls_for_message(tool_calls: List[Dict[str, Any]]) -> str:
    """
    将工具调用格式化为可读字符串
    
    Args:
        tool_calls: 工具调用列表
    
    Returns:
        格式化的字符串
    """
    lines = []
    for call in tool_calls:
        func_name = call.get("function", {}).get("name", "unknown")
        args = call.get("function", {}).get("arguments", "{}")
        lines.append(f"- {func_name}({args})")
    return "\n".join(lines)


def validate_tool_args(
    function: "Function",
    arguments: Dict[str, Any],
) -> List[str]:
    """
    验证工具参数
    
    Args:
        function: 函数定义
        arguments: 参数字典
    
    Returns:
        错误消息列表（空列表表示验证通过）
    """
    errors = []
    
    # 检查必需参数
    required = function.parameters.get("required", [])
    for param in required:
        if param not in arguments:
            errors.append(f"Missing required parameter: {param}")
    
    # 检查参数类型（可选）
    properties = function.parameters.get("properties", {})
    for param_name, param_value in arguments.items():
        if param_name in properties:
            expected_type = properties[param_name].get("type")
            if expected_type:
                if not _check_type(param_value, expected_type):
                    errors.append(f"Invalid type for {param_name}: expected {expected_type}")
    
    return errors


def _check_type(value: Any, expected_type: str) -> bool:
    """检查值是否匹配预期类型"""
    type_map = {
        "string": str,
        "number": (int, float),
        "integer": int,
        "boolean": bool,
        "array": list,
        "object": dict,
        "null": type(None),
    }
    
    expected = type_map.get(expected_type)
    if expected is None:
        return True  # 未知类型，默认通过
    
    return isinstance(value, expected)
