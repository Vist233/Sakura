"""
Sakura Compression Strategies - 压缩策略

提供多种上下文压缩策略实现
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from ..messages.message import Message


class MessagePriority(Enum):
    """消息优先级"""
    CRITICAL = 1.0    # 绝不压缩（系统提示、关键决策）
    HIGH = 0.8        # 尽量保留（工具调用、代码）
    NORMAL = 0.5      # 正常处理
    LOW = 0.3         # 优先压缩（寒暄、重复）
    TEMPORARY = 0.1   # 可直接丢弃（中间状态）


def get_message_priority(message: "Message") -> float:
    """
    获取消息的压缩优先级
    
    优先级越高的消息越应该保留
    
    Args:
        message: 消息对象
    
    Returns:
        优先级分数 (0.0 - 1.0)
    """
    # 检查是否设置了 temporary 标记
    if hasattr(message, 'temporary') and message.temporary:
        return MessagePriority.TEMPORARY.value
    
    # 检查是否设置了 priority
    if hasattr(message, 'priority') and message.priority:
        if isinstance(message.priority, MessagePriority):
            return message.priority.value
        return float(message.priority)
    
    # 自动评估优先级
    score = MessagePriority.NORMAL.value
    
    content = message.content or ""
    
    # 系统消息最重要
    if message.role == "system":
        return MessagePriority.CRITICAL.value
    
    # 工具调用/结果更重要
    if hasattr(message, 'tool_calls') and message.tool_calls:
        score = max(score, MessagePriority.HIGH.value)
    if hasattr(message, 'tool_call_id') and message.tool_call_id:
        score = max(score, MessagePriority.HIGH.value)
    
    # 包含代码更重要
    if "```" in content:
        score += 0.15
    
    # 包含关键词更重要
    keywords = ["重要", "关键", "注意", "TODO", "FIXME", "决定", "结论", "方案", "错误", "问题"]
    if any(kw in content for kw in keywords):
        score += 0.1
    
    return min(1.0, score)


class CompressionStrategy(ABC):
    """
    压缩策略基类
    
    所有压缩策略都应继承此类并实现 compress 方法
    """
    
    @property
    @abstractmethod
    def name(self) -> str:
        """策略名称"""
        pass
    
    @abstractmethod
    def compress(
        self, 
        messages: List["Message"],
        target_tokens: Optional[int] = None,
        model_id: str = "gpt-4"
    ) -> Tuple[List["Message"], Dict[str, Any]]:
        """
        执行压缩
        
        Args:
            messages: 消息列表
            target_tokens: 目标 Token 数（可选）
            model_id: 模型 ID
        
        Returns:
            (压缩后的消息列表, 压缩元数据)
        """
        pass


@dataclass
class SlidingWindowStrategy(CompressionStrategy):
    """
    滑动窗口策略
    
    保留最近 N 条消息，丢弃更早的消息。
    零额外成本，无 API 调用。
    
    Args:
        window_size: 保留的消息数量
        preserve_system: 是否保留系统消息
        preserve_tool_pairs: 是否保持工具调用配对完整
    """
    window_size: int = 10
    preserve_system: bool = True
    preserve_tool_pairs: bool = True
    
    @property
    def name(self) -> str:
        return "sliding_window"
    
    def compress(
        self, 
        messages: List["Message"],
        target_tokens: Optional[int] = None,
        model_id: str = "gpt-4"
    ) -> Tuple[List["Message"], Dict[str, Any]]:
        if len(messages) <= self.window_size:
            return messages, {"strategy": self.name, "compressed": False}
        
        result = []
        removed = 0
        
        # 保留系统消息
        system_msgs = []
        other_msgs = []
        for m in messages:
            if m.role == "system" and self.preserve_system:
                system_msgs.append(m)
            else:
                other_msgs.append(m)
        
        # 保留最近 N 条
        if len(other_msgs) > self.window_size:
            removed = len(other_msgs) - self.window_size
            other_msgs = other_msgs[-self.window_size:]
        
        # 如果需要保持工具调用配对
        if self.preserve_tool_pairs:
            other_msgs = self._fix_tool_pairs(other_msgs)
        
        result = system_msgs + other_msgs
        
        return result, {
            "strategy": self.name,
            "compressed": removed > 0,
            "removed_count": removed
        }
    
    def _fix_tool_pairs(self, messages: List["Message"]) -> List["Message"]:
        """修复断裂的工具调用配对"""
        # 收集工具调用 ID
        call_ids = set()
        result_ids = set()
        
        for m in messages:
            if hasattr(m, 'tool_calls') and m.tool_calls:
                for tc in m.tool_calls:
                    if isinstance(tc, dict) and 'id' in tc:
                        call_ids.add(tc['id'])
            if hasattr(m, 'tool_call_id') and m.tool_call_id:
                result_ids.add(m.tool_call_id)
        
        # 移除孤立的工具结果
        filtered = []
        for m in messages:
            if hasattr(m, 'tool_call_id') and m.tool_call_id:
                if m.tool_call_id in call_ids:
                    filtered.append(m)
                # 否则跳过（孤立结果）
            else:
                filtered.append(m)
        
        return filtered


@dataclass
class SummaryBufferStrategy(CompressionStrategy):
    """
    摘要缓冲混合策略（参考 LangChain ConversationSummaryBufferMemory）
    
    - 保留最近 N 条消息的原文
    - 将更早的消息压缩为摘要
    - 自动平衡精确上下文和历史信息
    
    Args:
        preserve_last: 保留最近几条消息的原文
        summarizer_model: 用于生成摘要的模型
        summary_prompt: 摘要生成提示（可自定义）
        fallback_to_sliding: 摘要失败时是否降级到滑动窗口
    """
    preserve_last: int = 5
    summarizer_model: str = "qwen-turbo"
    summary_prompt: Optional[str] = None
    fallback_to_sliding: bool = True
    
    @property
    def name(self) -> str:
        return "summary_buffer"
    
    def _get_default_prompt(self) -> str:
        return """请简明扼要地总结以下对话的关键信息：

