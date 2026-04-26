# PM Tools

一个用于小项目开发管理的 Vue 甘特图工具。前端使用 Vue 3，后端使用 Node.js 内置 HTTP 服务，项目和任务数据保存到 `data/projects.json`。

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
- 本地 JSON 持久化保存

## 数据接口

- `GET /api/projects`：读取项目列表
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
data/projects.json  多项目持久化数据
```

旧版的 `data/project.json` 和 `data/tasks.json` 会作为迁移来源保留；如果没有 `data/projects.json`，服务启动时会自动生成。
