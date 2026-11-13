package com.mingxing.school.shop;

import android.os.Handler;
import android.os.Looper;

import com.mingxing.school.BuildConfig;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 明星商店接口客户端。
 * 服务端把商店子应用挂载在 /shop，业务接口位于 /shop/api，
 * 响应格式为成功 {ok:true, data:...}、失败 {ok:false, error:{code, message}}，
 * 与广播器一致、与主站 {success:true} 不同，因此单独封装解析，避免混淆。
 * 认证沿用平台 Bearer 令牌（主入口 requireLogin 已校验，这里每个请求都带上）。
 */
public final class ShopApi {

    /** 接口根地址：主服务地址 + /shop/api */
    private static final String BASE = BuildConfig.API_BASE_URL + "/shop/api";
    /** 连接超时（毫秒） */
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    /** 读取超时（毫秒） */
    private static final int READ_TIMEOUT_MS = 10_000;
    /** 网络线程池：商品、购物车、订单可能同时请求，3 条线程足够 */
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(3);
    /** 主线程 Handler：把结果切回 UI 线程回调 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 工具类不允许实例化 */
    private ShopApi() {
    }

    /** 请求结果回调，两个方法都在主线程执行 */
    public interface Callback {

        /**
         * 请求成功
         * @param root 服务端完整响应，业务数据在 data 字段（对象或数组）
         */
        void onSuccess(JSONObject root);

        /**
         * 请求失败
         * @param message 可直接展示的中文提示
         */
        void onFailure(String message);
    }

    /**
     * 把服务端返回的相对图片路径拼成绝对地址
     * 商品图形如 /shop/uploads/xxx.jpg，需要主服务地址前缀才能下载
     * @param path 相对路径，可为空
     * @return 绝对地址；入参为空时返回空串
     */
    public static String imageUrl(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        if (path.startsWith("http://") || path.startsWith("https://")) {
            return path;
        }
        return BuildConfig.API_BASE_URL + path;
    }