{history}

总结要求：
1. 保留重要决策和结论
2. 保留关键数据和事实
3. 保留待办事项和进度
4. 保留工具调用的关键结果
5. 忽略寒暄和重复内容
6. 使用列表格式输出，不超过 500 字"""
    
    def compress(
        self, 
        messages: List["Message"],
        target_tokens: Optional[int] = None,
        model_id: str = "gpt-4"
    ) -> Tuple[List["Message"], Dict[str, Any]]:
        from ..messages.message import Message
        
        # 分离消息
        system_msgs = [m for m in messages if m.role == "system"]
        other_msgs = [m for m in messages if m.role != "system"]
        
        # 分离要摘要的和要保留的
        if len(other_msgs) <= self.preserve_last:
            return messages, {"strategy": self.name, "summarized": False}
        
        to_summarize = other_msgs[:-self.preserve_last]
        recent = other_msgs[-self.preserve_last:]
        
        # 格式化历史
        history = self._format_history(to_summarize)
        
        # 生成摘要（带错误处理）
        try:
            summary = self._generate_summary(history)
        except Exception as e:
            # 降级到滑动窗口
            if self.fallback_to_sliding:
                fallback = SlidingWindowStrategy(self.preserve_last)
                result, meta = fallback.compress(messages, target_tokens, model_id)
                meta["fallback"] = True
                meta["fallback_reason"] = str(e)
                return result, meta
            raise
        
        # 构建结果
        result = []
        
        # 保留原系统消息
        result.extend(system_msgs)
        
        # 添加摘要作为系统消息
        result.append(Message(
            role="system",
            content=f"[对话历史摘要]\n{summary}"
        ))
        
        # 添加最近消息
        result.extend(recent)
        
        from ..utils.tokens import TokenCounter
        
        return result, {
            "strategy": self.name,
            "summarized": True,
            "original_count": len(to_summarize),
            "summary_tokens": TokenCounter.count(summary, model_id)
        }
    
    def _format_history(self, messages: List["Message"]) -> str:
        """格式化历史消息"""
        lines = []
        for m in messages:
            content = m.content or ""
            # 截断过长内容
            if len(content) > 500:
                content = content[:500] + "..."
            
            # 包含工具信息
            role_display = m.role
            if hasattr(m, 'tool_call_id') and m.tool_call_id:
                role_display = f"tool_result({m.tool_name or 'unknown'})"
            
            lines.append(f"[{role_display}]: {content}")
        
        return "\n".join(lines)
    
    def _generate_summary(self, history: str) -> str:
        """使用 LLM 生成摘要"""
        from ..agent import Agent
        
        prompt = (self.summary_prompt or self._get_default_prompt()).format(history=history)
        
        summarizer = Agent(model=self.summarizer_model)
        result = summarizer.run(prompt)
        
        return result.content if hasattr(result, 'content') else str(result)


@dataclass
class PriorityBasedStrategy(CompressionStrategy):
    """
    基于优先级的压缩策略
    
    根据消息的重要性评分，优先移除低重要性消息
    
    Args:
        target_ratio: 目标压缩率 (0.0-1.0)
        min_priority: 最低保留优先级
        preserve_system: 是否保留系统消息
    """
    target_ratio: float = 0.7
    min_priority: float = 0.3
    preserve_system: bool = True
    
    @property
    def name(self) -> str:
        return "priority_based"
    
    def compress(
        self, 
        messages: List["Message"],
        target_tokens: Optional[int] = None,
        model_id: str = "gpt-4"
    ) -> Tuple[List["Message"], Dict[str, Any]]:
        from ..utils.tokens import TokenCounter
        
        if not messages:
            return messages, {"strategy": self.name, "compressed": False}
        
        # 分离系统消息
        system_msgs = []
        other_msgs = []
        for m in messages:
            if m.role == "system" and self.preserve_system:
                system_msgs.append(m)
            else:
                other_msgs.append(m)
        
        if not other_msgs:
            return messages, {"strategy": self.name, "compressed": False}
        
        # 计算每条消息的优先级
        scored = [(m, get_message_priority(m)) for m in other_msgs]
        scored.sort(key=lambda x: x[1], reverse=True)
        
        # 计算目标数量
        target_count = max(1, int(len(other_msgs) * self.target_ratio))
        
        if target_tokens:
            # 根据 Token 数调整
            current_tokens = TokenCounter.count_messages(messages, model_id)
            if current_tokens <= target_tokens:
                return messages, {"strategy": self.name, "compressed": False}
            
            # 逐步添加直到达到目标
            selected = []
            accumulated_tokens = TokenCounter.count_messages(system_msgs, model_id)
            
            for msg, priority in scored:
                msg_tokens = TokenCounter.count(msg.content or "", model_id) + 4
                if accumulated_tokens + msg_tokens <= target_tokens:
                    selected.append((msg, priority))
                    accumulated_tokens += msg_tokens
            
            # 按原始顺序排列
            original_order = {id(m): i for i, m in enumerate(other_msgs)}
            selected.sort(key=lambda x: original_order.get(id(x[0]), 0))
            other_msgs = [m for m, _ in selected]
        else:
            # 按优先级保留
            kept = [m for m, p in scored[:target_count] if p >= self.min_priority]
            
            # 按原始顺序排列
            original_order = {id(m): i for i, m in enumerate(other_msgs)}
            kept.sort(key=lambda x: original_order.get(id(x), 0))
            other_msgs = kept
        
        result = system_msgs + other_msgs
        removed = len(messages) - len(result)
        
        return result, {
            "strategy": self.name,
            "compressed": removed > 0,
            "removed_count": removed
        }
