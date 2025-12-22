"""
Tests for SubAgent module
"""

import pytest
import tempfile
from pathlib import Path

from sakura.tools.subagent.config import SubAgentConfig, SubAgentConfigLoader, get_config_loader


class TestSubAgentConfig:
    """SubAgentConfig 单元测试"""
    
    def test_default_values(self):
        """测试默认值"""
        config = SubAgentConfig(name="test")
        
        assert config.name == "test"
        assert config.description == ""
        assert config.model == "qwen-plus"
        assert config.tools == []
        assert config.system_prompt == ""
        assert config.max_tokens == 4096
        assert config.temperature == 0.7
        assert config.timeout == 120.0
        assert config.max_tool_calls == 10
    
    def test_custom_values(self):
        """测试自定义值"""
        config = SubAgentConfig(
            name="researcher",
            description="专业研究员",
            model="gpt-4",
            tools=["search", "read_file"],
            system_prompt="你是研究员",
            max_tokens=8192,
            temperature=0.5,
            timeout=60.0,
            max_tool_calls=20
        )
        
        assert config.name == "researcher"
        assert config.description == "专业研究员"
        assert config.model == "gpt-4"
        assert config.tools == ["search", "read_file"]
        assert config.system_prompt == "你是研究员"
        assert config.max_tokens == 8192
        assert config.temperature == 0.5
        assert config.timeout == 60.0
        assert config.max_tool_calls == 20
    
    def test_from_markdown(self):
        """测试从 Markdown 加载"""
        markdown_content = """---
name: test_agent
description: 测试 Agent
model: qwen-turbo
tools: tool_a, tool_b
temperature: 0.8
max_tokens: 2048
---

# 系统提示

这是测试 Agent 的系统提示。
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
            f.write(markdown_content)
            temp_path = f.name
        
        try:
            config = SubAgentConfig.from_markdown(temp_path)
            
            assert config.name == "test_agent"
            assert config.description == "测试 Agent"
            assert config.model == "qwen-turbo"
            assert config.tools == ["tool_a", "tool_b"]
            assert "系统提示" in config.system_prompt
            assert config.temperature == 0.8
            assert config.max_tokens == 2048
        finally:
            Path(temp_path).unlink()
    
    def test_from_markdown_no_frontmatter(self):
        """测试无 frontmatter 的 Markdown"""
        markdown_content = """# 简单提示

这是一个没有 frontmatter 的配置文件。
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
            f.write(markdown_content)
            temp_path = f.name
        
        try:
            config = SubAgentConfig.from_markdown(temp_path)
            
            # 名称应该从文件名推断
            assert config.model == "qwen-plus"  # 默认值
            assert "简单提示" in config.system_prompt
        finally:
            Path(temp_path).unlink()
    
    def test_from_markdown_file_not_found(self):
        """测试文件不存在"""
        with pytest.raises(FileNotFoundError):
            SubAgentConfig.from_markdown("/nonexistent/path/config.md")
    
    def test_to_dict(self):
        """测试转换为字典"""
        config = SubAgentConfig(
            name="test",
            description="desc",
            model="model",
            tools=["t1", "t2"],
            system_prompt="prompt"
        )
        
        d = config.to_dict()
        
        assert d["name"] == "test"
        assert d["description"] == "desc"
        assert d["model"] == "model"
        assert d["tools"] == ["t1", "t2"]
        assert d["system_prompt"] == "prompt"


class TestSubAgentConfigLoader:
    """SubAgentConfigLoader 单元测试"""
    
    def test_load_builtin_configs(self):
        """测试加载内置配置"""
        loader = get_config_loader()
        
        # 测试加载 researcher 配置
        config = loader.load("researcher")
        
        if config:  # 如果找到了内置配置
            assert config.name == "researcher"
            assert "研究" in config.description or "research" in config.description.lower()
    
    def test_list_available(self):
        """测试列出可用配置"""
        loader = get_config_loader()
        available = loader.list_available()
        
        # 应该能列出配置（如果有的话）
        assert isinstance(available, list)
    
    def test_load_nonexistent(self):
        """测试加载不存在的配置"""
        loader = SubAgentConfigLoader()
        config = loader.load("nonexistent_config_xyz")
        
        assert config is None
    
    def test_cache(self):
        """测试缓存功能"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # 创建测试配置
            config_dir = Path(tmpdir)
            config_path = config_dir / "test_cache.md"
            config_path.write_text("""---
name: test_cache
model: test-model
---
Test prompt
""", encoding='utf-8')
            
            loader = SubAgentConfigLoader(search_paths=[config_dir])
            
            # 第一次加载
            config1 = loader.load("test_cache")
            assert config1 is not None
            assert config1.name == "test_cache"
            
            # 第二次加载应该使用缓存
            config2 = loader.load("test_cache")
            assert config2 is config1  # 同一个对象
            
            # 清除缓存后重新加载
            loader.clear_cache()
            config3 = loader.load("test_cache")
            assert config3 is not None
            assert config3 is not config1  # 不同对象
    
    def test_custom_search_path(self):
        """测试自定义搜索路径"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # 创建测试配置
            config_dir = Path(tmpdir)
            config_path = config_dir / "custom_agent.md"
            config_path.write_text("""---
name: custom_agent
description: 自定义 Agent
---
自定义系统提示
""", encoding='utf-8')
            
            loader = SubAgentConfigLoader(search_paths=[config_dir])
            config = loader.load("custom_agent")
            
            assert config is not None
            assert config.name == "custom_agent"
            assert config.description == "自定义 Agent"
    
    def test_add_search_path(self):
        """测试添加搜索路径"""
        loader = SubAgentConfigLoader(search_paths=[])
        
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_path = config_dir / "added_agent.md"
            config_path.write_text("""---
name: added_agent
---
Added
""", encoding='utf-8')
            
            # 添加搜索路径
            loader.add_search_path(config_dir)
            
            config = loader.load("added_agent")
            assert config is not None
            assert config.name == "added_agent"


class TestToolImports:
    """测试工具导入"""
    
    def test_import_subagent_module(self):
        """测试导入 subagent 模块"""
        from sakura.tools.subagent import SubAgentConfig, SubAgentConfigLoader
        
        assert SubAgentConfig is not None
        assert SubAgentConfigLoader is not None
    
    def test_import_tools(self):
        """测试导入工具函数"""
        from sakura.tools.subagent import subagent, create_subagent
        from sakura.tools.function import Function
        
        # subagent 是被 @tool 装饰的 Function 对象
        assert isinstance(subagent, Function)
        assert subagent.name == "subagent"
        
        # create_subagent 是普通函数
        assert callable(create_subagent)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
