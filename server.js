const http = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const VERSION = 'PM-Tools-SQL-V3';
const SCHEMA_VERSION = 3;
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const LIVE_RELOAD = process.env.LIVE_RELOAD === '1';
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const dbFile = path.join(dataDir, 'pm-tools.sqlite');
const backupDir = path.join(dataDir, 'backups');
const legacyProjectsFile = path.join(dataDir, 'projects.json');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
let db;
const liveReloadClients = new Set();
let liveReloadTimer = null;

function initDatabase() {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureBaseSchema();
  migrateDatabase();
  const count = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
  if (count === 0) migrateLegacyJson();
  checkpointDatabase('FULL');
}

function ensureBaseSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, owner TEXT NOT NULL, phase TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, critical INTEGER NOT NULL DEFAULT 0, milestone INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY(parent_id) REFERENCES tasks(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);`);
}

function migrateDatabase() {
  const currentVersion = getSchemaVersion();
  if (currentVersion >= SCHEMA_VERSION) return;
  const backupFile = backupDatabase(`before-v${SCHEMA_VERSION}`);
  db.exec('BEGIN');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    if (currentVersion < 3) {
      ensureTaskParentColumn();
    }
    setMeta('schema_version', String(SCHEMA_VERSION));
    setMeta('last_backup_file', backupFile);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureTaskParentColumn() {
  const columns = db.prepare('PRAGMA table_info(tasks)').all();
  if (!columns.some((column) => column.name === 'parent_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN parent_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id)');
}

function getSchemaVersion() {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get();
  if (!table) return 1;
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
  return Number(row?.value || 1);
}

function setMeta(key, value) {
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
}

function checkpointDatabase(mode = 'FULL') {
  try {
    db.exec(`PRAGMA wal_checkpoint(${mode})`);
  } catch (error) {
    console.warn(`SQLite WAL checkpoint skipped: ${error.message}`);
  }
}

function backupDatabase(label) {
  fs.mkdirSync(backupDir, { recursive: true });
  checkpointDatabase('FULL');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const safeLabel = String(label).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const backupFile = path.join(backupDir, `pm-tools-${stamp}-${safeLabel}.sqlite`);
  db.exec(`VACUUM INTO ${sqlString(backupFile)}`);
  return backupFile;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function migrateLegacyJson() {
  const fallback = [{ id: 'project-001', name: '电商小程序开发计划', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] }];
  let projects = fallback;
  if (fs.existsSync(legacyProjectsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyProjectsFile, 'utf8'));
      if (Array.isArray(parsed) && parsed.length) projects = parsed;
    } catch {}
  }
  db.exec('BEGIN');
  try {
    for (const project of projects) {
      insertProject({ ...project, createdAt: project.createdAt || new Date().toISOString(), updatedAt: project.updatedAt || new Date().toISOString() });
      for (const task of project.tasks || []) insertTask(project.id, task);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function insertProject(project) {
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(project.id, project.name, project.createdAt, project.updatedAt);
}

function insertTask(projectId, task) {
  db.prepare(`INSERT INTO tasks (id, project_id, parent_id, name, owner, phase, start, end, progress, status, critical, milestone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(task.id, projectId, task.parentId || null, task.name, task.owner, task.phase, task.start, task.end, task.progress || 0, task.status || '未开始', task.critical ? 1 : 0, task.milestone ? 1 : 0);
}

function serializeTask(row) {
  return { id: row.id, parentId: row.parent_id || '', name: row.name, owner: row.owner, phase: row.phase, start: row.start, end: row.end, progress: row.progress, status: row.status, critical: Boolean(row.critical), milestone: Boolean(row.milestone) };
}

function readTasks(projectId) {
  return db.prepare('SELECT id, parent_id, name, owner, phase, start, end, progress, status, critical, milestone FROM tasks WHERE project_id = ? ORDER BY start ASC, end ASC').all(projectId).map(serializeTask);
}

function readProject(projectId) {
  const project = db.prepare('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?').get(projectId);
  return project ? { ...project, tasks: readTasks(project.id) } : null;
}

