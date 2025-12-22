# M3 Air 本地 LLM 使用指南

## 推荐模型列表（按内存排序）

### 8GB 内存配置

| 模型 | 大小 | 速度 | 质量 | 用途 |
|------|------|------|------|------|
| **Qwen2.5:3b** | 2.0GB | ⚡⚡⚡⚡⚡ | ⭐⭐⭐ | 快速问答、代码补全 |
| **Llama3.2:3b** | 2.0GB | ⚡⚡⚡⚡⚡ | ⭐⭐⭐ | 通用对话 |
| **Phi3:mini** | 2.3GB | ⚡⚡⚡⚡⚡ | ⭐⭐⭐⭐ | 推理、数学 |
| **Gemma2:2b** | 1.6GB | ⚡⚡⚡⚡⚡ | ⭐⭐⭐ | 轻量级任务 |

### 16GB 内存配置

| 模型 | 大小 | 速度 | 质量 | 用途 |
|------|------|------|------|------|
| **Qwen2.5:7b** | 4.7GB | ⚡⚡⚡⚡ | ⭐⭐⭐⭐ | **推荐** 通用场景 |
| **Llama3.1:8b** | 4.7GB | ⚡⚡⚡⚡ | ⭐⭐⭐⭐ | 通用对话、代码 |
| **Mistral:7b** | 4.1GB | ⚡⚡⚡⚡ | ⭐⭐⭐⭐ | 快速推理 |
| **DeepSeek-Coder:6.7b** | 3.8GB | ⚡⚡⚡⚡ | ⭐⭐⭐⭐⭐ | 专业代码生成 |
| **CodeLlama:7b** | 3.8GB | ⚡⚡⚡⚡ | ⭐⭐⭐⭐ | 代码理解 |

### 24GB+ 内存配置

| 模型 | 大小 | 速度 | 质量 | 用途 |
|------|------|------|------|------|
| **Qwen2.5:14b** | 9.0GB | ⚡⚡⚡ | ⭐⭐⭐⭐⭐ | 高质量输出 |
| **Llama3.1:70b** | 40GB | ⚡ | ⭐⭐⭐⭐⭐ | 接近 GPT-4 |

---

## 快速开始

### 1. 安装 Ollama

```bash
# 下载安装
# https://ollama.com/download

# 或使用 Homebrew
brew install ollama
```

### 2. 启动 Ollama 服务

```bash
# 启动服务（后台运行）
ollama serve

# 或者：Ollama app 会自动启动服务
```

### 3. 下载模型

```bash
# 推荐：Qwen2.5 7B（16GB 内存）
ollama pull qwen2.5:7b

# 或者：Qwen2.5 3B（8GB 内存）
ollama pull qwen2.5:3b

# 代码专用：DeepSeek Coder
ollama pull deepseek-coder:6.7b

# 快速测试：Phi3 Mini
ollama pull phi3:mini
```

### 4. 测试模型

```bash
# 命令行交互
ollama run qwen2.5:7b

# 提问
>>> 你好，请介绍一下你自己
>>> 写一个 Python 快速排序
```

---

## 在 Sakura 中使用本地模型

### 方式 1：OpenAI 兼容 API（推荐）

```python
from sakura import Agent
from sakura.models import OpenAIChat

# Ollama 提供 OpenAI 兼容接口
agent = Agent(
    model=OpenAIChat(
        id="qwen2.5:7b",
        api_key="ollama",  # 随便填
        base_url="http://localhost:11434/v1"  # Ollama 默认端口
    ),
    tools=[...],
    system_prompt="你是一个助手"
)

response = agent.run("你好")
print(response.content)
```

### 方式 2：使用 OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="ollama",
    base_url="http://localhost:11434/v1"
)

response = client.chat.completions.create(
    model="qwen2.5:7b",
    messages=[
        {"role": "user", "content": "你好"}
    ]
)

print(response.choices[0].message.content)
```

### 方式 3：使用 Ollama Python 库

```bash
pip install ollama
```

```python
import ollama

response = ollama.chat(
    model="qwen2.5:7b",
    messages=[
        {"role": "user", "content": "你好"}
    ]
)

print(response['message']['content'])
```

---

## 完整示例：本地 Agent

### example_local_agent.py

```python
"""
使用本地 Ollama 模型的 Sakura Agent 示例
"""
from sakura import Agent, tool
from sakura.models import OpenAIChat

# 定义工具
@tool
def get_weather(city: str) -> str:
    """获取指定城市的天气"""
    # 模拟天气数据
    weather_data = {
        "北京": "晴天，25度",
        "上海": "多云，22度",
        "深圳": "小雨，28度"
    }
    return weather_data.get(city, f"{city}天气未知")

@tool
def calculate(expression: str) -> str:
    """计算数学表达式"""
    try:
        result = eval(expression)
        return f"{expression} = {result}"
    except Exception as e:
        return f"计算错误: {str(e)}"

# 创建 Agent（使用本地 Qwen2.5）
agent = Agent(
    model=OpenAIChat(
        id="qwen2.5:7b",
        api_key="ollama",
        base_url="http://localhost:11434/v1"
    ),
    tools=[get_weather, calculate],
    system_prompt="你是一个有用的助手，可以查询天气和进行计算。"
)

