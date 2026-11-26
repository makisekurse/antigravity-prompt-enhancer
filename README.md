# 提示词增强器 (Prompt Enhancer) v1.1

专为 Antigravity 打造的原生插件，在聊天输入框底部的**模型选择器正后方**内嵌一键「✨ 增强」幽灵胶囊按钮与「模型/风格选择」下拉菜单，视觉 100% 融入原生界面。

## 功能亮点

1. **原位内嵌，自适应折叠**：
   - 采用标准插件 + Sidecar 热注入机制，不修改客户端 `app.asar` 主包，软件升级不失效；
   - 基于 `requestAnimationFrame` 合帧调度 + `ResizeObserver` 窄屏自适应折叠，与 `Antigrative Dashboard` 零冲突共存。
2. **富文本 `@提及` 保护 + 多步撤销 / 重做**：
   - 点击 **「✨ 增强」**（或快捷键 `Alt + E`）自动读取输入框并保护 Lexical 中的 `@文件` / `/命令` 富文本 Mention 节点，增强回填不丢上下文绑定；
   - 优化期间点击按钮**真正中止后端 HTTP 请求**，不白白消耗模型额度；
   - 基于原生 Lexical `EditorState` 快照提供多步 **「↩ 还原 / ↪ 重做」** 对比切换，发送消息或清空输入框后 0 延迟自动清除历史栈。
3. **通用规则模型解析，零修改兼容全系新模型**：
   - 自动同步账号全部可用模型，完整支持 `Gemini 4 Neon / Carbon / Hydrogen / Argon`、`Orchestrator`、`Gemini 3.8 Flash`、`Claude Opus/Sonnet 5.5`、`GPT-OSS 120B` 及 `Low / Medium / High / XHigh` 全档位；
   - 词边界精确匹配，彻底杜绝 `XHigh` 被误路由为 `High`；支持 `🔄 跟随当前对话模型`。
4. **五大增强模式 + 侧边栏同步工作台**：
   - 内置 `🎯 通用增强`、`💻 代码研发`、`📊 深度调研`、`✍️ 精炼润色`（严格限制字数不扩写）及 `🛠️ 自定义指令`（防抖自动原子写盘）；
   - `<user_draft>` XML 标签边界隔离，防提示词注入串扰；
   - 侧边栏面板与内嵌按钮实时同步配置，支持在线测试、原文/增强对照、一键复制与清空历史。

## 安装、验证与管理

```powershell
# 安装并立即热启动
pwsh -File "D:\Gemini\05_运维工具\prompt-enhancer\install.ps1"

# 查看运行状态
python "D:\Gemini\05_运维工具\prompt-enhancer\manage.py" status

# 运行自动化单元测试
node --test "D:\Gemini\05_运维工具\prompt-enhancer\tests\enhancer.test.mjs"

# 卸载并自动清理页面控件
pwsh -File "D:\Gemini\05_运维工具\prompt-enhancer\uninstall.ps1"
```
