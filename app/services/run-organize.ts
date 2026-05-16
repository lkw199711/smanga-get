import GameOrganize from './game-organize.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    // 设置games目录为源目录
    // const gamesDir = path.join(__dirname, 'games');
    const gamesDir = 'D:\\17H-game整理\\04'; // 设置为你的games目录
    
    // 检查目录是否存在
    if (!fs.existsSync(gamesDir)) {
        console.error('❌ games目录不存在:', gamesDir);
        process.exit(1);
    }
    
    console.log('🎮 游戏整理工具');
    console.log('源目录:', gamesDir);
    console.log('');
    
    const organizer = new GameOrganize(gamesDir);
    
    try {
        await organizer.execute();
    } catch (error) {
        console.error('❌ 整理失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
