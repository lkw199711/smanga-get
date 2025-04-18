/*
 * @Author: lkw199711 lkw199711@163.com
 * @Date: 2024-11-17 18:33:54
 * @LastEditors: lkw199711 lkw199711@163.com
 * @LastEditTime: 2024-11-17 18:38:44
 * @FilePath: \manga-get\test.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import sharp from 'sharp';


// 转换AVIF到JPG
async function avifToJpg(inputPath, outputPath) {
    try {
        await sharp(inputPath)
            .jpeg() // 指定输出格式为JPEG
            .toFile(outputPath); // 输出文件路径
        // console.log('转换成功，输出路径:', outputPath);
    } catch (err) {
        console.error('转换失败:', err);
    }
}


avifToJpg('C:\\Users\\lkw\\Downloads\\b8678c3732f889343c8de097c91e55f6cfff8307.jpg@1100w.avif',
    'C:\\Users\\lkw\\Downloadsb8678c3732f889343c8de097c91e55f6cfff8307.jpg'
)