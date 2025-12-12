"""
Sakura Token Utilities - Token 计数工具

提供精确的 Token 计数功能，支持多种模型
"""

from typing import List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..messages.message import Message

# 尝试导入 tiktoken
try:
    import tiktoken
    HAS_TIKTOKEN = True
except ImportError:
    HAS_TIKTOKEN = False


class TokenCounter:
    """
    精确 Token 计数器
    
    使用 tiktoken 提供精确的 Token 计数，支持多种模型。
    如果 tiktoken 不可用，则使用启发式估算。
    
    Example:
        # 单条文本计数
        count = TokenCounter.count("Hello, world!", "gpt-4")
        
        # 消息列表计数
        messages = [Message(role="user", content="Hi")]
        count = TokenCounter.count_messages(messages, "gpt-4")
    """
    
    # 模型编码映射
    _encoding_map = {
        "gpt-4": "cl100k_base",
        "gpt-3.5": "cl100k_base",
        "gpt-4o": "o200k_base",
        "claude": "cl100k_base",     # Claude 接近 cl100k
        "qwen": "cl100k_base",       # 通义千问接近 cl100k
        "moonshot": "cl100k_base",   # Kimi 接近 cl100k
        "deepseek": "cl100k_base",
    }
    
    # 编码器缓存
    _cache: dict = {}
    
    @classmethod
    def get_encoding(cls, model_id: str) -> Optional["tiktoken.Encoding"]:
        """
        获取模型对应的编码器（带缓存）
        
        Args:
            model_id: 模型 ID
        
        Returns:
            tiktoken.Encoding 实例，如果 tiktoken 不可用则返回 None
        """
        if not HAS_TIKTOKEN:
            return None
        
        # 检查缓存
        if model_id in cls._cache:
            return cls._cache[model_id]
        
        # 尝试直接获取
        try:
            enc = tiktoken.encoding_for_model(model_id)
            cls._cache[model_id] = enc
            return enc
        except KeyError:
            pass
        
        # 根据模型前缀选择编码
        model_lower = model_id.lower()
        for prefix, encoding_name in cls._encoding_map.items():
            if prefix in model_lower:
                try:
                    enc = tiktoken.get_encoding(encoding_name)
                    cls._cache[model_id] = enc
                    return enc
                except Exception:
                    break
        
        # 使用默认编码
        try:
            enc = tiktoken.get_encoding("cl100k_base")
            cls._cache[model_id] = enc
            return enc
        except Exception:
            return None
    
    @classmethod
    def count(cls, text: str, model_id: str = "gpt-4") -> int:
        """
        计算文本的 Token 数
        
        Args:
            text: 要计算的文本
            model_id: 模型 ID
        
        Returns:
            Token 数量
        """
        if not text:
            return 0
        
        enc = cls.get_encoding(model_id)
        if enc:
            return len(enc.encode(text))
        
        # 后备：启发式估算
        return cls._estimate_tokens(text)
    
    @classmethod
    def count_messages(
        cls, 
        messages: List["Message"], 
        model_id: str = "gpt-4"
    ) -> int:
        """
        计算消息列表的总 Token 数
        
        包括消息格式开销（role、分隔符等）
        
        Args:
            messages: 消息列表
            model_id: 模型 ID
        
        Returns:
            总 Token 数
        """
        total = 0
        
        for m in messages:
            # 消息格式开销（不同模型略有差异）
            # OpenAI: 每条消息约 4 tokens 开销
            total += 4
            
            # 内容 Token
            total += cls.count(m.content or "", model_id)
            
            # 角色名（如果有）
            if hasattr(m, 'name') and m.name:
                total += cls.count(m.name, model_id) + 1
            
            # 工具调用（如果有）
            if hasattr(m, 'tool_calls') and m.tool_calls:
                import json
                for tc in m.tool_calls:
                    if isinstance(tc, dict):
                        total += cls.count(json.dumps(tc), model_id)
        
        # 对话起止标记
        total += 3
        
        return total
    
    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """
        启发式 Token 估算（无 tiktoken 时的后备方案）
        
        估算规则：
        - 英文：约 1 token / 4 字符
        - 中文：约 2 tokens / 字符
        - 混合：加权平均
        """
        if not text:
            return 0
        
        # 统计中英文字符
        chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
        other_chars = len(text) - chinese_chars
        
        # 估算
        estimated = (chinese_chars * 2) + (other_chars / 4)
        return max(1, int(estimated))
    
    @classmethod
    def truncate_to_tokens(
        cls, 
        text: str, 
        max_tokens: int, 
        model_id: str = "gpt-4",
        suffix: str = "..."
    ) -> str:
        """
        将文本截断到指定 Token 数
        
        Args:
            text: 原始文本
            max_tokens: 最大 Token 数
            model_id: 模型 ID
            suffix: 截断后缀
        
        Returns:
            截断后的文本
        """
        if not text:
            return text
        
        current_tokens = cls.count(text, model_id)
        if current_tokens <= max_tokens:
            return text
        
        enc = cls.get_encoding(model_id)
        if enc:
            # 精确截断
            suffix_tokens = cls.count(suffix, model_id) if suffix else 0
            target_tokens = max_tokens - suffix_tokens
            
            if target_tokens <= 0:
                return suffix
            
            tokens = enc.encode(text)[:target_tokens]
            truncated = enc.decode(tokens)
            return truncated + suffix
        
        # 后备：按比例估算截断位置
        ratio = max_tokens / current_tokens
        cut_pos = int(len(text) * ratio * 0.9)  # 留一些余量
        return text[:cut_pos] + suffix


# 模型上下文窗口大小
CONTEXT_WINDOWS = {
    # OpenAI
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-4": 8192,
    "gpt-3.5-turbo": 16385,
    
    # Anthropic
    "claude-3-5-sonnet": 200000,
    "claude-3-5-haiku": 200000,
    "claude-3-opus": 200000,
    "claude-3-sonnet": 200000,
    
    # Qwen
    "qwen-plus": 131072,
    "qwen-turbo": 131072,
    "qwen-max": 32768,
    "qwen-long": 1000000,
    
    # Kimi
    "moonshot-v1-8k": 8192,
    "moonshot-v1-32k": 32768,
    "moonshot-v1-128k": 131072,
    
    # DeepSeek
    "deepseek-chat": 65536,
    "deepseek-coder": 65536,
}

# 有效窗口（实际性能稳定的窗口大小，比声称的小）
EFFECTIVE_WINDOWS = {
    "gpt-4o": 32000,
    "gpt-4o-mini": 32000,
    "gpt-4-turbo": 32000,
    "claude-3-5-sonnet": 50000,
    "claude-3-5-haiku": 50000,
    "qwen-plus": 32000,
    "qwen-turbo": 32000,
    "qwen-max": 24000,
}


def get_context_window(model_id: str, effective: bool = True) -> int:
    """
    获取模型的上下文窗口大小
    
    Args:
        model_id: 模型 ID
        effective: 是否返回有效窗口（推荐）
    
    Returns:
        窗口大小（Token 数）
    """
    windows = EFFECTIVE_WINDOWS if effective else CONTEXT_WINDOWS
    model_lower = model_id.lower()
    
    for key, size in windows.items():
        if key in model_lower:
            return size
    
    # 默认返回保守值
    return 32000 if effective else 128000