function readProjects() {
  return db.prepare('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all().map((project) => ({ ...project, tasks: readTasks(project.id) }));
}

function summarizeProject(project) {
  const tasks = project.tasks || [];
  const progress = tasks.length ? Math.round(tasks.reduce((sum, task) => sum + Number(task.progress || 0), 0) / tasks.length) : 0;
  const endDate = tasks.length ? [...tasks].sort((a, b) => new Date(b.end) - new Date(a.end))[0].end : '';
  return { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, taskCount: tasks.length, riskCount: tasks.filter((task) => task.status === '风险').length, progress, endDate };
}

function normalizeProject(input, existing = {}) {
  const project = { ...existing, name: String(input.name ?? existing.name ?? '').trim() };
  if (!project.name) throw new Error('项目名称不能为空');
  if (project.name.length > 80) throw new Error('项目名称不能超过 80 个字符');
  return project;
}

function normalizeTask(input, existing = {}) {
  const rawParentId = input.parentId ?? input.parent_id ?? existing.parentId ?? existing.parent_id ?? '';
  const task = { ...existing, ...input, parentId: String(rawParentId || '').trim(), name: String(input.name ?? existing.name ?? '').trim(), owner: String(input.owner ?? existing.owner ?? '').trim(), phase: String(input.phase ?? existing.phase ?? '').trim(), start: String(input.start ?? existing.start ?? '').trim(), end: String(input.end ?? existing.end ?? '').trim(), status: String(input.status ?? existing.status ?? '未开始').trim(), progress: Number(input.progress ?? existing.progress ?? 0), critical: Boolean(input.critical ?? existing.critical ?? false), milestone: Boolean(input.milestone ?? existing.milestone ?? false) };
  if (!task.name) throw new Error('任务名称不能为空');
  if (!task.owner) throw new Error('负责人不能为空');
  if (!task.phase) throw new Error('阶段不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(task.start)) throw new Error('开始日期无效');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(task.end)) throw new Error('结束日期无效');
  if (new Date(task.start) > new Date(task.end)) throw new Error('开始日期不能晚于结束日期');
  if (!['未开始', '进行中', '已完成', '风险'].includes(task.status)) throw new Error('状态无效');
  task.progress = Math.max(0, Math.min(100, Math.round(task.progress)));
  return task;
}

function validateTaskParent(projectId, task, taskId = '') {
  if (!task.parentId) return;
  if (task.parentId === taskId) throw new Error('子任务不能关联到自身');
  const parent = db.prepare('SELECT id, parent_id FROM tasks WHERE project_id = ? AND id = ?').get(projectId, task.parentId);
  if (!parent) throw new Error('父任务不存在');
  if (parent.parent_id) throw new Error('暂不支持多级子任务');
  const childCount = taskId ? db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND parent_id = ?').get(projectId, taskId).count : 0;
  if (childCount > 0) throw new Error('已有子任务的任务不能再作为子任务');
}

function deleteTaskTree(projectId, taskId) {
  db.prepare('DELETE FROM tasks WHERE project_id = ? AND parent_id = ?').run(projectId, taskId);
  return db.prepare('DELETE FROM tasks WHERE project_id = ? AND id = ?').run(projectId, taskId);
}

function touchProject(projectId) {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId);
}

function sendJson(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
function sendError(res, status, message) { sendJson(res, status, { error: message }); }
function readBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 1000000) reject(new Error('请求体过大')); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON 格式无效')); } }); req.on('error', reject); }); }

function handleLiveReload(req, res) {
  if (!LIVE_RELOAD) return false;
  if (req.url !== '/__live-reload') return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('event: ready\ndata: ready\n\n');
  liveReloadClients.add(res);
  req.on('close', () => liveReloadClients.delete(res));
  return true;
}

function notifyLiveReload() {
  if (!LIVE_RELOAD) return;
  if (liveReloadTimer) clearTimeout(liveReloadTimer);
  liveReloadTimer = setTimeout(() => {
    for (const client of liveReloadClients) {
      client.write('event: reload\ndata: reload\n\n');
    }
  }, 80);
}

function startLiveReloadWatcher() {
  if (!LIVE_RELOAD) return;

  try {
    fs.watch(publicDir, { recursive: true }, (_eventType, fileName) => {
      if (!fileName || String(fileName).includes('.DS_Store')) return;
      notifyLiveReload();
    });
    console.log('Live reload is watching public/');
  } catch (error) {
    console.warn(`Live reload watcher disabled: ${error.message}`);
  }
}

function injectLiveReload(content) {
  if (!LIVE_RELOAD) return content;

  const script = `<script>
(() => {
  let connected = false;
  let reconnectAfterRestart = false;
  const source = new EventSource("/__live-reload");
  source.addEventListener("open", () => {
    if (reconnectAfterRestart) window.location.reload();
    connected = true;
    reconnectAfterRestart = false;
  });
  source.addEventListener("reload", () => window.location.reload());
  source.addEventListener("error", () => {
    if (connected) reconnectAfterRestart = true;
    connected = false;
  });
})();
</script>`;

  return content.includes('</body>') ? content.replace('</body>', `${script}</body>`) : `${content}${script}`;
}

async function handleApi(req, res, url) {
  const projectIdMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  const projectTasksMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
  const projectTaskIdMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  if (url.pathname === '/api/version') return sendJson(res, 200, { version: VERSION, storage: 'sqlite', schemaVersion: getSchemaVersion(), dbFile, backupDir, dataDir });
  if (url.pathname === '/api/projects' && req.method === 'GET') return sendJson(res, 200, readProjects().map(summarizeProject));
  if (url.pathname === '/api/projects' && req.method === 'POST') { const input = await readBody(req); const now = new Date().toISOString(); const project = { ...normalizeProject(input), id: randomUUID(), createdAt: now, updatedAt: now, tasks: [] }; insertProject(project); return sendJson(res, 201, project); }
  if (projectIdMatch && req.method === 'GET') { const project = readProject(decodeURIComponent(projectIdMatch[1])); return project ? sendJson(res, 200, project) : sendError(res, 404, '项目不存在'); }
  if (projectIdMatch && req.method === 'PUT') { const id = decodeURIComponent(projectIdMatch[1]); const existing = readProject(id); if (!existing) return sendError(res, 404, '项目不存在'); const project = normalizeProject(await readBody(req), existing); const updatedAt = new Date().toISOString(); db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(project.name, updatedAt, id); return sendJson(res, 200, readProject(id)); }
  if (projectIdMatch && req.method === 'DELETE') { const id = decodeURIComponent(projectIdMatch[1]); const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id); if (!result.changes) return sendError(res, 404, '项目不存在'); return sendJson(res, 200, { ok: true }); }
  if (projectTasksMatch && req.method === 'GET') { const project = readProject(decodeURIComponent(projectTasksMatch[1])); return project ? sendJson(res, 200, project.tasks) : sendError(res, 404, '项目不存在'); }
  if (projectTasksMatch && req.method === 'POST') { const id = decodeURIComponent(projectTasksMatch[1]); if (!readProject(id)) return sendError(res, 404, '项目不存在'); const task = { ...normalizeTask(await readBody(req)), id: randomUUID() }; validateTaskParent(id, task); insertTask(id, task); touchProject(id); return sendJson(res, 201, task); }
  if (projectTaskIdMatch && req.method === 'PUT') { const projectId = decodeURIComponent(projectTaskIdMatch[1]); const taskId = decodeURIComponent(projectTaskIdMatch[2]); if (!readProject(projectId)) return sendError(res, 404, '项目不存在'); const existing = db.prepare('SELECT id, parent_id, name, owner, phase, start, end, progress, status, critical, milestone FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId); if (!existing) return sendError(res, 404, '任务不存在'); const task = { ...normalizeTask(await readBody(req), serializeTask(existing)), id: taskId }; validateTaskParent(projectId, task, taskId); db.prepare('UPDATE tasks SET parent_id = ?, name = ?, owner = ?, phase = ?, start = ?, end = ?, progress = ?, status = ?, critical = ?, milestone = ? WHERE project_id = ? AND id = ?').run(task.parentId || null, task.name, task.owner, task.phase, task.start, task.end, task.progress, task.status, task.critical ? 1 : 0, task.milestone ? 1 : 0, projectId, taskId); touchProject(projectId); return sendJson(res, 200, task); }
  if (projectTaskIdMatch && req.method === 'DELETE') { const projectId = decodeURIComponent(projectTaskIdMatch[1]); const taskId = decodeURIComponent(projectTaskIdMatch[2]); if (!readProject(projectId)) return sendError(res, 404, '项目不存在'); const result = deleteTaskTree(projectId, taskId); if (!result.changes) return sendError(res, 404, '任务不存在'); touchProject(projectId); return sendJson(res, 200, { ok: true }); }
  sendError(res, 404, '接口不存在');
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, requestedPath));
  if (!filePath.startsWith(publicDir)) return sendError(res, 403, '禁止访问');
  try {
    const ext = path.extname(filePath);
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream', 'Cache-Control': LIVE_RELOAD ? 'no-store' : 'public, max-age=0' });
    res.end(ext === '.html' ? injectLiveReload(content.toString('utf8')) : content);
  } catch { res.writeHead(302, { Location: '/' }); res.end(); }
}

initDatabase();
startLiveReloadWatcher();
const server = http.createServer(async (req, res) => { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); try { if (handleLiveReload(req, res)) return; if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url); await serveStatic(req, res, url); } catch (error) { sendError(res, 400, error.message || '请求失败'); } });
server.on('error', (error) => { if (error.code === 'EADDRINUSE') { console.error(`端口 ${PORT} 已被占用，请使用 PORT=其它端口 node server.js 启动。`); process.exit(1); } throw error; });
server.listen(PORT, HOST, () => { console.log(`${VERSION} is running at http://${HOST}:${PORT}`); console.log(`SQLite database: ${dbFile}`); });
