#!/command/with-contenv bash
# ---------------------------------------------------------
# 初始化 /data 目录 (首次启动时复制示例配置)
# smanga-get 代码在 Linux 下使用绝对路径 /data/xxx
# ---------------------------------------------------------
set -e

DATA_DIR="/data"
# 优先使用 docker 专用的示例配置 (路径已用 Linux 风格 /data/...)
EXAMPLE_DIR="/app/smanga-get/data-example-docker"
[ -d "${EXAMPLE_DIR}" ] || EXAMPLE_DIR="/app/smanga-get/data-example"

mkdir -p "${DATA_DIR}/cookies"

# 首次启动拷贝示例配置
if [ ! -f "${DATA_DIR}/config.json" ] && [ -d "${EXAMPLE_DIR}" ]; then
    echo "[init-data] 首次启动，初始化 /data 默认配置"
    cp -rn "${EXAMPLE_DIR}/." "${DATA_DIR}/" 2>/dev/null || true
fi

# 确保日志文件存在，避免应用启动前读取报错
touch "${DATA_DIR}/log.txt"

# 权限
chmod -R u+rwX,g+rwX "${DATA_DIR}" || true

echo "[init-data] /data 初始化完成"