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
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { works: {}, ratings: {} }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

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

/* 提交五维评分（同一评分者对同一作品仅保留最新一次） */
app.post('/api/rate', (req, res) => {
  const { workId, raterId, raterName, dims, comment, tags } = req.body || {};
  const keys = ['content', 'creativity', 'tech', 'team', 'expr'];
  if (!workId || !raterId || !dims || !keys.every(k => dims[k] >= 1 && dims[k] <= 5))
    return res.status(400).json({ error: '请完成五个维度的评分' });
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
