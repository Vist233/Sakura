"""
Kimi 模型适配器

Moonshot Kimi - 继承 OpenAI 兼容实现
"""

from dataclasses import dataclass
from os import getenv
from typing import Any, Dict, Optional

from .openai_like import OpenAILike


@dataclass
class Kimi(OpenAILike):
    """
    Moonshot Kimi 模型
    
    Attributes:
        id (str): 模型 ID，默认 "kimi-k2"
        name (str): 模型名称
        provider (str): 提供商
        api_key (Optional[str]): API Key
        base_url (str): API 地址
    
    Usage:
        from sakura.models import Kimi
        
        model = Kimi(id="kimi-k2")
        # 或
        model = Kimi(id="moonshot-v1-8k")
    """
    
    id: str = "kimi-k2"
    name: str = "Kimi"
    provider: str = "Moonshot"
    
    api_key: Optional[str] = None
    base_url: str = "https://api.moonshot.cn/v1"
    
    def _get_client_params(self) -> Dict[str, Any]:
        """获取客户端参数"""
        if not self.api_key:
            self.api_key = getenv("MOONSHOT_API_KEY") or getenv("KIMI_API_KEY")
        
        return super()._get_client_params()
