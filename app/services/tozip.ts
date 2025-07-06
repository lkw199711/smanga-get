import { log } from "node:console";
import { spawn } from "node:child_process";
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module'
import { s_delete, copy_folder, read_json, end_app } from "#utils/index";
const require = createRequire(import.meta.url)
const archiver = require('archiver');

class ToZip {
    mangaFloder: string = '';
    outFloder: string = '';
    constructor(mangaFloder: string) {
        this.mangaFloder = mangaFloder;
        this.outFloder = 'M:\\manga\\omegascans';
    }

    async start() {
        const items = fs.readdirSync(this.mangaFloder);
        for (let i = 0; i < items.length; i++) {
            const fileName = items[i];
            const filePath = path.join(this.mangaFloder, fileName);
            const outMangaPath = path.join(this.outFloder, fileName);

            if (/zip/.test(fileName)) {
                console.log('跳过压缩包', fileName);
                continue;
            } else if (/smanga-info/.test(fileName)) {
                // s_delete(filePath);
                // copy_folder(filePath, `${this.outFloder}\\${fileName}`);
                // await zip_directory(filePath, `${this.outFloder}\\${fileName}.zip`);
            } else {
                /*
                const files = fs.readdirSync(filePath);
                const jpgFiles = files.filter(file => {
                    return /(.jpg|.webp)/.test(file);
                });
                jpgFiles.forEach(file => { 
                    const filePath1 = path.join(filePath, file);
                    s_delete(filePath1);
                })*/
                const metaFile = `${filePath}-smanga-info\\meta.json`;
                if (!fs.existsSync(metaFile)) continue;
                const meta = read_json(metaFile);
                if (meta.status !== 'Completed') continue; // 只处理已完成的漫画

                if (!fs.existsSync(outMangaPath)) {
                    fs.mkdirSync(outMangaPath, { recursive: true });
                }

                // 复制元数据文件夹
                copy_folder(`${filePath}-smanga-info`, `${this.outFloder}\\${fileName}-smanga-info`);
                // await zip_jpg(filePath, `${this.outFloder}\\${fileName}-covers.zip`);
                await zipAndRemoveFolders(filePath, `${this.outFloder}\\${fileName}`);
                end_app()
            }

        }
    }

    getMangaList(directoryPath: string) {
        const items = fs.readdirSync(directoryPath, { withFileTypes: false });
        const folders = items.filter(item => {
            if (/smanga-info/.test(item)) {
                return false;
            }

            return true;
        });

        return folders.map(folder => path.join(directoryPath, folder));
    }


    async zipAndRemoveFolders(directoryPath: string) {
        try {
            // 读取目录内容
            const items = fs.readdirSync(directoryPath, { withFileTypes: true });

            // 筛选出子文件夹
            const folders = items.filter(item => item.isDirectory());

            if (folders.length === 0) {
                console.log('没有找到任何子文件夹', directoryPath);
                return;
            }

            // 处理每个子文件夹
            for (const folder of folders) {
                const folderPath = path.join(directoryPath, folder.name);
                const zipPath = path.join(directoryPath, `${folder.name}.zip`);

                // 检查是否存在 zip 文件 存在则删除
                if (fs.existsSync(zipPath)) {
                    fs.rmSync(zipPath, { recursive: true, force: true });
                }

                // 创建输出流
                const output = fs.createWriteStream(zipPath);

                const archive = archiver('zip', { zlib: { level: 9 } });

                // 监听完成事件
                output.on('close', () => {
                    console.log(`${folder.name}.zip 已创建 (${archive.pointer()} bytes)`);

                    // 删除源文件夹
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    console.log(`已删除源文件夹: ${folder.name}`);
                });

                // 监听错误
                archive.on('error', (err) => {
                    throw err;
                });

                // 管道连接
                archive.pipe(output);

                // 添加文件夹内容
                archive.directory(folderPath, false);

                // 完成归档
                await archive.finalize();
            }

            console.log('所有文件夹处理完成');
        } catch (err) {
            console.error('处理过程中出错:', err);
        }
    }
}


