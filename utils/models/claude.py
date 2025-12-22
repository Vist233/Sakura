"""
Sakura Claude Utilities - Claude 特定工具

提供 Claude API 格式化和配置工具
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

from ...messages.message import Message


@dataclass
class MCPServerConfiguration:
    """MCP 服务器配置"""
    
    # 服务器类型
    type: str = "url"
    # 服务器 URL
    url: Optional[str] = None
    # 服务器名称
    name: Optional[str] = None
    # 认证头
    authorization_token: Optional[str] = None
    # 工具配置
    tool_configuration: Optional[Dict[str, Any]] = None


def format_messages(
    messages: List[Message],
    compress_tool_results: bool = False,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    将消息列表格式化为 Claude API 格式
    
    Args:
        messages: 消息列表
        compress_tool_results: 是否压缩工具结果
    
    Returns:
        Tuple[聊天消息列表, 系统消息字符串]
    """
    chat_messages: List[Dict[str, Any]] = []
    system_message = ""
    
    for msg in messages:
        if msg.role == "system":
            # Claude 使用单独的 system 参数
            if system_message:
                system_message += "\n\n"
            content = msg.get_content_string() or ""
            system_message += content
        else:
            formatted = _format_message_for_claude(msg, compress_tool_results)
            if formatted:
                chat_messages.append(formatted)
    
    return chat_messages, system_message


def _format_message_for_claude(
    message: Message,
    compress_tool_results: bool = False,
) -> Optional[Dict[str, Any]]:
    """
    格式化单条消息为 Claude 格式
    """
    role = message.role
    if role == "system":
        return None  # 系统消息单独处理
    
    # 映射角色
    if role == "tool":
        role = "user"  # Claude 使用 user 角色处理工具结果
    
    content = message.get_content(use_compressed_content=compress_tool_results)
    
    # 构建消息内容
    if message.tool_call_id:
        # 这是工具结果消息
        return {
            "role": role,
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id,
                    "content": str(content) if content else "",
                }
            ]
        }
    
    # 检查是否有工具调用
    if message.tool_calls and len(message.tool_calls) > 0:
        content_blocks = []
        
        # 添加文本内容
        if content:
            content_blocks.append({
                "type": "text",
                "text": str(content)
            })
        
        # 添加工具调用
        for tool_call in message.tool_calls:
            tool_use_block = {
                "type": "tool_use",
                "id": tool_call.get("id", ""),
                "name": tool_call.get("function", {}).get("name", ""),
                "input": _parse_tool_arguments(tool_call.get("function", {}).get("arguments", "{}")),
            }
            content_blocks.append(tool_use_block)
        
        return {
            "role": "assistant",
            "content": content_blocks
        }
    
    # 处理图片
    if message.images and len(message.images) > 0:
        content_blocks = []
        
        for image in message.images:
            if image.url:
                content_blocks.append({
                    "type": "image",
                    "source": {
                        "type": "url",
                        "url": image.url
                    }
                })
            elif image.base64_data or image.data or image.filepath:
                b64_data = image.to_base64()
                if b64_data:
                    content_blocks.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type,
                            "data": b64_data
                        }
                    })
        
        # 添加文本内容
        if content:
            content_blocks.append({
                "type": "text",
                "text": str(content)
            })
        
        return {
            "role": role,
            "content": content_blocks
        }
    
    # 普通文本消息
    return {
        "role": role,
        "content": str(content) if content else ""
    }


def _parse_tool_arguments(arguments: Union[str, dict]) -> dict:
    """解析工具调用参数"""
    if isinstance(arguments, dict):
        return arguments
    
    try:
        import json
        return json.loads(arguments)
    except (json.JSONDecodeError, TypeError):
        return {}


def format_tools_for_model(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    将工具列表格式化为 Claude API 格式
    
    Args:
        tools: 工具定义列表
    
    Returns:
        Claude 格式的工具列表
    """
    formatted_tools = []
    
    for tool in tools:
        if tool.get("type") == "function":
            func = tool.get("function", {})
            formatted_tool = {
                "name": func.get("name", ""),
                "description": func.get("description", ""),
                "input_schema": func.get("parameters", {"type": "object", "properties": {}})
            }
            formatted_tools.append(formatted_tool)
        elif tool.get("type") in ["code_execution_20250825", "computer_20240101"]:
            # 保留特殊工具类型
            formatted_tools.append(tool)
        else:
            # 其他格式的工具
            formatted_tools.append(tool)
    
    return formatted_tools