    /**
     * 对路径片段做 URL 编码（购物车 lineKey 含 | 与中文规格文本）
     * URLEncoder 会把空格编成 +，路径中必须转成 %20
     * @param segment 原始片段
     * @return 可安全放进 URL 路径的编码结果
     */
    public static String enc(String segment) {
        try {
            return URLEncoder.encode(segment == null ? "" : segment, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    // ==================== 店铺 ====================

    /**
     * 查询店铺列表（普通用户只返回营业中的店铺 + 自己开设的店铺）
     * @param token 登录令牌
     * @param cb 结果回调，data 为店铺数组
     */
    public static void getShops(String token, Callback cb) {
        request("GET", "/shops", null, token, cb);
    }

    /**
     * 查询店铺详情
     * @param shopId 店铺 id
     * @param token 登录令牌
     * @param cb 结果回调，data 为店铺对象
     */
    public static void getShop(String shopId, String token, Callback cb) {
        request("GET", "/shops/" + enc(shopId), null, token, cb);
    }

    /**
     * 查询「我的店铺」列表（含休息中/被查封的店铺，仅返回自己开设的）
     * @param token 登录令牌
     * @param cb 结果回调，data 为店铺数组
     */
    public static void getMyShops(String token, Callback cb) {
        request("GET", "/shops?mine=1", null, token, cb);
    }

    /**
     * 新建店铺（所有登录用户可开店，归属创建者本人）
     * @param body {name, description, category, image, emoji, isOpen}
     * @param token 登录令牌
     * @param cb 结果回调，data 为新建的店铺对象
     */
    public static void createShop(JSONObject body, String token, Callback cb) {
        request("POST", "/shops", body, token, cb);
    }

    /**
     * 修改店铺（店主本人或管理员；未传的字段沿用原值）
     * @param shopId 店铺 id
     * @param body 需要变更的字段，如 {isOpen:false}
     * @param token 登录令牌
     * @param cb 结果回调，data 为更新后的店铺对象
     */
    public static void updateShop(String shopId, JSONObject body, String token, Callback cb) {
        request("PUT", "/shops/" + enc(shopId), body, token, cb);
    }

    /**
     * 删除店铺（连带删除其全部商品并清理购物车）
     * @param shopId 店铺 id
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void deleteShop(String shopId, String token, Callback cb) {
        request("DELETE", "/shops/" + enc(shopId), null, token, cb);
    }

    /**
     * 上传图片（base64 DataURL → 服务端落盘返回可访问地址）
     * @param dataUrl 形如 data:image/jpeg;base64,xxxx 的字符串
     * @param token 登录令牌
     * @param cb 结果回调，data 为 {url:'/shop/uploads/xxx.jpg'}
     */
    public static void uploadImage(String dataUrl, String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("dataUrl", dataUrl);
        } catch (Exception ignored) {
            // 字符串写入不会抛异常
        }
        request("POST", "/upload/image", body, token, cb);
    }

    // ==================== 商品 ====================

    /**
     * 查询商品列表
     * @param shopId 店铺 id，空串表示全部店铺
     * @param token 登录令牌
     * @param cb 结果回调，data 为商品数组
     */
    public static void getProducts(String shopId, String token, Callback cb) {
        // 只按店铺筛选；普通用户在非本人店铺时服务端只会返回在售商品
        String path = "/products" + (shopId == null || shopId.isEmpty() ? "" : "?shopId=" + enc(shopId));
        request("GET", path, null, token, cb);
    }

    /**
     * 新建商品（店主本人或管理员，必须属于自己管理的店铺）
     * @param body 商品字段：shopId/name/description/price/image/emoji/category/isAvailable/isCombo/specs/comboGroups
     * @param token 登录令牌
     * @param cb 结果回调，data 为新建的商品对象
     */
    public static void createProduct(JSONObject body, String token, Callback cb) {
        request("POST", "/products", body, token, cb);
    }

    /**
     * 修改商品（所属店铺的店主本人或管理员）
     * @param productId 商品 id
     * @param body 需要变更的字段，未传的沿用原值
     * @param token 登录令牌
     * @param cb 结果回调，data 为更新后的商品对象
     */
    public static void updateProduct(String productId, JSONObject body, String token, Callback cb) {
        request("PUT", "/products/" + enc(productId), body, token, cb);
    }

    /**
     * 删除商品（同时从所有用户购物车移除）
     * @param productId 商品 id
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void deleteProduct(String productId, String token, Callback cb) {
        request("DELETE", "/products/" + enc(productId), null, token, cb);
    }

    // ==================== 购物车 ====================

    /**
     * 查询当前用户购物车
     * @param token 登录令牌
     * @param cb 结果回调，data 为 {items, totalAmount, count}
     */
    public static void getCart(String token, Callback cb) {
        request("GET", "/cart", null, token, cb);
    }

    /**
     * 加入购物车
     * @param body {productId, quantity, specs?:[...], combo?:[{groupName,label,count}]}
     * @param token 登录令牌
     * @param cb 结果回调，data 为最新购物车视图
     */
    public static void addToCart(JSONObject body, String token, Callback cb) {
        request("POST", "/cart", body, token, cb);
    }

    /**
     * 修改购物车某行数量（数量 <= 0 即移除该行）
     * @param lineKey 购物车行唯一标识（含规格文本，需 URL 编码）
     * @param quantity 目标数量
     * @param token 登录令牌
     * @param cb 结果回调，data 为最新购物车视图
     */
    public static void updateCartLine(String lineKey, int quantity, String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("quantity", quantity);
        } catch (Exception ignored) {
            // 数值写入不会抛异常，此处仅作防御
        }
        request("PUT", "/cart/line/" + enc(lineKey), body, token, cb);
    }

    /**
     * 清空购物车
     * @param token 登录令牌
     * @param cb 结果回调，data 为空的购物车视图
     */
    public static void clearCart(String token, Callback cb) {
        request("DELETE", "/cart", null, token, cb);
    }

    // ==================== 订单 ====================

    /**
     * 把购物车整体下单（上门取货模式，无需地址）
     * @param body {note} 备注可为空
     * @param token 登录令牌
     * @param cb 结果回调，data 为订单对象（含 remainingPoints 剩余积分）
     */
    public static void createOrder(JSONObject body, String token, Callback cb) {
        request("POST", "/orders", body, token, cb);
    }

    /**
     * 查询订单列表
     * @param all true 表示管理员查看全部订单（服务端会校验权限）
     * @param token 登录令牌
     * @param cb 结果回调，data 为订单数组（已带 statusText 与商品图）
     */
    public static void getOrders(boolean all, String token, Callback cb) {
        request("GET", all ? "/orders?all=1" : "/orders", null, token, cb);
    }

    /**
     * 查询订单详情
     * @param orderId 订单 id
     * @param token 登录令牌
     * @param cb 结果回调，data 为订单对象
     */
    public static void getOrder(String orderId, String token, Callback cb) {
        request("GET", "/orders/" + enc(orderId), null, token, cb);
    }

    /**
     * 取消订单（仅待确认状态可取消）
     * @param orderId 订单 id
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void cancelOrder(String orderId, String token, Callback cb) {
        request("POST", "/orders/" + enc(orderId) + "/cancel", new JSONObject(), token, cb);
    }

    /**
     * 提交退款申请（进入待审核，管理员通过后才返还积分）
     * @param orderId 订单 id
     * @param reason 退款理由，可为空
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void requestRefund(String orderId, String reason, String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("reason", reason == null ? "" : reason);
        } catch (Exception ignored) {
            // 字符串写入不会抛异常
        }
        request("POST", "/orders/" + enc(orderId) + "/refund", body, token, cb);
    }

    /**
     * 管理员修改订单状态（首次进入待取货时服务端会自动发待取件通知）
     * @param orderId 订单 id
     * @param status 目标状态：pending/confirmed/delivering/completed/cancelled
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void adminUpdateStatus(String orderId, String status, String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("status", status);
        } catch (Exception ignored) {
            // 字符串写入不会抛异常
        }
        request("PUT", "/admin/orders/" + enc(orderId) + "/status", body, token, cb);
    }

    /**
     * 管理员审核退款申请
     * @param orderId 订单 id
     * @param approve true 通过（返还买家积分并从店主扣回），false 拒绝
     * @param note 拒绝理由，可为空
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void adminReviewRefund(String orderId, boolean approve, String note,
                                         String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("approve", approve);
            body.put("note", note == null ? "" : note);
        } catch (Exception ignored) {
            // 写入不会抛异常
        }
        request("PUT", "/admin/orders/" + enc(orderId) + "/refund", body, token, cb);
    }

    // ==================== 管理端 ====================

    /**
     * 管理员查封店铺并发送《限期整改告知》邮件
     * @param shopId 店铺 id
     * @param body {grade, className, deadline, issues:[...]}
     * @param token 登录令牌
     * @param cb 结果回调，data 为店铺对象（可能附带 mailNotice 邮件发送结果）
     */
    public static void seizeShop(String shopId, JSONObject body, String token, Callback cb) {
        request("POST", "/admin/shops/" + enc(shopId) + "/seize", body, token, cb);
    }

    /**
     * 管理员解封店铺（清除查封记录，营业状态需再手动开启）
     * @param shopId 店铺 id
     * @param token 登录令牌
     * @param cb 结果回调，data 为解封后的店铺对象
     */
    public static void unseizeShop(String shopId, String token, Callback cb) {
        request("POST", "/admin/shops/" + enc(shopId) + "/unseize", new JSONObject(), token, cb);
    }

    /**
     * 管理员统计：订单数、销售额、今日订单、热销商品 Top5
     * @param token 登录令牌
     * @param cb 结果回调，data 为 {totalOrders,totalRevenue,todayOrders,topProducts}
     */
    public static void getStats(String token, Callback cb) {
        request("GET", "/admin/stats", null, token, cb);
    }

    // ==================== 内部请求实现 ====================

    /**
     * 执行一次 JSON 请求（内部在子线程运行）
     * @param method HTTP 方法，支持 GET/POST/PUT/DELETE
     * @param path 相对 /shop/api 的路径
     * @param body 请求体，GET/DELETE 时可为 null
     * @param token 登录令牌，为空则不携带 Authorization 头
     * @param cb 结果回调
     */
    private static void request(String method, String path, JSONObject body, String token, Callback cb) {
        EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(BASE + path).openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("X-Client-Type", "MingxingSchool-Android");
                if (token != null && !token.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                }
                if (body != null) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    }
                }

