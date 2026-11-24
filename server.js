/* 星课云·作品互评 — AI健康科普视频制作 · 后端服务器
 * 功能：视频/封面真实上传 / 作品列表 / 五维互评 / 观看数 / 推荐 / 文件流播放（支持 Range 拖拽）
 * 启动：npm start   访问：http://<服务器IP>:8899
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8899;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || ROOT; // 云端挂载持久磁盘时指向挂载目录
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* 数据持久化到 data.json：
 * works:   { 组id: { title, desc, subject, members[], file, cover, duration, views, featured, time } }
 * ratings: { 作品组id: { 评分者id: { dims:{content,creativity,tech,team,expr}, comment, tags[], time } } }
 */
function loadData() {
  try { return ensureClasses(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch { return ensureClasses({ works: {}, ratings: {} }); }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

/* 班级 / 组别配置：
 * classes: [{ id, name, groups:[{ id, name, password }] }]
 * 默认 1 个班 8 个组，组 id 与历史作品数据（g1~g8）保持一致
 */
const TEACHER_PIN = process.env.TEACHER_PIN || '123456';
const DEFAULT_PW = '123456';
function ensureClasses(d) {
  if (!Array.isArray(d.classes) || !d.classes.length) {
    d.classes = [{
      id: 'c1', name: '默认班级',
      groups: Array.from({ length: 8 }, (_, i) => ({ id: 'g' + (i + 1), name: '第' + (i + 1) + '组', password: DEFAULT_PW }))
    }];
  }
  d.classes.forEach(c => { if (!Array.isArray(c.groups)) c.groups = []; });
  if (!d.works) d.works = {};
  if (!d.ratings) d.ratings = {};
  return d;
}
function pinOk(req) {
  const p = req.body && req.body.pin !== undefined ? req.body.pin : req.query.pin;
  return p === TEACHER_PIN;
}
function nextGroupId(d) {
  const ids = new Set(d.classes.flatMap(c => c.groups.map(g => g.id)));
  let n = 1;
  while (ids.has('g' + n)) n++;
  return 'g' + n;
}
function allGroups(d) { return d.classes.flatMap(c => c.groups); }
/* 删除小组关联的视频、封面文件与全部评分 */
function removeGroupData(d, gid) {
  const w = d.works[gid];
  if (w) {
    fs.promises.unlink(path.join(UPLOAD_DIR, w.file)).catch(() => {});
    if (w.cover) fs.promises.unlink(path.join(UPLOAD_DIR, w.cover)).catch(() => {});
    delete d.works[gid];
  }
  delete d.ratings[gid];
  Object.values(d.ratings).forEach(m => { delete m[gid]; });
}

/* 上传配置：视频 mp4/mov/avi 最大 2GB；封面 jpg/png */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename(req, file, cb) {
      const ext = (path.extname(file.originalname) || (file.fieldname === 'cover' ? '.jpg' : '.mp4')).toLowerCase();
      cb(null, `${req.body.groupId}_${file.fieldname}_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    if (file.fieldname === 'video' && ['.mp4', '.mov', '.avi'].includes(ext)) return cb(null, true);
    if (file.fieldname === 'cover' && ['.jpg', '.jpeg', '.png'].includes(ext)) return cb(null, true);
    cb(new Error('文件类型不支持'));
  }
});

app.use(express.json());
app.use(express.static(ROOT)); // 托管 index.html

/* 上传本组作品（视频 + 封面 + 元数据）；重新上传会替换旧文件 */
app.post('/api/upload', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  const { groupId, title, duration } = req.body;
  const video = req.files && req.files.video && req.files.video[0];
  const cover = req.files && req.files.cover && req.files.cover[0];
  if (!groupId) return res.status(400).json({ error: '参数不完整' });
  const data = loadData();
  const old = data.works[groupId];
  if (!video && !old) return res.status(400).json({ error: '请上传视频文件' });
  if (video && old) {
    fs.promises.unlink(path.join(UPLOAD_DIR, old.file)).catch(() => {});
    if (old.cover) fs.promises.unlink(path.join(UPLOAD_DIR, old.cover)).catch(() => {});
  }
  data.works[groupId] = {
    title: (title || '').trim() || '未命名作品',
    desc: (old?.desc || ''),
    subject: (old?.subject || ''),
    members: old?.members || [],
    file: video ? video.filename : old.file,
    cover: cover ? cover.filename : (video ? '' : old.cover),
    duration: video ? Math.round(Number(duration) || 0) : (old.duration || 0),
    views: old ? old.views : 0,
    featured: old ? old.featured : false,
    time: Date.now()
  };
  saveData(data);
  res.json({ ok: true });
});

/* 作品列表 / 评分数据 */
app.get('/api/works', (req, res) => res.json(loadData().works));
app.get('/api/ratings', (req, res) => res.json(loadData().ratings));

/* 班级与组别配置：带教师口令时返回各组登录密码 */
app.get('/api/config', (req, res) => {
  const d = loadData();
  const admin = pinOk(req);
  res.json({
    classes: d.classes.map(c => ({
      id: c.id, name: c.name,
      groups: c.groups.map(g => admin
        ? { id: g.id, name: g.name, password: g.password || DEFAULT_PW }
        : { id: g.id, name: g.name })
    }))
  });
});

/* 学生登录：班级 + 组别 + 密码 */
app.post('/api/login', (req, res) => {
  const { groupId, password } = req.body || {};
  const d = loadData();
  const g = allGroups(d).find(x => x.id === groupId);
  if (!g) return res.status(404).json({ error: '小组不存在，请联系老师' });
  if ((g.password || DEFAULT_PW) !== String(password || '')) return res.status(403).json({ error: '密码错误，请向老师确认' });
  res.json({ ok: true });
});

/* 班级管理 */
app.post('/api/classes', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入班级名称' });
  const d = loadData();
  const id = 'c' + Date.now().toString(36);
  d.classes.push({ id, name, groups: [] });
  const cls = d.classes[d.classes.length - 1];
  for (let i = 1; i <= 4; i++) cls.groups.push({ id: nextGroupId(d), name: '第' + i + '组', password: DEFAULT_PW });
  saveData(d);
  res.json({ ok: true });
});

app.patch('/api/classes/:id', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入班级名称' });
  const d = loadData();
  const c = d.classes.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  c.name = name;
  saveData(d);
  res.json({ ok: true });
});

app.delete('/api/classes/:id', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const d = loadData();
  if (d.classes.length <= 1) return res.status(400).json({ error: '至少保留一个班级' });
  const c = d.classes.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  c.groups.forEach(g => removeGroupData(d, g.id));
  d.classes = d.classes.filter(x => x.id !== req.params.id);
  saveData(d);
  res.json({ ok: true });
});

/* 组别管理 */
app.post('/api/classes/:id/groups', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入组别名称' });
  const d = loadData();
  const c = d.classes.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  c.groups.push({ id: nextGroupId(d), name, password: DEFAULT_PW });
  saveData(d);
  res.json({ ok: true });
});

app.patch('/api/groups/:gid', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const d = loadData();
  const g = allGroups(d).find(x => x.id === req.params.gid);
  if (!g) return res.status(404).json({ error: '小组不存在' });
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: '请输入组别名称' });
    g.name = name;
  }
  if (req.body.password !== undefined) {
    const pw = String(req.body.password).trim();
    if (pw.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
    g.password = pw;
  }
  saveData(d);
  res.json({ ok: true });
});

app.delete('/api/groups/:gid', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const d = loadData();
  const owner = d.classes.find(c => c.groups.some(g => g.id === req.params.gid));
  if (!owner) return res.status(404).json({ error: '小组不存在' });
  owner.groups = owner.groups.filter(g => g.id !== req.params.gid);
  removeGroupData(d, req.params.gid);
  saveData(d);
  res.json({ ok: true });
});

/* 一键重置某班全部小组密码 */
app.post('/api/classes/:id/reset-passwords', (req, res) => {
  if (!pinOk(req)) return res.status(403).json({ error: '无权限' });
  const d = loadData();
  const c = d.classes.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  c.groups.forEach(g => { g.password = DEFAULT_PW; });
  saveData(d);
  res.json({ ok: true });
});

/* 提交五维评分（同一评分者对同一作品仅保留最新一次） */
app.post('/api/rate', (req, res) => {
  const { workId, raterId, raterName, dims, comment, tags } = req.body || {};
  const keys = ['know', 'av', 'story'];
  if (!workId || !raterId || !dims || !keys.every(k => dims[k] >= 1 && dims[k] <= 5))
    return res.status(400).json({ error: '请完成三项评分' });
  if (workId === raterId)
    return res.status(400).json({ error: '不能给本组作品评分' });
  const data = loadData();
  if (!data.works[workId]) return res.status(404).json({ error: '作品不存在' });
  if (!data.ratings[workId]) data.ratings[workId] = {};
  data.ratings[workId][raterId] = {
    dims, raterName: (raterName || '').trim() || raterId,
    comment: (comment || '').trim(),
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    time: Date.now()
  };
  saveData(data);
  res.json({ ok: true });
});

/* 观看数 +1 */
app.post('/api/view', (req, res) => {
  const { workId } = req.body || {};
  const data = loadData();
  if (!data.works[workId]) return res.status(404).json({ error: '作品不存在' });
  data.works[workId].views = (data.works[workId].views || 0) + 1;
  saveData(data);
  res.json({ ok: true, views: data.works[workId].views });
});

/* 教师推荐/取消推荐至首页 */
app.post('/api/work/:id/feature', (req, res) => {
  const data = loadData();
  const w = data.works[req.params.id];
  if (!w) return res.status(404).json({ error: '作品不存在' });
  w.featured = !!(req.body && req.body.featured);
  saveData(data);
  res.json({ ok: true, featured: w.featured });
});

/* 教师删除作品（视频/封面文件与全部评分一并清除） */
app.delete('/api/work/:id', (req, res) => {
  const data = loadData();
  const w = data.works[req.params.id];
  if (!w) return res.status(404).json({ error: '作品不存在' });
  fs.promises.unlink(path.join(UPLOAD_DIR, w.file)).catch(() => {});
  if (w.cover) fs.promises.unlink(path.join(UPLOAD_DIR, w.cover)).catch(() => {});
  delete data.works[req.params.id];
  delete data.ratings[req.params.id];
  saveData(data);
  res.json({ ok: true });
});

/* 文件服务：手动实现 Range 请求，确保浏览器 <video> 正常播放 */
const MIME = { '.mp4':'video/mp4', '.mov':'video/quicktime', '.avi':'video/x-msvideo', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png' };
app.get('/api/file/:name', (req, res) => {
  const f = path.basename(req.params.name);
  const p = path.join(UPLOAD_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  const stat = fs.statSync(p);
  const ext = (path.extname(f) || '').toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const size = stat.size;

  // 尝试发送整个文件（让 Express 自动处理 Range），但先手动设置关键 header
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('ETag', JSON.stringify(`${stat.size}-${stat.mtimeMs}`));
  res.setHeader('Content-Length', size);

  const range = req.headers.range;
  if (range && /^bytes=(\d*)-(\d*)$/.test(range)) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    let start = parseInt(m[1]) || 0;
    let end = m[2] ? parseInt(m[2]) : size - 1;
    if (start >= size) { res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; }
    if (end >= size) end = size - 1;
    res.status(206);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.status(200);
    fs.createReadStream(p).pipe(res);
  }
});

/* 统一错误处理（如超限、类型不符） */
app.use((err, req, res, next) => {
  if (err) res.status(400).json({ error: err.message });
  else next();
});

app.listen(PORT, () => {
  const nets = os.networkInterfaces();
  let lanIp = 'localhost';
  for (const name of Object.keys(nets))
    for (const net of nets[name] || [])
      if (net.family === 'IPv4' && !net.internal) lanIp = net.address;
  console.log('');
  console.log('  ✅ 星课云·作品互评（AI健康科普视频制作）已启动');
  console.log(`  ➜ 本机访问:  http://localhost:${PORT}`);
  console.log(`  ➜ 局域网访问: http://${lanIp}:${PORT}`);
  console.log('');
});
