"""
Read 工具 - 读取文件并记录到 FileState

这是 Claude Code "强制读后写" 机制的入口：
每次读取都会更新 FileStateTracker，后续写入会验证状态。
"""

from pathlib import Path
from typing import Optional

from sakura.tools import tool

# 全局 file_state 引用 - 由 ClaudeCodeAgent 设置
# 使用模块级变量而非工具属性（因为 Function 是 Pydantic 模型）
_file_state_registry = {}


def get_file_state():
    """获取当前的 FileStateTracker"""
    return _file_state_registry.get('current')


def set_file_state(tracker):
    """设置当前的 FileStateTracker（由 ClaudeCodeAgent 调用）"""
    _file_state_registry['current'] = tracker


@tool
def read(
    path: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
) -> str:
    """
    读取文件内容。
    
    读取后文件状态会被记录，允许后续的 write/edit 操作。
    
    Args:
        path: 文件路径（相对或绝对）
        start_line: 起始行号（1-indexed，可选）
        end_line: 结束行号（1-indexed，含，可选）
    
    Returns:
        文件内容。如果指定了行范围，只返回该范围。
    
    Examples:
        read("src/main.py")  # 读取整个文件
        read("src/main.py", 1, 50)  # 读取 1-50 行
    """
    abs_path = Path(path).resolve()
    
    # 检查文件是否存在
    if not abs_path.exists():
        return f"❌ Error: File not found: {path}"
    
    if not abs_path.is_file():
        return f"❌ Error: Not a file: {path}"
    
    try:
        content = abs_path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        return f"❌ Error: Cannot read binary file: {path}"
    except Exception as e:
        return f"❌ Error reading file: {e}"
    
    # 记录到 FileState（完整内容）
    file_state = get_file_state()
    if file_state is not None:
        file_state.record_read(str(abs_path), content)
    
    # 如果指定了行范围，返回子集
    if start_line is not None or end_line is not None:
        lines = content.split('\n')
        total_lines = len(lines)
        
        start = max(1, start_line or 1) - 1  # 转为 0-indexed
        end = min(total_lines, end_line or total_lines)
        
        selected_lines = lines[start:end]
        
        # 添加行号前缀
        numbered_lines = [
            f"{start + i + 1}: {line}" 
            for i, line in enumerate(selected_lines)
        ]
        
        return f"File: {path} (lines {start + 1}-{end} of {total_lines})\n" + "\n".join(numbered_lines)
    
    # 返回完整内容
    lines = content.split('\n')
    return f"File: {path} ({len(lines)} lines)\n{content}"