                int code = conn.getResponseCode();
                // 非 2xx 时错误 JSON 位于 errorStream
                InputStream stream = (code >= 200 && code < 300)
                        ? conn.getInputStream()
                        : conn.getErrorStream();
                String text = readAll(stream);
                JSONObject root = text.isEmpty() ? new JSONObject() : new JSONObject(text);

                if (code >= 200 && code < 300 && root.optBoolean("ok", false)) {
                    postSuccess(cb, root);
                } else {
                    // 服务端统一把可展示文案放在 error.message
                    JSONObject error = root.optJSONObject("error");
                    String message = error == null ? "" : error.optString("message", "");
                    postFailure(cb, message.isEmpty() ? "请求失败（HTTP " + code + "）" : message);
                }
            } catch (Exception e) {
                // 网络不可达、超时、解析失败统一归为网络异常
                postFailure(cb, "网络异常，请检查网络后重试");
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    /**
     * 把成功结果切回主线程回调
     * @param cb 调用方回调
     * @param root 响应 JSON
     */
    private static void postSuccess(Callback cb, JSONObject root) {
        MAIN.post(() -> cb.onSuccess(root));
    }

    /**
     * 把失败提示切回主线程回调
     * @param cb 调用方回调
     * @param message 中文错误提示
     */
    private static void postFailure(Callback cb, String message) {
        MAIN.post(() -> cb.onFailure(message));
    }

    /**
     * 读取输入流全部字节并按 UTF-8 解码
     * @param in 输入流，可能为 null
     * @return 响应文本，无内容时返回空串
     * @throws Exception 读取失败时抛出
     */
    private static String readAll(InputStream in) throws Exception {
        if (in == null) {
            return "";
        }
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];   // 每次读取的缓冲区
            int len;                          // 本次读取到的字节数
            while ((len = input.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