# 测试
if __name__ == "__main__":
    # 测试 1：天气查询
    print("=== 测试 1：天气查询 ===")
    response = agent.run("北京今天天气怎么样？")
    print(response.content)
    print()

    # 测试 2：计算
    print("=== 测试 2：数学计算 ===")
    response = agent.run("计算 123 * 456")
    print(response.content)
    print()

    # 测试 3：组合任务
    print("=== 测试 3：组合任务 ===")
    response = agent.run("告诉我北京和上海的天气，然后计算它们温度的平均值")
    print(response.content)
```

---

## 性能对比

### M3 Air 8GB 内存

| 模型 | 首次响应 | 后续响应 | Token/秒 | 内存占用 |
|------|----------|----------|----------|----------|
| qwen2.5:3b | ~1s | ~0.5s | 60-80 | 2.5GB |
| phi3:mini | ~1s | ~0.5s | 50-70 | 2.8GB |
| gemma2:2b | ~0.8s | ~0.4s | 80-100 | 2.0GB |

### M3 Air 16GB 内存

| 模型 | 首次响应 | 后续响应 | Token/秒 | 内存占用 |
|------|----------|----------|----------|----------|
| qwen2.5:7b | ~1.5s | ~0.8s | 40-60 | 5.5GB |
| llama3.1:8b | ~1.5s | ~0.8s | 35-50 | 5.5GB |
| deepseek-coder:6.7b | ~1.2s | ~0.7s | 45-60 | 4.5GB |

---

## 实际应用场景

### 1. 代码助手

```python
from sakura import Agent, tool
from sakura.models import OpenAIChat

@tool
def read_file(path: str) -> str:
    """读取文件内容"""
    try:
        with open(path) as f:
            return f.read()
    except Exception as e:
        return f"错误: {str(e)}"

@tool
def write_file(path: str, content: str) -> str:
    """写入文件"""
    try:
        with open(path, 'w') as f:
            f.write(content)
        return f"已写入 {path}"
    except Exception as e:
        return f"错误: {str(e)}"

# 代码助手 Agent
code_agent = Agent(
    model=OpenAIChat(
        id="deepseek-coder:6.7b",  # 专门的代码模型
        api_key="ollama",
        base_url="http://localhost:11434/v1"
    ),
    tools=[read_file, write_file],
    system_prompt="""你是一个代码助手，擅长：
    - 阅读和分析代码
    - 编写高质量代码
    - 修复 bug
    - 代码重构
    """
)

# 使用
response = code_agent.run("读取 main.py，找出所有函数并添加文档字符串")
```

### 2. 文档问答

```python
@tool
def search_docs(query: str) -> str:
    """搜索文档"""
    # 实现文档搜索逻辑
    pass

docs_agent = Agent(
    model=OpenAIChat(
        id="qwen2.5:7b",
        api_key="ollama",
        base_url="http://localhost:11434/v1"
    ),
    tools=[search_docs],
    system_prompt="你是文档助手，帮助用户查找和理解文档。"
)
```

### 3. 数据分析

```python
@tool
def query_database(sql: str) -> str:
    """执行 SQL 查询"""
    # 实现数据库查询
    pass

@tool
def plot_chart(data: dict, chart_type: str) -> str:
    """绘制图表"""
    # 实现图表绘制
    pass

data_agent = Agent(
    model=OpenAIChat(
        id="qwen2.5:7b",
        api_key="ollama",
        base_url="http://localhost:11434/v1"
    ),
    tools=[query_database, plot_chart],
    system_prompt="你是数据分析师，擅长 SQL 和数据可视化。"
)
```

---

## 优化技巧

### 1. 模型量化

```bash
# 下载量化版本（更快，质量略降）
ollama pull qwen2.5:7b-q4_0  # 4-bit 量化
ollama pull qwen2.5:7b-q8_0  # 8-bit 量化
```

### 2. 批量处理

```python
# 预加载模型
import ollama
ollama.chat(model="qwen2.5:7b", messages=[{"role": "user", "content": "hi"}])

# 之后的请求会更快
```

### 3. 设置上下文长度

```python
agent = Agent(
    model=OpenAIChat(
        id="qwen2.5:7b",
        api_key="ollama",
        base_url="http://localhost:11434/v1",
        max_tokens=2048,  # 限制输出长度
    ),
    # ...
)
```

---

## 常见问题

### Q: Ollama 占用内存太多？

**A:** 调整模型上下文长度

```bash
# 启动时设置
OLLAMA_MAX_LOADED_MODELS=1 ollama serve

# 或使用较小的模型
ollama pull qwen2.5:3b
```

### Q: 如何查看已安装的模型？

```bash
ollama list
```

### Q: 如何删除模型？

```bash
ollama rm qwen2.5:7b
```

### Q: 速度太慢？

**A:**
1. 使用量化版本：`qwen2.5:7b-q4_0`
2. 降低上下文长度
3. 使用更小的模型：`qwen2.5:3b`

---

## 总结

### M3 Air 8GB 推荐

```bash
ollama pull qwen2.5:3b      # 通用
ollama pull phi3:mini       # 推理
```

### M3 Air 16GB 推荐（最佳）

```bash
ollama pull qwen2.5:7b           # 通用 ⭐
ollama pull deepseek-coder:6.7b  # 代码 ⭐
```

### 在 Sakura 中使用

```python
from sakura import Agent
from sakura.models import OpenAIChat

agent = Agent(
    model=OpenAIChat(
        id="qwen2.5:7b",
        api_key="ollama",
        base_url="http://localhost:11434/v1"
    ),
    tools=[...],
)
```

**优势：**
- ✅ 完全本地，数据隐私
- ✅ 无 API 费用
- ✅ 响应速度快
- ✅ 可离线使用
