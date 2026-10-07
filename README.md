# Hi, AI — The AI Morning Post

每天早上八点自动出版一期的 AI 领域晨报，部署在 2AIGC Pages：**https://ai-morning-post.pages.2aigc.space/**

一份由 AI 标记筛选的中文晨报，用传统报刊版式呈现：印章 logo、大字号英文报头、大字号头条配题图与首字下沉、「本期数字」统计栏、带缩略图的双栏简讯，按八个版块排印：

**要闻 / 研究前沿 / 产品与发布 / Agent 动态 / 开源与社区 / 行业与资本 / 社区热议 / 观点与随笔**

每期存档可回看，头版底部有往期目录。

## 内容来源

- **中文**：量子位、雷峰网、爱范儿、Solidot（要闻）；少数派（产品与发布）；InfoQ 中文（开源与社区）
- **英文（自动翻译为中文）**：ArsTechnica AI、arXiv API（研究前沿）；OpenAI News、The Verge AI、TechCrunch AI（产品与发布）；GitHub API（开源与社区）；Hacker News 高分帖（社区热议）；Simon Willison、MIT Tech Review（观点与随笔）
- 标题含融资/收购/上市/估值等关键词的条目，跨源自动归入「行业与资本」
- 标题提到 Claude Code、ChatGPT、Codex、ZCode、Trae、Qoder、WorkBuddy、Cursor、Copilot 等主流 Agent 产品的条目，自动归入「Agent 动态」
- 题图从 feed 的 media/enclosure/正文首图提取，GitHub 仓库使用组织头像；无图条目保持纯文字

## 工作方式

```
feeds.json          源配置（RSS / arXiv API / GitHub API，用户手工维护）
build.mjs           构建脚本：抓取 → 选头条 → 按版块排版 → 生成 site/
translations.json   英文条目的中文译文（按标题哈希索引）
deploy.mjs          部署脚本：把 site/ 整体发布到 2AIGC Pages（MCP HTTP 直连）
site/               构建产物：当期头版 + 每期存档 + 往期目录（随每日出版增长）
```

每天 8:00 的定时出版流程：`node build.mjs` → 把 translate-queue.json 里的英文条目译成中文合并进 translations.json → 重跑 build 至待翻译归零 → `node deploy.mjs` 上线当期 → 提交推送当期存档到本仓库。

- 期数从创刊日 2026-10-07 起算，缺刊跳号。
- 各版块每期限 6 条，仓库条目不会被选为头条。
- 英文条目未翻译时回退显示英文原文，任何情况下都能照常出报。

## 用法

```bash
npm install        # 安装 fast-xml-parser
node build.mjs     # 抓取并排版当期
node deploy.mjs    # 部署到 2AIGC Pages（需在 ~/.zcode/cli/config.json 配置 2aigc-pages MCP 地址）
```
