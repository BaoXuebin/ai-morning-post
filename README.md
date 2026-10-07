# 智能晨报 The AI Morning Post

每天早上八点自动出版一期的 AI 领域报刊，部署在 2AIGC Pages：**https://ai-morning-post.pages.2aigc.space/**

一份用传统报刊版式呈现的 AI 早报：毛笔字报头、朱红印章点、大字号头条配首字下沉、双栏简讯，按「要闻 / 研究前沿 / 产品与发布 / 开源与社区 / 观点与随笔」五个版块排印，每期存档可回看。

## 工作方式

```
feeds.json          源配置（RSS / arXiv API / GitHub API，用户手工维护）
build.mjs           构建脚本：抓取 → 选头条 → 按版块排版 → 生成 site/
translations.json   英文条目的中文译文（按标题哈希索引）
deploy.mjs          部署脚本：把 site/ 整体发布到 2AIGC Pages（MCP HTTP 直连）
site/               构建产物：当期头版 + 每期存档 + 往期目录（随每日出版增长）
```

每天 8:00 的定时出版流程：`node build.mjs` → 把 translate-queue.json 里的英文条目译成中文合并进 translations.json → 重跑 build 至待翻译归零 → `node deploy.mjs` 上线当期。

- 英文源（TechCrunch、OpenAI News、Simon Willison、HN、arXiv、GitHub）全部译为中文呈现；未翻译的条目回退显示英文原文。
- 期数从创刊日 2026-10-07 起算，缺刊跳号。
- 各版块每期限 8 条，仓库条目不会被选为头条。

## 用法

```bash
npm install        # 安装 fast-xml-parser
node build.mjs     # 抓取并排版当期
node deploy.mjs    # 部署到 2AIGC Pages（需在 ~/.zcode/cli/config.json 配置 2aigc-pages MCP 地址）
```
