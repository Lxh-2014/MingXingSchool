package com.mingxing.school;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Toast;

import com.mingxing.school.data.SessionStore;
import com.mingxing.school.databinding.ActivityLoginBinding;
import com.mingxing.school.net.AuthApi;

/**
 * 登录页
 * 职责：收集姓名与学号，调用统一登录接口 /api/auth/login；
 *      成功后保存会话并进入主页，失败时在表单下方展示服务端返回的中文原因。
 */
public class LoginActivity extends BaseActivity {

    /** 视图绑定对象，替代 findViewById，避免空指针与类型转换错误 */
    private ActivityLoginBinding binding;
    /** 本地会话存储，用于判断已登录状态与写入令牌 */
    private SessionStore sessionStore;

    /**
     * 页面创建：绑定布局、初始化会话存储、已登录则直接进主页、注册登录事件
     * @param savedInstanceState 页面重建时的历史状态，首次创建为 null
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityLoginBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        // 全面屏适配：让根视图让出状态栏与底部手势条安全区
        applySystemBarsInsets(binding.getRoot());
        // 系统栏取登录页淡蓝底色，使状态栏、页面、底部小横条连成一体
        setSystemBarColor(R.color.mx_login_bg);

        sessionStore = new SessionStore(this);

        // 已登录用户无需再次输入，直接进入主页
        if (sessionStore.isLoggedIn()) {
            openMainPage();
            return;
        }

        // 点击按钮触发登录
        binding.btnLogin.setOnClickListener(v -> doLogin());
        // 键盘“完成”键同样触发登录，减少一次手动点击
        binding.etPassword.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                doLogin();
                return true;
            }
            return false;
        });
    }

    /**
     * 页面销毁：释放视图绑定，避免 Activity 结束后仍被引用
     */
    @Override
    protected void onDestroy() {
        super.onDestroy();
        binding = null;
    }

    /**
     * 校验输入并发起登录请求
     * 校验顺序：先清空旧错误，再依次检查姓名、学号是否为空
     */
    private void doLogin() {
        // 去除首尾空格，避免用户误带空格导致匹配失败
        String username = trimOf(binding.etUsername.getText());
        // 密码保持原样，不裁剪，避免改变用户真实输入
        String password = rawOf(binding.etPassword.getText());

        showError(null);

        if (username.isEmpty()) {
            showError(getString(R.string.login_empty_account));
            return;
        }
        if (password.isEmpty()) {
            showError(getString(R.string.login_empty_password));
            return;
        }

        setLoading(true);
        AuthApi.login(username, password, new AuthApi.LoginCallback() {

            /**
             * 登录成功：保存会话、提示成功并进入主页
             * @param result 服务端返回的会话信息
             */
            @Override
            public void onSuccess(AuthApi.LoginResult result) {
                // 页面已关闭时不再操作 UI，防止崩溃
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                setLoading(false);
                sessionStore.save(
                        result.token,
                        result.userId,
                        result.username,
                        result.isAdmin,
                        result.avatar
                );
                Toast.makeText(LoginActivity.this, R.string.login_success, Toast.LENGTH_SHORT).show();
                openMainPage();
            }

            /**
             * 登录失败：恢复按钮并在表单下方展示中文错误
             * @param message 服务端返回或兜底的中文提示
             */
            @Override
            public void onFailure(String message) {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                setLoading(false);
                showError(message);
            }
        });
    }

    /**
     * 读取输入内容并去除首尾空格
     * @param content 输入框内容，可能为 null
     * @return 处理后的字符串，null 时返回空串
     */
    private String trimOf(CharSequence content) {
        return content == null ? "" : content.toString().trim();
    }

    /**
     * 读取输入内容原样返回（用于密码，不做裁剪）
     * @param content 输入框内容，可能为 null
     * @return 原始字符串，null 时返回空串
     */
    private String rawOf(CharSequence content) {
        return content == null ? "" : content.toString();
    }

    /**
     * 切换登录按钮的加载状态
     * @param loading true 表示正在请求：按钮禁用并显示“登录中…”
     */
    private void setLoading(boolean loading) {
        binding.btnLogin.setEnabled(!loading);
        binding.btnLogin.setText(loading ? R.string.login_loading : R.string.login_button);
    }

    /**
     * 显示或隐藏错误提示
     * @param message 错误文案，传 null 表示隐藏
     */
    private void showError(String message) {
        boolean hasError = message != null && !message.isEmpty();
        binding.tvError.setText(hasError ? message : null);
        binding.tvError.setVisibility(hasError ? View.VISIBLE : View.GONE);
    }

    /**
     * 跳转主页并结束登录页，防止返回键退回登录表单
     */
    private void openMainPage() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }
}
