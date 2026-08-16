const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// Вырезает кадр из видео через 1 секунду в миниатюру 160x120 (4:3, как в 2008-2012).
// Возвращает true/false — при ошибке используем заглушку.
function generateThumbnail(srcPath, outPath) {
  return new Promise((resolve) => {
    ffmpeg(srcPath)
      .seekInput('00:00:01')
      .frames(1)
      .outputOptions([
        '-vf',
        'scale=160:120:force_original_aspect_ratio=decrease,pad=160:120:(ow-iw)/2:(oh-ih)/2:black',
      ])
      .output(outPath)
      .on('end', () => resolve(true))
      .on('error', () => resolve(false))
      .run();
  });
}

module.exports = { generateThumbnail };