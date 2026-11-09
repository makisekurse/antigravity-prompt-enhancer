---
name: prompt-enhancer
description: 管理与配置输入框模型选择器旁的「提示词增强器」插件。当用户需要调整提示词增强所用的默认大模型、新增优化风格预设、排查内嵌增强按钮状态或在对话中优化提示词时使用。
---

# 提示词增强器 (Prompt Enhancer)

本技能归属于 `prompt-enhancer` 插件，在客户端聊天输入框底部的**模型选择器正后方**提供内嵌式「✨ 增强」按钮与模型选择下拉菜单。

## 核心特性

1. **内嵌工具栏控件**：紧随模型选择器右侧，提供：
   - **左键点击「✨ 增强」**（或按快捷键 `Alt + E`）：读取输入框当前提示词，调用选定大模型改写增强后直接回填到输入框；
   - **点击「↩ 还原」**：一键恢复优化前的原始输入文本；
   - **点击右侧「▾ 模型与风格」**：自由选择使用哪个大模型进行提示词优化（支持跟随当前对话模型、Gemini 3.8 Flash、Gemini 4 Argon、Claude Sonnet/Opus 5.5、GPT-OSS 120B 等），以及切换「通用增强 / 代码研发 / 深度研究 / 精炼润色 / 自定义指令」五种模式。
2. **侧边栏配置面板**：可通过 `[提示词增强器](sidecar://prompt-enhancer/enhancer/)` 打开辅助面板查看历史优化记录与编辑自定义系统提示词。

## 运维与诊断命令

```powershell
# 安装或更新插件并热启动
python "D:\Gemini\05_运维工具\prompt-enhancer\manage.py" install

# 查看运行状态
python "D:\Gemini\05_运维工具\prompt-enhancer\manage.py" status
```
