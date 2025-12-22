# 工具定义最佳实践报告

> 基于 OpenAI Function Calling、Anthropic Tool Use、Parlant Guidelines 的深度分析

---

## 1. 核心发现

### 1.1 行业领袖的设计哲学

| 框架/平台 | 核心人物 | 关键洞察 |
|-----------|----------|----------|
| **Parlant** | Empower AI 团队 | Guidelines = Condition + Action，动态注入只相关的规则 |
| **OpenAI** | Sam Altman 团队 | 结构化 JSON 输出，多工具并行调用 |
| **Anthropic** | Dario Amodei 团队 | 简洁性优先，透明的规划步骤 |
| **LangChain** | Harrison Chase | 模块化 + LCEL 表达式语言 |
| **CrewAI** | João Moura | Role-based 协作，80% 任务设计 / 20% Agent 定义 |

### 1.2 description vs instructions 的区别

| 属性 | 用途 | 何时使用 |
|------|------|---------|
| `description` | 告诉 LLM "这个工具是什么" | 工具选择阶段 |
| `instructions` | 告诉 LLM "如何使用这个工具" | 执行阶段 |

**关键洞察**：OpenAI 官方指出 description 已足够用于大多数场景。instructions 应该演化为 **Parlant 风格的 Guidelines**。

---

## 2. Parlant Guidelines 模式详解

### 2.1 核心结构

```yaml
guideline:
  condition: "当客户询问退款时"
  action: "先检查订单状态是否符合退款条件"
  priority: high  # 可选
```

### 2.2 Guidelines 类型

| 类型 | 示例 |
|------|------|
| **行为规范** | "始终使用礼貌用语" |
| **业务规则** | "退款需要订单号" |
| **安全边界** | "禁止讨论政治话题" |
| **流程指导** | "先验证身份，再处理请求" |

### 2.3 动态注入机制

```python
# Parlant 的核心创新：只注入相关的 Guidelines
class GuidelineEngine:
    def get_relevant_guidelines(self, context: str) -> List[Guideline]:
        """根据上下文动态选择相关规则"""
        return [g for g in self.guidelines if g.matches_condition(context)]
```

---

## 3. 推荐架构变更

### 3.1 当前 Sakura 结构

```python
@dataclass
class Agent:
    system_prompt: str
    instructions: List[str]  # ← 简单字符串列表
```

### 3.2 推荐新结构

```python
@dataclass
class Guideline:
    """Parlant 风格的行为准则"""
    condition: str           # 触发条件
    action: str              # 执行动作
    priority: str = "medium"
    enabled: bool = True

@dataclass
class Agent:
    prompt: str              # 原 system_prompt（可考虑保留原名）
    guidelines: List[Guideline]  # 替代 instructions
    
    # 轮询模式：每轮对话动态选择相关 guidelines
    guideline_selection_mode: Literal["all", "dynamic"] = "all"
```

### 3.3 工具级别变更

```python
class Function(BaseModel):
    name: str
    prompt: str              # 原 description，更直观
    # instructions 移除，改用 guidelines
```

---

## 4. OpenAI/Anthropic 工具设计最佳实践

### 4.1 命名规范

```python
# ✅ 好的命名
"search_database"
"send_email"
"calculate_shipping_cost"

# ❌ 差的命名
"do_thing"
"helper_function"
"process"
```

### 4.2 参数描述

```python
# OpenAI 官方建议
{
    "name": "search_products",
    "description": "Search for products in the inventory database",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search keywords, e.g. 'red shoes size 10'"
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of results to return (1-100)",
                "default": 10
            }
        },
        "required": ["query"]
    }
}
```

### 4.3 Anthropic 强调的原则

1. **简化格式**：让模型容易理解
2. **提供示例**：展示边界情况
3. **明确输入/输出格式**
4. **有目的的工具选择**：避免 API 包装器
5. **思考命名空间**：减少歧义

---

## 5. Class-Based Agent 开发规范

### 5.1 推荐模式

```python
from sakura import Agent, Guideline
from sakura.tools import tool

class CustomerServiceAgent(Agent):
    """客服 Agent 示例"""
    
    # 类级别配置
    prompt = "你是一个专业的客服助手"
    
    guidelines = [
        Guideline(
            condition="客户情绪激动时",
            action="首先表示理解和歉意，然后再解决问题"
        ),
        Guideline(
            condition="涉及退款请求时",
            action="验证订单号后检查退款条件"
        ),
    ]
    
    # 类方法作为工具
    @tool
    def check_order_status(self, order_id: str) -> str:
        """查询订单状态"""
        return f"订单 {order_id} 状态：已发货"
    
    @tool
    def process_refund(self, order_id: str, reason: str) -> str:
        """处理退款请求"""
        return f"订单 {order_id} 退款已提交"
```

### 5.2 配置优先级

```
1. 实例配置 > 2. 类配置 > 3. 默认配置
```

### 5.3 生命周期钩子

```python
class MyAgent(Agent):
    def on_init(self):
        """初始化后调用"""
        pass
    
    def on_before_run(self, prompt: str):
        """运行前调用"""
        pass
    
    def on_after_run(self, response):
        """运行后调用"""
        pass
```

---

## 6. 移除 Team 模式的理由

### 当前问题

1. **复杂度增加**：Team 模式增加了代码复杂度
2. **使用率低**：大多数场景单 Agent 足够
3. **维护成本**：需要维护 Agent 间通信

### 替代方案

使用 **Workflow 编排** 替代 Team：

```python
# 推荐：显式的工作流编排
workflow = Workflow([
    ("research", research_agent),
    ("write", writing_agent),
    ("review", review_agent),
])
result = workflow.run("写一篇关于AI的文章")
```

---

## 7. 实施路线图

### Phase 1: 属性重命名（低风险）
- `description` → `prompt`
- 保持向后兼容（deprecation warning）

### Phase 2: Guidelines 系统（中风险）
- 实现 `Guideline` 数据类
- `instructions` → `guidelines`
- 支持动态选择

### Phase 3: Class-Based Agent 规范化（中风险）
- 支持类继承
- 生命周期钩子
- 类方法自动注册为工具

### Phase 4: 移除 Team 模式（高风险）
- 标记为 deprecated
- 下个大版本移除
- 提供迁移文档

---

## 参考资源

1. [Parlant Documentation](https://parlant.io)
2. [OpenAI Function Calling Best Practices](https://platform.openai.com/docs/guides/function-calling)
3. [Anthropic Tool Use Guide](https://docs.anthropic.com/claude/docs/tool-use)
4. [CrewAI Agent Design](https://docs.crewai.com)
5. [LangChain Best Practices](https://python.langchain.com/docs/concepts)
