"""
Sakura Compression Validator - 压缩结果验证

验证压缩后的消息列表完整性
"""

from typing import Any, Dict, List, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from ..messages.message import Message


class CompressionValidator:
    """
    压缩结果验证器
    
    验证压缩后的消息列表是否保持必要的完整性
    
    Example:
        is_valid, warnings = CompressionValidator.validate(original, compressed)
        if not is_valid:
            print("Compression validation failed:", warnings)
    """
    
    @staticmethod
    def validate(
        original: List["Message"], 
        compressed: List["Message"]
    ) -> Tuple[bool, List[str]]:
        """
        验证压缩结果的完整性
        
        检查项：
        1. 系统消息是否保留
        2. 工具调用配对是否完整
        3. Token 数是否减少
        4. 最后几条消息是否保留
        
        Args:
            original: 原始消息列表
            compressed: 压缩后的消息列表
        
        Returns:
            (是否有效, 警告列表)
        """
        warnings = []
        
        if not original or not compressed:
            return True, []
        
        # 1. 检查系统消息是否保留
        orig_system = [m for m in original if m.role == "system"]
        comp_system = [m for m in compressed if m.role == "system"]
        
        # 原始系统消息应该存在于压缩结果中（或被替换为摘要）
        orig_system_content = set(
            m.content for m in orig_system 
            if m.content and "[对话历史摘要]" not in (m.content or "")
        )
        comp_system_content = set(
            m.content for m in comp_system 
            if m.content and "[对话历史摘要]" not in (m.content or "")
        )
        
        missing_system = orig_system_content - comp_system_content
        if missing_system and len(missing_system) == len(orig_system_content):
            warnings.append("所有原始系统消息丢失（可能被摘要替代）")
        
        # 2. 检查工具调用配对
        tool_call_ids = set()
        tool_result_ids = set()
        
        for m in compressed:
            if hasattr(m, 'tool_calls') and m.tool_calls:
                for tc in m.tool_calls:
                    if isinstance(tc, dict) and 'id' in tc:
                        tool_call_ids.add(tc['id'])
            if hasattr(m, 'tool_call_id') and m.tool_call_id:
                tool_result_ids.add(m.tool_call_id)
        
        # 检查孤立的工具结果（没有对应的调用）
        orphan_results = tool_result_ids - tool_call_ids
        if orphan_results:
            warnings.append(f"发现 {len(orphan_results)} 个孤立的工具结果")
        
        # 检查没有结果的工具调用
        missing_results = tool_call_ids - tool_result_ids
        if missing_results:
            # 这可能是正常的（最新的工具调用还没有结果）
            pass
        
        # 3. 检查压缩是否有效减少了 Token
        from ..utils.tokens import TokenCounter
        
        orig_tokens = TokenCounter.count_messages(original)
        comp_tokens = TokenCounter.count_messages(compressed)
        
        if comp_tokens >= orig_tokens:
            warnings.append(f"压缩未减少 Token 数 ({orig_tokens} -> {comp_tokens})")
        
        # 4. 检查消息数量变化
        if len(compressed) > len(original):
            warnings.append("压缩后消息数量反而增加")
        
        # 5. 检查最后一条用户/助手消息是否保留
        orig_last_non_system = None
        for m in reversed(original):
            if m.role in ("user", "assistant"):
                orig_last_non_system = m
                break
        
        comp_last_non_system = None
        for m in reversed(compressed):
            if m.role in ("user", "assistant"):
                comp_last_non_system = m
                break
        
        if orig_last_non_system and comp_last_non_system:
            if orig_last_non_system.content != comp_last_non_system.content:
                warnings.append("最后一条消息内容被修改")
        
        # 判断是否有效
        # 严重问题：孤立工具结果、Token 未减少
        critical_issues = [
            w for w in warnings 
            if "孤立" in w or "未减少" in w
        ]
        
        is_valid = len(critical_issues) == 0
        
        return is_valid, warnings
    
    @staticmethod
    def check_tool_pairs(messages: List["Message"]) -> Dict[str, Any]:
        """
        检查工具调用配对状态
        
        Args:
            messages: 消息列表
        
        Returns:
            配对状态信息
        """
        call_ids = set()
        result_ids = set()
        call_names = {}
        
        for m in messages:
            if hasattr(m, 'tool_calls') and m.tool_calls:
                for tc in m.tool_calls:
                    if isinstance(tc, dict):
                        tc_id = tc.get('id')
                        if tc_id:
                            call_ids.add(tc_id)
                            func = tc.get('function', {})
                            call_names[tc_id] = func.get('name', 'unknown')
            
            if hasattr(m, 'tool_call_id') and m.tool_call_id:
                result_ids.add(m.tool_call_id)
        
        paired = call_ids & result_ids
        orphan_calls = call_ids - result_ids
        orphan_results = result_ids - call_ids
        
        return {
            "total_calls": len(call_ids),
            "total_results": len(result_ids),
            "paired": len(paired),
            "orphan_calls": list(orphan_calls),
            "orphan_results": list(orphan_results),
            "call_names": call_names
        }
