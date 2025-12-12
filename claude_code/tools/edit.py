"""
Edit 工具 - 基于 diff 的文件编辑

比 write 更精确的编辑方式：
通过指定要替换的内容和新内容，实现局部修改。
"""

from pathlib import Path
from typing import Optional

from sakura.tools import tool
from .read import get_file_state


@tool  
def edit(
    path: str,
    old_content: str,
    new_content: str,
    replace_all: bool = False,
) -> str:
    """
    编辑文件的指定部分（需要先读取文件）。
    
    通过精确匹配 old_content 并替换为 new_content 实现编辑。
    比 write() 更安全，因为只修改匹配的部分。
    
    安全机制：
    1. 文件必须先用 read() 读取过
    2. old_content 必须在文件中精确存在
    3. 默认情况下 old_content 必须唯一（避免歧义）
    
    Args:
        path: 文件路径
        old_content: 要替换的原始内容（必须精确匹配）
        new_content: 替换后的新内容
        replace_all: 是否替换所有匹配项（默认 False，只替换唯一匹配）
    
    Returns:
        成功或错误消息
    
    Examples:
        read("main.py")
        edit("main.py", 
             old_content="def old_func():",
             new_content="def new_func():")
        
        # 重命名变量（所有匹配项）
        edit("main.py",
             old_content="oldVariable",
             new_content="newVariable",
             replace_all=True)
    """
    abs_path = Path(path).resolve()
    
    # 检查文件是否存在
    if not abs_path.exists():
        return f"❌ Error: File not found: {path}"
    
    # 强制读取验证
    file_state = get_file_state()
    if file_state is not None:
        valid, error = file_state.validate_for_write(str(abs_path))
        if not valid:
            return f"❌ Error: {error}"
    
    try:
        # 读取当前内容
        current_content = abs_path.read_text(encoding='utf-8')
        
        # 检查 old_content 是否存在
        if old_content not in current_content:
            # 提供更详细的错误信息
            return (
                f"❌ Error: Could not find the specified content in {path}.\n"
                f"Make sure the old_content matches exactly (including whitespace).\n"
                f"Tip: Use read() to see the current file content."
            )
        
        # 检查 old_content 是否唯一（除非 replace_all=True）
        occurrences = current_content.count(old_content)
        if occurrences > 1 and not replace_all:
            return (
                f"❌ Error: Found {occurrences} occurrences of the specified content.\n"
                f"The old_content must be unique. Add more context to make it unique,\n"
                f"or use replace_all=True to replace all occurrences."
            )
        
        # 执行替换
        if replace_all:
            new_file_content = current_content.replace(old_content, new_content)
            replaced_count = occurrences
        else:
            new_file_content = current_content.replace(old_content, new_content, 1)
            replaced_count = 1
        
        # 写入文件
        abs_path.write_text(new_file_content, encoding='utf-8')
        
        # 更新 FileState
        if file_state is not None:
            file_state.record_write(str(abs_path), new_file_content)
        
        # 统计变化
        old_lines = old_content.count('\n') + 1
        new_lines = new_content.count('\n') + 1
        
        if replace_all and replaced_count > 1:
            return (
                f"✅ Edited {path}\n"
                f"   Replaced {replaced_count} occurrences"
            )
        else:
            return (
                f"✅ Edited {path}\n"
                f"   Replaced {old_lines} line(s) with {new_lines} line(s)"
            )
        
    except Exception as e:
        return f"❌ Error editing file: {e}"
