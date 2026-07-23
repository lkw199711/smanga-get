#!/command/with-contenv bash
# ---------------------------------------------------------
# 初始化 /data 目录 (首次启动时复制默认配置)
# 默认配置来自镜像构建时从 git 仓库拷入的 /defaults
# (对应 git 仓库的 smanga-get/data-example-docker 目录)
# smanga-get 代码在 Linux 下使用绝对路径 /data/xxx
# ---------------------------------------------------------
set -e

DATA_DIR="/data"
DEFAULTS_DIR="/defaults"

mkdir -p "${DATA_DIR}/cookies"

# 首次启动 (config.linux.json 不存在) 时拷贝默认配置
if [ ! -f "${DATA_DIR}/config.linux.json" ] && [ -d "${DEFAULTS_DIR}" ]; then
    echo "[init-data] 首次启动，从 ${DEFAULTS_DIR} 初始化 /data 默认配置"
    cp -rn "${DEFAULTS_DIR}/." "${DATA_DIR}/" 2>/dev/null || true
    # 将默认 config.json 重命名为 OS 专用名称 (Docker 始终为 Linux)
    if [ -f "${DATA_DIR}/config.json" ]; then
        mv "${DATA_DIR}/config.json" "${DATA_DIR}/config.linux.json"
    fi
fi

# 确保日志文件存在，避免应用启动前读取报错
touch "${DATA_DIR}/log.txt"

# 权限
chmod -R u+rwX,g+rwX "${DATA_DIR}" || true

echo "[init-data] /data 初始化完成"