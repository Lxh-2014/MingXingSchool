const fs = require('fs');
const path = require('path');

// 从客户端locales文件夹加载语言文件
let locales = {};

try {
    const localePath = path.join(__dirname, '../../client/assets/lang/zh_cn.json');
    let raw = fs.readFileSync(localePath, 'utf8');
    // 去掉 Windows 编辑器可能写入的 UTF-8 BOM（EF BB BF / U+FEFF），否则 JSON.parse 会报 Unexpected token
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    locales = JSON.parse(raw);
} catch (error) {
    console.error('加载语言文件失败:', error);
    // 使用默认文本
    locales = {
        server: { startupMessage: '明星云网盘服务器已启动' },
        auth: {
            missingUsernameOrPassword: '请输入姓名和学号',
            userNotFound: '用户不存在',
            wrongPassword: '学号错误',
            loginSuccess: '登录成功'
        },
        files: {
            selectFile: '请选择要上传的文件',
            uploadSuccess: '文件上传成功',
            uploadFailed: '文件上传失败',
            enterFolderName: '请输入文件夹名称',
            invalidChars: '文件名不能包含下列任何字符：\\/:*?"<>|',
            invalidDeviceName: '指定的设备名无效',
            folderExists: '此目标已包含名为"{name}"的文件夹。',
            folderCreated: '文件夹创建成功',
            specifyPath: '请指定要删除的路径',
            notExist: '文件或文件夹不存在',
            deleted: '删除成功',
            deleteFailed: '删除失败',
            provideOldPathAndNewName: '请提供旧路径和新名称',
            renamed: '重命名成功',
            renameFailed: '重命名失败',
            specifyFilePath: '请指定文件路径',
            fileNotFound: '文件不存在',
            cannotDownloadFolder: '无法下载文件夹'
        }
    };
}

function t(key, params = {}) {
    const keys = key.split('.');
    let value = locales;
    for (const k of keys) {
        value = value?.[k];
        if (!value) return key;
    }
    if (typeof value === 'string') {
        return value.replace(/{(\w+)}/g, (match, p1) => params[p1] || match);
    }
    return value;
}

module.exports = { locales, t };
