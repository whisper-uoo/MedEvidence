# MedEvidence 1.0

MedEvidence 是面向医学科研与教学的 PubMed 文献检索和摘要证据综述工作台。可以用中文或英文提出研究问题，在候选文献中筛选并查阅 PubMed 来源。配置模型和 MySQL 后，可选择文献生成带逐条 PMID 引用的异步综述。

## 项目结构

| 路径 | 功能 |
| --- | --- |
| `backend/` | Java 17、Spring Boot 3.5 REST API，包含 PubMed 客户端、BM25、模型校验、任务执行及 MySQL 存储 |
| `frontend/` | 原生 HTML、CSS、JavaScript 工作台，独立静态部署 |
| `database/001_review_tasks.sql` | MySQL 任务表初始化，可重复执行 |
| `.env.example` | 本地后端配置模板 |

## 本地运行

需要 JDK 17、Maven 3.6.3+、Python 3 和可访问 PubMed 的网络。模型和 MySQL 仅在使用对应 AI 功能时需要。

```bash
cp .env.example .env
# 编辑 .env，为 NCBI_EMAIL 填写实际联系邮箱。
set -a
source .env
set +a
mvn -f backend/pom.xml spring-boot:run
```

在另一终端执行：

```bash
python3 -m http.server 5173 --bind 127.0.0.1 --directory frontend
```

打开 http://localhost:5173。从「二甲双胍对 2 型糖尿病患者的效果？」开始，展开检索式和摘要，使用关键词、有摘要和年份排序浏览候选文献，再勾选所需文献。

后端默认监听本机 8080 端口。分开部署需设置 `FRONTEND_ORIGIN` 并配置前端 `search.js` 的 API origin。此版面向本地或受控演示环境。因为没有登录与访问隔离，部署到网络时需在外层限制访问，避免他人消耗模型配额或读取任务。

## PubMed 与模型

- `NCBI_EMAIL` 为有效联系邮箱，`NCBI_API_KEY` 可选。每实例以至少 350 ms 间隔发起请求，`PUBMED_TIMEOUT` 默认 8 秒。共享出口须统筹配额。
- 中文先走本地术语映射，生成 MeSH 和标题／摘要条件。遇到未覆盖的术语时，已配置模型可生成英文 PubMed 查询，用户也可手动填写 `englishQuery`。英文输入交给 PubMed 解析。生成的英文检索式应检查是否完整覆盖研究问题。
- PubMed 相关度返回前 1–50 篇候选。BM25 在标题和摘要上计算本地候选相关性。启用语义排序后，模型只评估 BM25 前 12 篇，检验候选 PMID、分数、理由后排序，超出该范围的候选保持 BM25 次序。模型异常时保留 BM25。相关性分数用于检索排序。
- `AI_BASE_URL` 例如 `https://api.openai.com/v1`，不含 `/chat/completions`。同时设置 `AI_MODEL`、`AI_API_KEY`，选择支持 Chat Completions、JSON Object 模式和 temperature 参数的模型。模型请求默认超时 `AI_TIMEOUT=25s`。模型密钥只由后端读取。
- 模型服务会接收研究问题及功能所需的公开文献标题和摘要。请避免在问题中输入患者身份或其他敏感信息。

## MySQL 综述任务

准备 MySQL 8.x 或兼容实例。用管理员在终端客户端执行以下示例，替换密码并按实际部署调整主机权限。

```sql
CREATE DATABASE IF NOT EXISTS medevidence CHARACTER SET utf8mb4;
CREATE USER 'medevidence'@'localhost' IDENTIFIED BY 'REPLACE_WITH_A_LOCAL_PASSWORD';
GRANT SELECT, INSERT, UPDATE ON medevidence.* TO 'medevidence'@'localhost';
```

以管理员或迁移身份执行：

```bash
mysql -u root -p medevidence < database/001_review_tasks.sql
```

在 `.env` 填写 `REVIEW_DB_URL='jdbc:mysql://localhost:3306/medevidence'`、`REVIEW_DB_USER='medevidence'`、`REVIEW_DB_PASSWORD`，重新加载环境并启动后端。模型和数据库均配置后，页面允许提交 1–8 篇文献。

后端按 PMID 重新从 PubMed 拉取记录，对有摘要的文献逐篇提取研究设计、发现、局限和原文引句，再综合研究发现、不同结论和局限。校验引句确实出现在摘要内，并校验引文属于已提取 PMID。模型提示要求保留关联与因果的区别，缺失信息标为摘要未报告。字符级引句校验和 ID 校验无法判断模型叙述的所有事实、因果或证据强度，展示时应与原文核对。超长摘要会截取，缺失摘要的条目不进入证据提取。

任务使用有界本地执行器。相同问题与文献集合复用进行中或已成功的任务。失败后可重新提交。任务超过 150 秒后在查询或提交时标记超时。已经成功的结果可跨重启查询。重启前未完成的任务在截止时间后失效。数据库会保留任务与结果，维护者可按实际需要定期清理。

## HTTP API 示例

所有业务响应均用 `{code, message, data}`。错误的 `data` 为 `null`。检索无结果返回 HTTP 200 和 `NO_RESULTS`，上游限流为 503，超时为 504，接口或数据异常为 502。

```bash
curl -fsS http://localhost:8080/api/capabilities
curl -fsS http://localhost:8080/api/literature/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"二甲双胍对 2 型糖尿病患者的效果？","limit":10,"semantic":false}'
curl -fsS http://localhost:8080/api/literature/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"哮喘患者的吸入激素治疗","englishQuery":"asthma AND inhaled corticosteroids","limit":5}'
```

成功返回 `pubmedQuery`、PubMed 匹配总量 `total`、`articles`、按 PMID 对应的 `rankings`，以及可空的 `rankingNotice`。文献字段为 `pmid`、`title`、`abstractText`、`authors`、`journal`、`publicationDate`、`doi` 和 `pubmedUrl`。缺失标量为 `null`，作者缺失时为空数组。

配置好 AI 后，使用检索结果中返回的真实 PMID 提交：

```bash
curl -fsS http://localhost:8080/api/reviews \
  -H 'Content-Type: application/json' \
  -d '{"question":"二甲双胍对 2 型糖尿病患者的效果？","pmids":["32897388"]}'
curl -fsS "http://localhost:8080/api/reviews/${TASK_ID}"
```

`TASK_ID` 为提交响应中的 `data.id`。轮询 `data.state`，状态值为 `QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED`、`TIMED_OUT`。成功时 `data.result` 包含逐篇 `evidence` 以及 `findings`、`differences`、`limitations` 和未提供摘要的 `missingAbstractPmids`，失败时查看 `errorCode` 和 `message`。

## 验证

```bash
mvn -f backend/pom.xml verify
node --input-type=module --check < frontend/search.js
```

标准测试覆盖本地模拟 PubMed HTTP 调用、输入校验、字段缺失、限流、超时、BM25、模型引文校验与异步任务提交。测试需要能绑定本机回环端口。静态前端无需打包。生产模型的质量和接口兼容性取决于部署者配置。

- [NCBI E-utilities 参数文档](https://www.ncbi.nlm.nih.gov/sites/books/NBK25499/)
- [NCBI 使用政策与摘要版权](https://www.ncbi.nlm.nih.gov/home/about/policies/)
- [OpenAI Chat Completions 接口](https://platform.openai.com/docs/api-reference/chat)
