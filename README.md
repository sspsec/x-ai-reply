# Quick AI Reply for X.com

点击 X（Twitter）帖子下方的 **Reply**，或帖子操作栏里的 **AI** 按钮，扩展会根据帖子内容调用大模型自动生成一条回复并**填入回复输入框**，你确认无误后再点击发送。

> 说明：本扩展只负责「生成并预填」回复，最终发送由你本人确认完成，避免误发。

## 功能特性

- **一键 AI 回复**：读取推文正文 → 调用大模型 → 自动填入回复输入框
- **自动模式**：在时间线点击任意帖子的 `Reply`，自动开打回复框并生成回复（可在设置中关闭）
- **手动模式**：点击帖子操作栏里的 `AI` 按钮触发
- **可配置项**：
  - 模型服务商：DeepSeek / OpenAI / 自定义 OpenAI 兼容接口
  - API Key、接口地址、模型名称
  - 回复长度、回复语气（自动/幽默/商务/专业/休闲/对话）
  - 回复语言（自动/中文/英文/韩文/日文）
  - 默认系统提示词、推文截取字数上限
- **提示词管理**：保存多套系统提示词，随时切换
- **测试连接**：一键验证 API Key 是否可用

<img width="798" height="892" alt="image" src="https://github.com/user-attachments/assets/5e26c62d-9bd0-400b-9506-011b0f7fd634" />

<img width="307" height="705" alt="image" src="https://github.com/user-attachments/assets/b597c1e4-9bc2-470c-8a1d-f3f98fad5306" />


## 安装（开发者模式加载）

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车
2. 打开右上角的「**开发者模式**」开关
3. 点击「**加载已解压的扩展程序**」
4. 选择本项目文件夹 `x-ai-reply`
5. 加载成功后工具栏会出现扩展图标

## 配置

1. 点击扩展图标 → 「**打开设置**」（或在扩展详情页点击「扩展程序选项」）
2. 「通用设置」中选择模型（默认 **Deepseek Api**），填入对应的 **API Key**
   - DeepSeek Key 获取：<https://platform.deepseek.com/api_keys>
   - OpenAI Key 获取：<https://platform.openai.com/api-keys>
3. 「基础设置」中按需调整回复长度、语气、语言、系统提示词、推文截取上限
4. 点击「**测试连接**」确认可用，再点击「**保存设置**」

## 使用

1. 打开 <https://x.com/home> 或任意帖子页面
2. 在帖子操作栏（回复 / 转发 / 点赞 那一行）会多出一个蓝色的 **AI** 按钮
3. 两种触发方式：
   - **自动**：直接点击帖子原生的 **Reply** 按钮 → 扩展自动生成并填入回复
   - **手动**：点击 **AI** 按钮 → 自动打开回复框并填入
4. 检查生成的回复内容，确认后点击发送按钮发布

## 目录结构

```
x-ai-reply/
├── manifest.json              # MV3 清单
├── icons/                     # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background.js          # 后台 Service Worker，负责调用大模型接口
    ├── content.js             # 内容脚本，注入 AI 按钮、读取推文、填入回复
    ├── content.css            # 注入样式
    ├── settings/
    │   ├── settings.html      # 设置页
    │   ├── settings.js
    │   └── settings.css
    └── popup/
        ├── popup.html         # 工具栏弹窗
        └── popup.js
```

## 隐私说明

- API Key 保存在浏览器本地（`chrome.storage.sync`），不会上传到除你所选模型服务商以外的任何服务器。
- 请求直接从后台 Service Worker 发往你所配置的 API 地址，不经过任何第三方中转。

## 常见问题

- **点了 Reply 没有反应？** 请确认设置中「点击 Reply 时自动生成」为开启状态，并已正确填写 API Key。
- **提示「未找到回复输入框」？** 请先手动点击一次 Reply，待回复框出现后再点 AI 按钮。
- **生成失败/接口返回 401？** 通常是 API Key 无效或余额不足，请重新核对或更换 Key。
- **X 页面结构更新导致按钮不出现？** X 会不定期调整 DOM 结构，可关注后续版本更新。
