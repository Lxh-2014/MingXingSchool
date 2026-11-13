/**
 * 网盘数据层 —— 用户部分
 * ----------------------------------------------------------
 * 用户数据统一走主项目的 userStore（一人一文件存储，见 server/core/userStore.js），
 * 本文件不再直接读写 users.json，只做接口转发，保持网盘各路由的原有调用方式不变。
 */
const path = require('path');
const fs = require('fs');

/** 共享用户库（主项目核心模块） */
const store = require(path.resolve(__dirname, '../../../../server/core/userStore'));

// 全部用户接口直接委托给共享用户库
module.exports = {
    hashPassword: store.hashPassword,
    loadUsers: store.loadUsers,
    saveUsers: store.saveUsers,
    getUserById: store.getUserById,
    findIdByName: store.findIdByName,
    verifyLogin: store.verifyLogin,
    changePassword: store.changePassword,
    /** 取得所有普通用户的姓名列表（不包含 Admin），供网盘分享选择等场景 */
    listNormalUserNames: () =>
        store.listUsers().map(u => u.name).filter(name => name !== store.ADMIN_NAME),
    /** 头像设为图片模式（图片文件由上传接口直接写入，用户条目不再记录头像状态，仅校验用户存在） */
    setAvatarPicture: (id) => !!store.getUserById(id),
    /** 头像设为纯色模式（纯色功能已移除，兼容保留：不持久化任何数据） */
    setAvatarColor: (id, color) => !!store.getUserById(id),
    /** 清除头像设置 = 恢复默认头像：删除头像图片文件 */
    clearAvatarSetting: (id) => {
        if (!store.getUserById(id)) return false;
        try {
            const file = path.join(__dirname, '..', 'assets', 'user', `${id}.png`);
            if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (_) { /* 文件删除失败不阻塞流程 */ }
        return true;
    },
    ADMIN_ID: store.ADMIN_ID,
    ADMIN_NAME: store.ADMIN_NAME
};
