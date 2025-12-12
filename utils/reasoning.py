"""
Sakura Reasoning Utilities - 推理内容处理工具

从模型响应中提取思维链/推理内容
"""

import re
from typing import Optional, Tuple


def extract_thinking_content(content: str) -> Tuple[Optional[str], str]:
    """
    从响应内容中提取思维链内容
    
    支持以下格式：
    - <thinking>...</thinking> 标签
    - <thought>...</thought> 标签
    - <reasoning>...</reasoning> 标签
    
    Args:
        content: 原始响应内容
    
    Returns:
        Tuple[Optional[str], str]: (思维内容, 清理后的输出内容)
    """
    if not content:
        return None, content
    
    reasoning_content = None
    output_content = content
    
    # 尝试匹配不同的思维标签格式
    patterns = [
        (r'<thinking>(.*?)</thinking>', re.DOTALL),
        (r'<thought>(.*?)</thought>', re.DOTALL),
        (r'<reasoning>(.*?)</reasoning>', re.DOTALL),
        (r'<think>(.*?)</think>', re.DOTALL),
    ]
    
    for pattern, flags in patterns:
        match = re.search(pattern, content, flags)
        if match:
            reasoning_content = match.group(1).strip()
            # 从输出中移除思维内容
            output_content = re.sub(pattern, '', content, flags=flags).strip()
            break
    
    return reasoning_content, output_content


def format_reasoning_for_display(reasoning: str, max_length: Optional[int] = None) -> str:
    """
    格式化推理内容用于显示
    
    Args:
        reasoning: 推理内容
        max_length: 最大长度限制
    
    Returns:
        格式化后的推理内容
    """
    if not reasoning:
        return ""
    
    formatted = reasoning.strip()
    
    if max_length and len(formatted) > max_length:
        formatted = formatted[:max_length - 3] + "..."
    
    return formatted
