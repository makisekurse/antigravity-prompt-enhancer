# 提示词增强器 (Prompt Enhancer)

专为 Antigravity 打造的原生插件，在聊天输入框底部的**模型选择器正后方**内嵌一键「✨ 增强」胶囊按钮与「模型/风格选择」下拉菜单。

## 功能亮点

1. **原位内嵌，零侵入无冲突**：
   - 采用标准插件 + Sidecar 热注入机制，无需改动客户端 `app.asar` 主包，客户端升级不失效；
   - 与 `Antigrative Dashboard`（速率/缓存/上下文状态栏）100% 兼容并排显示。
2. **一键提示词增强 + 一键撤回**：
   - 点击 **「✨ 增强」**（或在输入框内按快捷键 `Alt + E`），自动读取当前输入框文本，交由所选大模型进行结构化改写增强，并无损写回 Lexical 富文本输入框；
   - 优化完成后右侧自动浮现 **「↩ 还原」** 按钮，点击即可瞬间恢复优化前的原始输入。
3. **自由选择优化所用大模型**：
   - 点击胶囊右侧的 **「· 模型名 ▾」** 即可打开配置弹窗，实时同步当前账号可用的全部模型：
     - `🔄 跟随当前对话模型`（自动匹配左侧模型选择器当前所选模型）
     - `⚡ Gemini 3.8 Flash (Low / Medium / High)`（默认极速推荐）
     - `🧠 Gemini 4 Argon (Low / Medium / High)`
     - `🎭 Claude Sonnet 5.5 (Low / Medium / High)`
     - `🏛️ Claude Opus 5.5 (Low / Medium / High)`
     - `🌐 GPT-OSS 120B (Medium)`
4. **五大优化模式预设**：
   - `🎯 通用增强`：补全目标背景、关键细节、执行步骤与交付标准；
   - `💻 代码研发`：强化架构边界、异常处理、工程规范与验证标准；
   - `📊 深度调研`：强化多维拆解、数据论据、对比维度与结构化排版；
   - `✍️ 精炼润色`：不扩写长篇，仅理顺逻辑、消除歧义、提升精准度；
   - `🛠️ 自定义`：支持编写并持久化保存专属的优化系统指令。

## 安装与管理

```powershell
# 安装并立即热启动
pwsh -File "D:\Gemini\05_运维工具\prompt-enhancer\install.ps1"

# 查看状态
python "D:\Gemini\05_运维工具\prompt-enhancer\manage.py" status

# 卸载插件
pwsh -File "D:\Gemini\05_运维工具\prompt-enhancer\uninstall.ps1"
```
