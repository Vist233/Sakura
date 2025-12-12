"""
Write 工具 - 写入文件（强制读取验证）

这是 Claude Code 安全机制的核心：
只有先读取过的文件才能被写入，防止"盲写"覆盖重要内容。
"""

from pathlib import Path
from typing import Optional

from sakura.tools import tool
from .read import get_file_state


@tool
def write(
    path: str,
    content: str,
    create_directories: bool = True,
) -> str:
    """
    写入文件内容（需要先读取文件）。
    
    安全机制：
    1. 对于已存在的文件，必须先用 read() 读取过
    2. 如果文件被外部修改，需要重新读取
    3. 新文件可以直接创建
    
    Args:
        path: 文件路径
        content: 要写入的内容
        create_directories: 是否自动创建父目录（默认 True）
    
    Returns:
        成功或错误消息
    
    Examples:
        write("new_file.py", "print('hello')")  # 创建新文件
        read("existing.py")  # 必须先读取
        write("existing.py", new_content)  # 然后才能写入
    """
    abs_path = Path(path).resolve()
    
    # 强制读取验证（仅对已存在文件）
    file_state = get_file_state()
    if file_state is not None and abs_path.exists():
        valid, error = file_state.validate_for_write(str(abs_path))
        if not valid:
            return f"❌ Error: {error}"
    
    try:
        # 创建父目录
        if create_directories:
            abs_path.parent.mkdir(parents=True, exist_ok=True)
        
        # 写入文件
        abs_path.write_text(content, encoding='utf-8')
        
        # 更新 FileState
        if file_state is not None:
            file_state.record_write(str(abs_path), content)
        
        # 统计信息
        lines = content.count('\n') + 1
        bytes_written = len(content.encode('utf-8'))
        
        return f"✅ Wrote {bytes_written} bytes ({lines} lines) to {path}"
        
    except PermissionError:
        return f"❌ Error: Permission denied: {path}"
    except Exception as e:
        return f"❌ Error writing file: {e}"
