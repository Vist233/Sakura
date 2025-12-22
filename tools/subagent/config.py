"""
Sakura SubAgent Configuration - 子 Agent 配置

提供 SubAgent 配置定义和加载功能
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


@dataclass
class SubAgentConfig:
    """
    SubAgent 配置
    
    定义一个 SubAgent 的完整配置，包括：
    - 基本信息（名称、描述）
    - 模型设置（模型ID、温度、token限制）
    - 工具列表
    - 系统提示
    
    Attributes:
        name: SubAgent 名称
        description: 功能描述
        model: 使用的模型 ID
        tools: 可用工具列表
        system_prompt: 系统提示内容
        max_tokens: 最大输出 token 数
        temperature: 生成温度
        timeout: 执行超时时间（秒）
        max_tool_calls: 最大工具调用次数
    """
    name: str
    description: str = ""
    model: str = "qwen-plus"
    tools: List[str] = field(default_factory=list)
    system_prompt: str = ""
    max_tokens: int = 4096
    temperature: float = 0.7
    timeout: float = 120.0
    max_tool_calls: int = 10
    
    # 额外配置项
    extra: Dict[str, Any] = field(default_factory=dict)
    
    @classmethod
    def from_markdown(cls, path: str) -> "SubAgentConfig":
        """
        从 Markdown 文件加载配置
        
        Markdown 格式：
        ```
        ---
        name: researcher
        description: 专业研究员
        model: qwen-plus
        tools: search_web, read_file
        ---
        
        # 系统提示内容
        你是一位资深研究员...
        ```
        
        Args:
            path: Markdown 文件路径
        
        Returns:
            SubAgentConfig 实例
        
        Raises:
            FileNotFoundError: 文件不存在
            ValueError: 配置格式错误
        """
        file_path = Path(path)
        if not file_path.exists():
            raise FileNotFoundError(f"配置文件不存在: {path}")
        
        content = file_path.read_text(encoding='utf-8')
        
        # 解析 YAML frontmatter
        frontmatter_pattern = r'^---\s*\n(.*?)\n---\s*\n'
        frontmatter_match = re.match(frontmatter_pattern, content, re.DOTALL)
        
        if frontmatter_match:
            frontmatter_text = frontmatter_match.group(1)
            body = content[frontmatter_match.end():].strip()
            
            # 解析 YAML
            if HAS_YAML:
                try:
                    frontmatter = yaml.safe_load(frontmatter_text) or {}
                except yaml.YAMLError as e:
                    raise ValueError(f"YAML 解析错误: {e}")
            else:
                # 简单解析（无 yaml 库时的后备方案）
                frontmatter = cls._parse_simple_yaml(frontmatter_text)
        else:
            frontmatter = {}
            body = content.strip()
        
        # 解析 tools（逗号分隔字符串 → 列表）
        tools_value = frontmatter.get("tools", [])
        if isinstance(tools_value, str):
            tools = [t.strip() for t in tools_value.split(",") if t.strip()]
        elif isinstance(tools_value, list):
            tools = tools_value
        else:
            tools = []
        
        # 提取已知字段
        known_fields = {
            "name", "description", "model", "tools",
            "max_tokens", "temperature", "timeout", "max_tool_calls"
        }
        extra = {k: v for k, v in frontmatter.items() if k not in known_fields}
        
        return cls(
            name=frontmatter.get("name", file_path.stem),
            description=frontmatter.get("description", ""),
            model=frontmatter.get("model", "qwen-plus"),
            tools=tools,
            system_prompt=body,
            max_tokens=frontmatter.get("max_tokens", 4096),
            temperature=frontmatter.get("temperature", 0.7),
            timeout=frontmatter.get("timeout", 120.0),
            max_tool_calls=frontmatter.get("max_tool_calls", 10),
            extra=extra
        )
    
    @staticmethod
    def _parse_simple_yaml(text: str) -> Dict[str, Any]:
        """简单 YAML 解析（后备方案）"""
        result = {}
        for line in text.strip().split('\n'):
            if ':' in line:
                key, value = line.split(':', 1)
                key = key.strip()
                value = value.strip()
                # 简单类型转换
                if value.lower() == 'true':
                    value = True
                elif value.lower() == 'false':
                    value = False
                elif value.isdigit():
                    value = int(value)
                else:
                    try:
                        value = float(value)
                    except ValueError:
                        pass
                result[key] = value
        return result
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "name": self.name,
            "description": self.description,
            "model": self.model,
            "tools": self.tools,
            "system_prompt": self.system_prompt,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "timeout": self.timeout,
            "max_tool_calls": self.max_tool_calls,
            "extra": self.extra
        }


class SubAgentConfigLoader:
    """
    SubAgent 配置加载器
    
    提供配置文件搜索、加载和缓存功能
    
    搜索顺序：
    1. 当前工作目录下的 subagent/configs/ 目录
    2. Sakura 包内置的 subagent/configs/ 目录
    
    Example:
        loader = SubAgentConfigLoader()
        config = loader.load("researcher")
        if config:
            print(f"Loaded: {config.name}")
    """
    
    def __init__(self, search_paths: Optional[List[Path]] = None):
        """
        初始化加载器
        
        Args:
            search_paths: 自定义搜索路径列表
        """
        self._cache: Dict[str, SubAgentConfig] = {}
        
        if search_paths:
            self._search_paths = [Path(p) for p in search_paths]
        else:
            self._search_paths = [
                Path.cwd() / "subagent" / "configs",  # 当前目录
                Path(__file__).parent / "configs",    # 包内置
            ]
    
    def add_search_path(self, path: Path) -> None:
        """添加搜索路径（优先级最高）"""
        self._search_paths.insert(0, Path(path))
    
    def load(self, config_name: str) -> Optional[SubAgentConfig]:
        """
        加载配置（优先使用缓存）
        
        Args:
            config_name: 配置名称（不含 .md 后缀）
        
        Returns:
            SubAgentConfig 实例，未找到时返回 None
        """
        # 检查缓存
        if config_name in self._cache:
            return self._cache[config_name]
        
        # 搜索配置文件
        for base_path in self._search_paths:
            # 尝试不同的文件名格式
            for filename in [f"{config_name}.md", f"{config_name.replace('-', '_')}.md"]:
                config_path = base_path / filename
                if config_path.exists():
                    try:
                        config = SubAgentConfig.from_markdown(str(config_path))
                        self._cache[config_name] = config
                        return config
                    except Exception:
                        # 解析失败，尝试下一个
                        continue
        
        return None
    
    def load_all(self) -> Dict[str, SubAgentConfig]:
        """
        加载所有可用配置
        
        Returns:
            配置名称到配置对象的映射
        """
        configs = {}
        
        for base_path in self._search_paths:
            if not base_path.exists():
                continue
            
            for config_path in base_path.glob("*.md"):
                config_name = config_path.stem
                if config_name not in configs:
                    config = self.load(config_name)
                    if config:
                        configs[config_name] = config
        
        return configs
    
    def list_available(self) -> List[str]:
        """列出所有可用配置名称"""
        names = set()
        
        for base_path in self._search_paths:
            if base_path.exists():
                for config_path in base_path.glob("*.md"):
                    names.add(config_path.stem)
        
        return sorted(names)
    
    def clear_cache(self) -> None:
        """清除缓存"""
        self._cache.clear()
    
    def reload(self, config_name: str) -> Optional[SubAgentConfig]:
        """强制重新加载配置"""
        if config_name in self._cache:
            del self._cache[config_name]
        return self.load(config_name)


# 全局配置加载器实例
_default_loader: Optional[SubAgentConfigLoader] = None


def get_config_loader() -> SubAgentConfigLoader:
    """获取默认配置加载器"""
    global _default_loader
    if _default_loader is None:
        _default_loader = SubAgentConfigLoader()
    return _default_loader
