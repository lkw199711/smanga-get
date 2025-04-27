import Axios from 'axios'
import * as fs from 'fs'
import * as os from 'os'

const liunxStr = get_os() === 'Linux' ? '/' : ''
const configFile = liunxStr + 'data/config.json'
const logFile = liunxStr + 'data/log.txt'

export function get_os() {
  const platform = os.platform()
  if (platform === 'win32') {
    return 'Windows'
  } else if (platform === 'linux') {
    return 'Linux'
  } else {
    return 'Other'
  }
}

export async function downloadImage(url: string, path: string): Promise<void> {
  const response = await Axios({
    method: 'get',
    url,
    responseType: 'stream',
  })

  const writer = fs.createWriteStream(path)
  response.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

export function read_json(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/**
 * 
 * @param ms 延迟的时间，单位为毫秒
 * @description: 延迟函数，使用Promise实现
 * @returns 
 */
export async function delay(ms: number) {
  return new Promise(resolve => {
    const now = new Date().getTime();
    const target = now + ms;

    while (new Date().getTime() < target) {
      continue;
    }

    resolve(true); // 延时结束，返回结果
  });
};

export function saveBase64Image(base64Data: any, filepath: string) {
  const base64Image = base64Data.split(';base64,').pop();
  fs.writeFileSync(filepath, base64Image, { encoding: 'base64' });
}

/**
 * 
 * @param logContent 日志内容
 */
export function write_log(logContent: string) {
  console.log(logContent);
  fs.appendFileSync(logFile, `${new Date().toLocaleString()} ${logContent} \n`, 'utf-8');
}

export function get_log() {
  return fs.readFileSync(logFile, 'utf-8');
}

export function clear_log() {
  fs.writeFileSync(logFile, '', 'utf-8')
}
/**
 * 获取配置文件
 * @description: 获取配置文件
 * @returns 
 */
export function get_config() {
  if (!fs.existsSync(configFile)) {
    return null
  }
  const configStr = fs.readFileSync(configFile, 'utf-8')
  const config = JSON.parse(configStr)
  return config
}

/**
 * 
 * @param config 配置文件内容
 */
export function set_config(config: any) {
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8')
  } else {
    const configStr = fs.readFileSync(configFile, 'utf-8')
    const oldConfig = JSON.parse(configStr)
    const newConfig = { ...oldConfig, ...config }
    fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf-8')
  }
}


export function end_app() {
  const config = get_config()
  if (config.endAfterSetCookie) {
    set_config({ endAfterSetCookie: false })
    console.log('程序结束')
    process.exit(0)
  }
}