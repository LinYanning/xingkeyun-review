#!/bin/bash
# 星课云·作品互评平台 — 云服务器一键部署/更新脚本
# 用法：在服务器上执行  bash deploy.sh
set -e

APP=xingkeyun-review
REPO=https://github.com/LinYanning/xingkeyun-review.git
DATA=/data/xkj   # 宿主机持久目录：视频与评分数据

mkdir -p $DATA/uploads

if [ ! -d $APP ]; then
  git clone $REPO $APP
fi
cd $APP
git pull

docker build -t $APP .
docker stop $APP 2>/dev/null || true
docker rm   $APP 2>/dev/null || true

docker run -d --name $APP --restart always \
  -p 80:8899 \
  -e DATA_DIR=/data \
  -v $DATA:/data \
  $APP

echo ""
echo "✅ 部署完成：http://$(curl -s ifconfig.me 2>/dev/null || echo '<服务器IP>')"
echo "数据目录：$DATA （视频在 $DATA/uploads，评分在 $DATA/data.json）"
