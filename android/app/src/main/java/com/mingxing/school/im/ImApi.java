package com.mingxing.school.im;

import com.mingxing.school.net.ApiClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * 邻语（IM）接口封装
 * ----------------------------------------------------------
 * 服务端挂载在 /im/api，统一返回 { ok:true, data } / { ok:false, error:{code,message} }。
 * 本类只负责拼路径与请求体，网络与线程切换交给 {@link ApiClient}。
 */
public final class ImApi {

    /** 邻语接口前缀（相对 BuildConfig.API_BASE_URL） */
    private static final String PREFIX = "/im/api";

    /** 工具类不允许实例化 */
    private ImApi() {
    }

    /**
     * 拉取当前用户的会话列表（按最后消息时间倒序，含未读数）
     * @param token 登录令牌
     * @param cb 结果回调，data 为会话数组
     */
    public static void conversations(String token, ApiClient.Callback cb) {
        ApiClient.get(PREFIX + "/conversations", token, cb);
    }

    /**
     * 拉取会话消息
     * @param convId 会话 ID
     * @param after 只返回该消息 ID 之后的新消息，为 null 时拉取全部
     * @param token 登录令牌
     * @param cb 结果回调，data 为消息数组
     */
    public static void messages(String convId, String after, String token, ApiClient.Callback cb) {
        String path = PREFIX + "/conversations/" + enc(convId) + "/messages";   // 请求路径
        if (after != null && !after.isEmpty()) {
            path += "?after=" + enc(after);
        }
        ApiClient.get(path, token, cb);
    }

    /**
     * 标记会话已读：进入聊天页时调用，清掉列表红点
     * @param convId 会话 ID
     * @param token 登录令牌
     * @param cb 结果回调，可为 null
     */
    public static void markRead(String convId, String token, ApiClient.Callback cb) {
        ApiClient.post(PREFIX + "/conversations/" + enc(convId) + "/read", new JSONObject(), token, cb);
    }

    /**
     * 发送文本消息
     * @param convId 会话 ID
     * @param text 消息正文（不可为空）
     * @param token 登录令牌
     * @param cb 结果回调，data 为新建的消息
     */
    public static void sendText(String convId, String text, String token, ApiClient.Callback cb) {
        try {
            JSONObject body = new JSONObject();
            body.put("text", text);
            ApiClient.post(PREFIX + "/conversations/" + enc(convId) + "/messages", body, token, cb);
        } catch (Exception e) {
            if (cb != null) cb.onFailure("消息发送失败");
        }
    }

    /**
     * 发送图片消息（单张，data URL 形式）
     * @param convId 会话 ID
     * @param dataUrl 形如 data:image/jpeg;base64,xxx
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void sendImage(String convId, String dataUrl, String token, ApiClient.Callback cb) {
        try {
            JSONObject part = new JSONObject();      // 图文片段：只有一个图片片段
            part.put("type", "image");
            part.put("dataUrl", dataUrl);
            org.json.JSONArray parts = new org.json.JSONArray();   // 有序片段列表
            parts.put(part);
            JSONObject body = new JSONObject();
            body.put("parts", parts);
            ApiClient.post(PREFIX + "/conversations/" + enc(convId) + "/images", body, token, cb);
        } catch (Exception e) {
            if (cb != null) cb.onFailure("图片发送失败");
        }
    }

    /**
     * 发送文件消息
     * @param convId 会话 ID
     * @param name 原始文件名（用于展示与下载）
     * @param dataUrl 形如 data:application/pdf;base64,xxx
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void sendFile(String convId, String name, String dataUrl, String token, ApiClient.Callback cb) {
        try {
            JSONObject body = new JSONObject();
            body.put("name", name);
            body.put("dataUrl", dataUrl);
            ApiClient.post(PREFIX + "/conversations/" + enc(convId) + "/files", body, token, cb);
        } catch (Exception e) {
            if (cb != null) cb.onFailure("文件发送失败");
        }
    }

    /**
     * 拉取会话详情：成员列表、群公告、我的偏好等（群设置页使用）
     * @param convId 会话 ID
     * @param token 登录令牌
     * @param cb 结果回调，data 为会话详情
     */
    public static void detail(String convId, String token, ApiClient.Callback cb) {
        ApiClient.get(PREFIX + "/conversations/" + enc(convId), token, cb);
    }

    /**
     * 修改我对该会话的偏好（置顶 / 免打扰 / 备注 / 群身份）
     * @param convId 会话 ID
     * @param prefs 偏好字段 JSON，如 {"pinned":true}
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void updatePrefs(String convId, JSONObject prefs, String token, ApiClient.Callback cb) {
        ApiClient.patch(PREFIX + "/conversations/" + enc(convId) + "/prefs", prefs, token, cb);
    }

    /**
     * 修改群资料（群名称 / 群公告，群主或管理员可用）
     * @param convId 会话 ID
     * @param body 修改字段 JSON，如 {"title":"新群名"}
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void updateConversation(String convId, JSONObject body, String token, ApiClient.Callback cb) {
        ApiClient.patch(PREFIX + "/conversations/" + enc(convId), body, token, cb);
    }

    /**
     * 邀请成员进群
     * @param convId 会话 ID
     * @param memberIds 待邀请的用户 ID 数组
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void invite(String convId, JSONArray memberIds, String token, ApiClient.Callback cb) {
        try {
            JSONObject body = new JSONObject();
            body.put("memberIds", memberIds);
            ApiClient.post(PREFIX + "/conversations/" + enc(convId) + "/members", body, token, cb);
        } catch (Exception e) {
            if (cb != null) cb.onFailure("邀请失败");
        }
    }

    /**
     * 搜索用户（按用户 ID 或姓名模糊匹配，最多 10 条）
     * @param q 关键词
     * @param token 登录令牌
     * @param cb 结果回调，data 为用户数组
     */
    public static void searchUsers(String q, String token, ApiClient.Callback cb) {
        ApiClient.get(PREFIX + "/users?q=" + enc(q), token, cb);
    }

    /**
     * 把服务端返回的相对地址拼成绝对地址（图片/群头像/文件下载都用它）
     * @param path 形如 /im/api/images/xxx.jpg，已是 http 开头时原样返回
     * @return 绝对地址；入参为空时返回空串
     */
    public static String absolute(String path) {
        if (path == null || path.isEmpty()) return "";
        if (path.startsWith("http://") || path.startsWith("https://")) return path;
        return ApiClient.baseUrl() + path;
    }

    /**
     * URL 编码（会话 ID 可能包含中文或空格）
     * @param value 原始字符串
     * @return 编码后的字符串
     */
    private static String enc(String value) {
        try {
            return URLEncoder.encode(value == null ? "" : value, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return value == null ? "" : value;
        }
    }
}
