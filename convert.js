const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getPcmFiles(folderPath) {
    return fs.readdirSync(folderPath).filter(file => file.endsWith('.pcm'));
}

function convertPcmToMp3(folderPath, outputFolderPath, pcmFiles) {
    const alreadyExistMp3 = fs.readdirSync(outputFolderPath).filter(file => file.endsWith('.mp3'));

    pcmFiles.forEach(pcmFile => {
        const mp3FileName = pcmFile.replace('.pcm', '.mp3');

        if (alreadyExistMp3.includes(mp3FileName)) {
            return;
        }

        const pcmPath = path.join(folderPath, pcmFile);
        const mp3Path = path.join(outputFolderPath, mp3FileName);
        const command = `ffmpeg -f s16le -ar 48000 -ac 2 -i "${pcmPath}" "${mp3Path}"`;

        execSync(command);
    });
}

function mergeMp3Files(outputFolderPath, mergedFilePath) {
    const mp3Files = fs.readdirSync(outputFolderPath).filter(file => file.endsWith('.mp3'));
    const fileListPath = path.join(outputFolderPath, 'filelist.txt');

    // Создаем файл со списком всех MP3 файлов
    const fileListContent = mp3Files.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(fileListPath, fileListContent);

    const command = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${mergedFilePath}"`;

    execSync(command);
    cleanUp(outputFolderPath, fileListPath, mergedFilePath, folderPath); 
}

function cleanUp(outputFolderPath, fileListPath, mergedFilePath, folderPath) {
    // Удаляем временный файл со списком
    fs.unlinkSync(fileListPath);

    // Удаляем все MP3 файлы, кроме итогового объединенного файла
    fs.readdirSync(outputFolderPath).forEach(file => {
        if (file.endsWith('.mp3') && path.join(outputFolderPath, file) !== mergedFilePath) {
            fs.unlinkSync(path.join(outputFolderPath, file));
        }
    });

    // Удаляем все PCM файлы
    fs.readdirSync(folderPath).forEach(file => {
        if (file.endsWith('.pcm')) {
            fs.unlinkSync(path.join(folderPath, file));
        }
    });
}



module.exports = {
    getPcmFiles,
    convertPcmToMp3,
    mergeMp3Files,
    cleanUp
};
