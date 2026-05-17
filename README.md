# PM Tools

一个用于小项目开发管理的 Vue 甘特图工具。前端使用 Vue 3，后端使用 Node.js 内置 HTTP 服务，项目和任务数据保存到 SQLite 数据库 `data/pm-tools.sqlite`。

## 运行

```bash
npm start
```

打开：

```text
http://127.0.0.1:5173
```

如果 5173 端口被占用：

```bash
PORT=5174 npm start
```

## 功能

- 甘特图时间轴
- 多项目管理
- 新建项目
- 左侧菜单多页面切换
- 历史项目页面集中查看所有项目
- 点击历史项目进入对应项目甘特图
- 项目名称编辑和保存
- 任务新增、编辑、删除
- 任务进度和状态快速更新
- 搜索、状态筛选、关键路径筛选
- 风险任务、里程碑、今天标记
- 本地 SQLite 持久化保存
- V2 数据库 schema version 记录
- V2 数据库升级前自动备份

## 数据接口

- `GET /api/projects`：读取项目列表
- `GET /api/version`：读取版本、存储类型、schema version 和数据库路径
- `POST /api/projects`：新建项目
- `GET /api/projects/:id`：读取单个项目
- `PUT /api/projects/:id`：更新项目名称
- `GET /api/projects/:id/tasks`：读取项目任务
- `POST /api/projects/:id/tasks`：新增项目任务
- `PUT /api/projects/:id/tasks/:taskId`：更新项目任务
- `DELETE /api/projects/:id/tasks/:taskId`：删除项目任务

## 目录

```text
server.js           后端服务和 API
public/index.html   Vue 页面入口
public/app.js       Vue 应用逻辑
public/styles.css   页面样式
data/pm-tools.sqlite SQLite 持久化数据库
data/backups/        数据库升级前备份目录
```

旧版的 `data/projects.json` 会作为迁移来源保留；如果 SQLite 数据库为空，服务启动时会尝试从该文件迁移项目数据。

## 数据安全

V2 会记录当前数据库 schema version。服务启动时如果检测到数据库需要升级，会先使用 SQLite `VACUUM INTO` 生成一致性备份，再执行迁移。

备份文件保存在：

```text
data/backups/
```

数据库表结构说明见：

```text
DATABASE_SCHEMA.md
```
