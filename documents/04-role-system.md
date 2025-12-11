# Role 系统设计

本文档说明如何通过 Role 系统快速定制不同风格和能力的 Agent。

## 目录
- [设计目标](#设计目标)
- [核心概念](#核心概念)
- [Role 配置格式](#role-配置格式)
- [思考模式](#思考模式)
- [实现细节](#实现细节)
- [内置角色](#内置角色)
- [使用示例](#使用示例)

## 设计目标

### 为什么需要 Role 系统？

当前问题：
```python
# 每次都要重复配置
agent = Agent(
    model=Claude(id="claude-3-sonnet"),
    tools=[search, read_file, write_file],
    system_prompt="You are a research specialist...",
    max_iterations=10,
    thinking_mode="thorough"
)
```

理想情况：
```python
# 一行代码创建
agent = Agent.from_role("researcher")
```

### 核心优势

1. **配置复用**：常用 Agent 配置一次，到处使用
2. **快速原型**：快速创建不同类型的 Agent 进行实验
3. **标准化**：团队共享统一的 Agent 定义
4. **可扩展**：轻松添加新角色
5. **可组合**：Role 可以继承和组合

## 核心概念

### Role（角色）

Role 定义了 Agent 的：
- **身份**：是谁（研究员、编码员、测试员等）
- **能力**：能做什么（可用工具列表）
- **风格**：怎么做（思考模式、系统提示词）
- **配置**：运行参数（模型、最大迭代次数等）

### 角色继承

```
base_agent (基础角色)
  ├─ researcher (研究员)
  │   ├─ deep_researcher (深度研究员)
  │   └─ fast_researcher (快速研究员)
  │
  ├─ coder (编码员)
  │   ├─ backend_coder
  │   └─ frontend_coder
  │
  └─ coordinator (协调员)
```

### 思考模式

不同 Role 有不同的思考方式：

| 模式 | 适用场景 | 特点 |
|------|---------|------|
| **fast** | 简单任务，快速响应 | 直接输出，不显式思考 |
| **thorough** | 复杂推理，需要深思熟虑 | 每步都有 `<thinking>` |
| **structured** | 固定流程任务 | 按照固定模板思考 |
| **creative** | 创意任务 | 发散思维，多方案 |

## Role 配置格式

### YAML 格式（推荐）

```yaml
# roles/researcher.yaml
name: researcher
description: 专业的研究人员，擅长信息收集和分析

# 继承（可选）
extends: base_agent

# 模型配置
model:
  provider: openai
  id: gpt-4
  temperature: 0.7

# 系统提示词
system_prompt: |
  You are a professional researcher with expertise in information gathering and analysis.

  Your responsibilities:
  - Conduct thorough research on given topics
  - Synthesize information from multiple sources
  - Provide well-structured summaries
  - Cite sources when applicable

  Always be objective and fact-based.

# 可用工具
tools:
  - search_web
  - read_file
  - summarize_text
  - extract_keywords

# 思考模式
thinking_mode: thorough

# 执行配置
config:
  max_iterations: 10
  max_tool_calls: 20
  timeout: 300  # 秒
  enable_monitoring: true
  cache_responses: false

# 工具配置（覆盖默认配置）
tool_config:
  search_web:
    max_results: 10
    search_engine: google

  read_file:
    max_file_size: 1048576  # 1MB

# 输出格式（可选）
output_schema:
  type: object
  properties:
    summary:
      type: string
      description: Research summary
    sources:
      type: array
      items:
        type: string
    key_findings:
      type: array
      items:
        type: string

# 元数据
metadata:
  author: sakura-team
  version: 1.0.0
  tags: [research, information-gathering]
```

### JSON 格式（备选）

```json
{
  "name": "researcher",
  "model": {
    "provider": "openai",
    "id": "gpt-4"
  },
  "system_prompt": "You are a professional researcher...",
  "tools": ["search_web", "read_file"],
  "thinking_mode": "thorough",
  "config": {
    "max_iterations": 10
  }
}
```

### Python 代码格式（动态配置）

```python
from sakura.roles import Role, RoleConfig

researcher_role = Role(
    name="researcher",
    model={"provider": "openai", "id": "gpt-4"},
    system_prompt="You are a professional researcher...",
    tools=["search_web", "read_file"],
    thinking_mode="thorough",
    config=RoleConfig(max_iterations=10)
)
```

## 思考模式

### 1. Fast Mode（快速模式）

**特点**：直接输出，不显式思考

```python
thinking_mode: fast

# 效果
User: What is 2+2?
Assistant: 4
```

**适用场景**：
- 简单问答
- 数据查询
- 快速响应场景

### 2. Thorough Mode（深思熟虑模式）

**特点**：每个回复都包含思考过程

```python
thinking_mode: thorough

# 效果
User: What is the capital of France?
Assistant:
<thinking>
The user is asking about the capital of France. This is a straightforward factual question. The capital of France is Paris, which is one of the most well-known capitals in the world.
</thinking>

The capital of France is Paris.
```

**实现**：在系统提示词中强制加入思考要求

```python
if thinking_mode == "thorough":
    system_prompt += """

Always think through your response before answering:
1. Wrap your thinking in <thinking></thinking> tags
2. Consider multiple angles and possibilities
3. Then provide your final answer
"""
```

### 3. Structured Mode（结构化思考）

**特点**：按固定模板思考

```python
thinking_mode: structured
thinking_template: |
  <thinking>
  1. Understanding: [What is the user asking?]
  2. Analysis: [What information do I need?]
  3. Plan: [What steps should I take?]
  4. Execution: [Execute the plan]
  5. Verification: [Is the result correct?]
  </thinking>

# 效果
User: Write a function to check if a number is prime
Assistant:
<thinking>
1. Understanding: User wants a prime number checking function
2. Analysis: Need to check if n has any divisors besides 1 and itself
3. Plan:
   - Handle edge cases (n <= 1)
   - Check divisors from 2 to sqrt(n)
4. Execution: [writes code]
5. Verification: Test with 2, 3, 4, 5 - correct
</thinking>

[provides code]
```

### 4. Creative Mode（创意模式）

**特点**：鼓励发散思维，提供多个方案

```python
thinking_mode: creative
model:
  temperature: 1.0  # 更高的温度

system_prompt: |
  You are a creative thinker who explores multiple possibilities.

  When solving problems:
  - Consider unconventional approaches
  - Provide multiple alternative solutions
  - Think outside the box
```

## 实现细节

### RoleRegistry（角色注册表）

```python
class RoleRegistry:
    """全局角色注册表"""

    def __init__(self):
        self._roles: Dict[str, Role] = {}
        self._role_paths: Dict[str, Path] = {}

        # 加载内置角色
        self._load_builtin_roles()

    def register(self, role: Role):
        """注册角色"""
        self._roles[role.name] = role

    def get(self, name: str) -> Role:
        """获取角色"""
        if name not in self._roles:
            # 尝试从文件加载
            self._load_role_from_file(name)

        if name not in self._roles:
            raise ValueError(f"Role '{name}' not found")

        return self._roles[name]

    def list_roles(self) -> List[str]:
        """列出所有可用角色"""
        return list(self._roles.keys())

    def _load_builtin_roles(self):
        """加载内置角色"""
        builtin_dir = Path(__file__).parent / "builtin_roles"

        for role_file in builtin_dir.glob("*.yaml"):
            role = Role.from_yaml(role_file)
            self.register(role)

    def _load_role_from_file(self, name: str):
        """从文件加载角色"""
        # 搜索路径
        search_paths = [
            Path.cwd() / "roles",           # 项目本地
            Path.home() / ".sakura/roles",  # 用户目录
            Path(__file__).parent / "builtin_roles"  # 内置
        ]

        for search_path in search_paths:
            role_file = search_path / f"{name}.yaml"
            if role_file.exists():
                role = Role.from_yaml(role_file)
                self.register(role)
                return

# 全局单例
role_registry = RoleRegistry()
```

### Role 类

```python
from dataclasses import dataclass
from typing import Optional, List, Dict, Any

@dataclass
class RoleConfig:
    """角色运行配置"""
    max_iterations: int = 10
    max_tool_calls: int = 50
    timeout: Optional[int] = None
    enable_monitoring: bool = False
    cache_responses: bool = False

class Role:
    """角色定义"""

    def __init__(
        self,
        name: str,
        description: str = "",
        extends: Optional[str] = None,
        model: Dict[str, Any] = None,
        system_prompt: str = "",
        tools: List[str] = None,
        thinking_mode: str = "fast",
        config: Optional[RoleConfig] = None,
        tool_config: Dict[str, Dict] = None,
        output_schema: Optional[Dict] = None,
        metadata: Dict[str, Any] = None
    ):
        self.name = name
        self.description = description
        self.extends = extends
        self.model = model or {}
        self.system_prompt = system_prompt
        self.tools = tools or []
        self.thinking_mode = thinking_mode
        self.config = config or RoleConfig()
        self.tool_config = tool_config or {}
        self.output_schema = output_schema
        self.metadata = metadata or {}

    @classmethod
    def from_yaml(cls, path: Path) -> "Role":
        """从 YAML 文件加载"""
        import yaml

        with open(path) as f:
            data = yaml.safe_load(f)

        # 处理继承
        if "extends" in data:
            parent = role_registry.get(data["extends"])
            role = cls._merge_with_parent(parent, data)
        else:
            role = cls(**data)

        return role

    @classmethod
    def _merge_with_parent(cls, parent: "Role", data: Dict) -> "Role":
        """合并父角色配置"""
        merged = {
            "name": data["name"],
            "description": data.get("description", parent.description),
            "model": {**parent.model, **data.get("model", {})},
            "system_prompt": data.get("system_prompt", parent.system_prompt),
            "tools": data.get("tools", parent.tools.copy()),
            "thinking_mode": data.get("thinking_mode", parent.thinking_mode),
            "config": data.get("config", parent.config),
            "tool_config": {**parent.tool_config, **data.get("tool_config", {})},
            "output_schema": data.get("output_schema", parent.output_schema),
            "metadata": {**parent.metadata, **data.get("metadata", {})}
        }

        return cls(**merged)

    def to_dict(self) -> Dict:
        """转换为字典"""
        return {
            "name": self.name,
            "description": self.description,
            "model": self.model,
            "system_prompt": self.system_prompt,
            "tools": self.tools,
            "thinking_mode": self.thinking_mode,
            "config": self.config.__dict__,
            "tool_config": self.tool_config,
            "output_schema": self.output_schema,
            "metadata": self.metadata
        }
```

### Agent.from_role()

```python
class Agent:
    @classmethod
    def from_role(cls, role_name: str, **overrides) -> "Agent":
        """从角色创建 Agent"""
        from sakura.roles import role_registry

        # 获取角色配置
        role = role_registry.get(role_name)

        # 创建模型
        model = Model.from_dict(role.model)

        # 获取工具
        tools = [tool_registry.get(tool_name) for tool_name in role.tools]

        # 应用思考模式
        system_prompt = cls._apply_thinking_mode(
            role.system_prompt,
            role.thinking_mode
        )

        # 创建 Agent
        agent = cls(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            max_iterations=role.config.max_iterations,
            max_tool_calls=role.config.max_tool_calls,
            # 允许覆盖配置
            **overrides
        )

        agent.role_name = role_name
        agent.thinking_mode = role.thinking_mode

        return agent

    @staticmethod
    def _apply_thinking_mode(system_prompt: str, mode: str) -> str:
        """根据思考模式调整系统提示词"""
        if mode == "thorough":
            return system_prompt + """

IMPORTANT: Always think through your response step-by-step:
1. Wrap your reasoning in <thinking></thinking> tags
2. Consider the problem from multiple angles
3. Verify your logic before responding
4. Then provide your final answer outside the thinking tags
"""

        elif mode == "structured":
            return system_prompt + """

Use this thinking structure for every response:
<thinking>
1. Understanding: [What is being asked?]
2. Analysis: [What do I know? What do I need?]
3. Plan: [Step-by-step approach]
4. Execution: [Carry out the plan]
5. Verification: [Check the result]
</thinking>

Then provide your answer.
"""

        elif mode == "creative":
            return system_prompt + """

Approach problems creatively:
- Explore multiple solutions
- Think outside conventional patterns
- Consider unusual perspectives
- Provide alternative approaches
"""

        # fast mode: 不修改
        return system_prompt
```

## 内置角色

### 1. Researcher（研究员）

```yaml
name: researcher
description: 专业的信息研究员

model:
  provider: openai
  id: gpt-4-turbo

system_prompt: |
  You are a professional researcher specializing in information gathering and analysis.

  Your strengths:
  - Thorough research across multiple sources
  - Critical evaluation of information
  - Clear and structured summaries
  - Proper citation of sources

  Always be objective, fact-based, and comprehensive.

tools:
  - search_web
  - read_file
  - read_url
  - summarize_text

thinking_mode: thorough

config:
  max_iterations: 15
  max_tool_calls: 30
```

### 2. Coder（编码员）

```yaml
name: coder
description: 专业的软件工程师

model:
  provider: anthropic
  id: claude-3-5-sonnet

system_prompt: |
  You are an expert software engineer.

  Your principles:
  - Write clean, maintainable code
  - Follow best practices and design patterns
  - Add comments for complex logic
  - Consider edge cases
  - Write secure code

  Always test your code mentally before providing it.

tools:
  - read_file
  - write_file
  - search_code
  - run_command

thinking_mode: structured

config:
  max_iterations: 20
```

### 3. Tester（测试员）

```yaml
name: tester
description: 质量保证工程师

model:
  provider: openai
  id: gpt-4

system_prompt: |
  You are a QA engineer focused on comprehensive testing.

  Your responsibilities:
  - Write thorough unit tests
  - Consider edge cases and error conditions
  - Ensure good test coverage
  - Follow testing best practices

tools:
  - read_file
  - write_file
  - run_tests
  - analyze_coverage

thinking_mode: structured
```

### 4. Coordinator（协调员）

```yaml
name: coordinator
description: 任务协调和管理

model:
  provider: openai
  id: gpt-4

system_prompt: |
  You are a project coordinator who breaks down complex tasks.

  Your skills:
  - Task decomposition
  - Resource allocation
  - Progress tracking
  - Results aggregation

  Delegate tasks to specialized agents when appropriate.

tools:
  - spawn_agent      # 创建子 Agent
  - wait_for_agent   # 等待 Agent 完成
  - send_message     # Agent 间通信

thinking_mode: structured

config:
  max_iterations: 30
```

### 5. Planner（规划员）

```yaml
name: planner
description: 战略规划和设计

model:
  provider: anthropic
  id: claude-3-opus

system_prompt: |
  You are a strategic planner and architect.

  Your focus:
  - High-level design and architecture
  - Identifying dependencies and risks
  - Creating detailed implementation plans
  - Considering trade-offs and alternatives

tools:
  - read_file
  - search_code
  - analyze_dependencies

thinking_mode: thorough

config:
  max_iterations: 10
```

## 使用示例

### 基础使用

```python
from sakura import Agent

# 从角色创建 Agent
researcher = Agent.from_role("researcher")

# 使用
result = researcher.run("研究 Python 异步编程的最佳实践")
print(result.content)
```

### 覆盖配置

```python
# 使用 researcher 角色，但覆盖部分配置
agent = Agent.from_role(
    "researcher",
    model=Claude(id="claude-3-opus"),  # 使用不同的模型
    max_iterations=20,                  # 增加迭代次数
    system_prompt="额外的提示词"         # 追加提示词
)
```

### 创建自定义角色

```python
# 方式 1：通过 YAML
# 在 ./roles/my_role.yaml 创建配置文件
agent = Agent.from_role("my_role")

# 方式 2：通过代码
from sakura.roles import Role, role_registry

custom_role = Role(
    name="custom_analyzer",
    description="自定义分析器",
    model={"provider": "openai", "id": "gpt-4"},
    system_prompt="You are a custom analyzer...",
    tools=["analyze", "report"],
    thinking_mode="thorough"
)

role_registry.register(custom_role)

# 使用
agent = Agent.from_role("custom_analyzer")
```

### Multi-Agent 中使用 Role

```python
class ProjectCoordinator(MultiAgent):
    async def run_project(self, project_desc: str):
        # 使用不同角色的 Agent

        # 研究阶段
        research = await self.spawn_child(
            role="researcher",
            task=f"研究 {project_desc} 的技术方案"
        )

        # 规划阶段
        plan = await self.spawn_child(
            role="planner",
            task=f"基于研究制定实现计划：{research}"
        )

        # 编码阶段
        code = await self.spawn_child(
            role="coder",
            task=f"实现计划：{plan}"
        )

        # 测试阶段
        tests = await self.spawn_child(
            role="tester",
            task=f"为代码编写测试：{code}"
        )

        return {"research": research, "plan": plan, "code": code, "tests": tests}
```

### 角色继承

```python
# roles/senior_researcher.yaml
name: senior_researcher
extends: researcher  # 继承 researcher

# 覆盖部分配置
model:
  id: gpt-4-turbo  # 使用更强的模型

system_prompt: |
  You are a SENIOR researcher with 10+ years of experience.

  In addition to basic research skills, you also:
  - Critically evaluate source credibility
  - Identify gaps in existing research
  - Propose new research directions
  - Synthesize insights from multiple domains

config:
  max_iterations: 25  # 更多迭代
```

## 最佳实践

### 1. 角色命名

```python
# ✅ 好：清晰描述功能
researcher, coder, tester, coordinator

# ❌ 不好：模糊不清
agent1, helper, worker
```

### 2. 系统提示词

```python
# ✅ 好：具体、可操作
system_prompt: |
  You are a Python expert who:
  - Writes PEP 8 compliant code
  - Uses type hints
  - Adds docstrings for all functions
  - Handles errors gracefully

# ❌ 不好：模糊、无指导
system_prompt: "You are helpful"
```

### 3. 工具选择

```python
# ✅ 好：只包含必要工具
tools: [search_web, read_file, summarize]

# ❌ 不好：工具过多
tools: [tool1, tool2, ..., tool50]  # 太多，降低准确度
```

### 4. 思考模式选择

```python
# 简单任务 -> fast
simple_assistant = Agent.from_role("simple_assistant")  # thinking_mode: fast

# 复杂推理 -> thorough
researcher = Agent.from_role("researcher")  # thinking_mode: thorough

# 固定流程 -> structured
tester = Agent.from_role("tester")  # thinking_mode: structured
```

## 下一步

了解如何实现持续执行的自主 Agent：
- [自主 Agent 模式](./05-autonomous-agent.md)