function zip_directory(sourceDir: string, outputPath: string) {
    return new Promise((resolve, reject) => {

        // 创建输出流
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        // 监听完成事件
        output.on('close', () => {
            console.log(`${outputPath}.zip 已创建 (${archive.pointer()} bytes)`);
            resolve(true);
        });

        // 监听错误
        archive.on('error', (err: any) => {
            reject(err);
            throw err;
        });

        // 管道连接
        archive.pipe(output);

        // 添加文件夹内容
        archive.directory(sourceDir, false);

        // 完成归档
        archive.finalize();
    })

}

function zip_jpg(sourceDir: string, outputPath: string) {
    return new Promise((resolve, reject) => {

        // 创建输出流
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        // 监听完成事件
        output.on('close', () => {
            console.log(`${outputPath}.zip 已创建 (${archive.pointer()} bytes)`);
            resolve(true);
        });

        // 监听错误
        archive.on('error', (err: any) => {
            reject(err);
            throw err;
        });

        // 管道连接
        archive.pipe(output);

        // 遍历目录并排除文件
        fs.readdirSync(sourceDir).forEach(file => {
            const fullPath = `${sourceDir}/${file}`;
            if (/(.jpg|.webp)/.test(file)) {
                archive.file(fullPath, { name: file });
            }
        });

        // 完成归档
        archive.finalize();
    })

}

async function zipAndRemoveFolders(sourceDir: string, outputPath: string) {
    try {
        // 读取目录内容
        const items = fs.readdirSync(sourceDir, { withFileTypes: true });

        // 筛选出子文件夹
        // const folders = items.filter(item => item.isDirectory());

        // if (folders.length === 0) {
        //     console.log('没有找到任何子文件夹', sourceDir);
        //     return;
        // }

        // 处理每个子文件夹
        for (const item of items) {
            // 文件直接复制
            if (!item.isDirectory()) {
                const sourceFile = path.join(sourceDir, item.name);
                const outputFile = path.join(outputPath, item.name);
                fs.copyFileSync(sourceFile, outputFile);
                continue;
            }

            // 目录打包zip
            const folderPath = path.join(sourceDir, item.name);
            const zipPath = path.join(outputPath, `${item.name}.zip`);

            // 检查是否存在 zip 文件 存在则跳过
            if (fs.existsSync(zipPath)) {
                // fs.rmSync(zipPath, { recursive: true, force: true });
                continue;
            }

            await zip_directory(folderPath, zipPath)
        }

        console.log('所有文件夹处理完成');
    } catch (err) {
        console.error('处理过程中出错:', err);
    }
}

function zipAndRemoveFoldersSync(directoryPath: string) {
    try {
        // 读取目录内容
        const items = fs.readdirSync(directoryPath, { withFileTypes: true });

        // 筛选出子文件夹
        const folders = items.filter(item => item.isDirectory());

        if (folders.length === 0) {
            console.log('没有找到任何子文件夹');
            return;
        }

        // 同步处理每个子文件夹
        for (const folder of folders) {
            const folderPath = path.join(directoryPath, folder.name);
            const zipPath = path.join(directoryPath, `${folder.name}.zip`);

            console.log(`开始处理文件夹: ${folder.name}`);

            // 创建输出流
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });

            // 使用Promise确保同步完成
            const zipPromise = new Promise((resolve, reject) => {
                output.on('close', () => {
                    console.log(`${folder.name} 创建完成 (${archive.pointer()} bytes)`);
                    resolve();
                });

                archive.on('error', (err: any) => {
                    reject(err);
                });

                archive.pipe(output);
                archive.directory(folderPath, false);
                archive.finalize();
            });

            // 等待当前压缩完成
            zipPromise.then(() => {
                // 删除源文件夹
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`已删除源文件夹: ${folder.name}`);
            }).catch(err => {
                console.error(`处理 ${folder.name} 时出错:`, err);
            });
        }

        console.log('所有文件夹处理完成');
    } catch (err) {
        console.error('处理过程中出错:', err);
    }
}



/*
// 使用示例 - 替换为你的目标目录路径
const targetDirectory = './test'; // 修改为你的目录路径
zipAndRemoveFolders(targetDirectory);
*/

export default ToZip;