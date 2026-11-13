# 明星学校 · Android 原生客户端

Java + Material 3 的安卓工程，当前包含**登录页**与登录成功后的占位主页。

## 目录结构

```
android/
├── settings.gradle               # 仓库与模块声明
├── build.gradle                  # AGP 8.2.0 插件版本
├── gradle.properties             # JDK 路径、AndroidX 开关
├── local.properties              # 本机 SDK 路径（不入库）
├── gradlew / gradlew.bat         # Gradle Wrapper 启动脚本
├── gradle/wrapper/               # Wrapper 配置与 jar
└── app/
    ├── build.gradle              # 包名、SDK 版本、API 地址、依赖
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/mingxing/school/
        │   ├── LoginActivity.java        # 登录页逻辑
        │   ├── MainActivity.java         # 登录后占位主页
        │   ├── data/SessionStore.java    # 会话本地存储
        │   └── net/AuthApi.java          # 登录接口封装
        └── res/
            ├── layout/                   # 登录页 / 主页布局
            ├── values/ + values-night/   # 浅色与深色色板、主题、文案
            ├── color/input_box_stroke.xml
            ├── drawable/                 # 自适应图标前景层
            ├── drawable-xhdpi/logo.png   # 校徽图（取自 public/assets/home/logo.png）
            ├── mipmap-*dpi/              # 启动器图标（多密度 PNG）
            ├── mipmap-anydpi-v26/        # 自适应图标（Android 8.0+）
            └── xml/network_security_config.xml
```

## 环境要求

| 项目 | 要求 |
|---|---|
| JDK | 17（已配置为 `D:/Java/jdk-17-oracle`） |
| Gradle | 由 Wrapper 自动下载 8.8 |
| compileSdk | 34 |
| Build-Tools | 34.0.0 |
| minSdk | 24（Android 7.0） |

> 当前 `local.properties` 指向的 SDK 目录里只有 `cmdline-tools`，**尚未安装 Platform 34 与 Build-Tools 34.0.0**，需要先补齐才能编译。

## 安装 SDK 与构建

1. 安装 Android SDK Platform 34 与 Build-Tools 34.0.0（Android Studio 的 SDK Manager，或命令行 `sdkmanager "platforms;android-34" "build-tools;34.0.0"`）。
2. 在 `android/` 目录执行：

```bat
gradlew.bat assembleDebug
```

3. 产物路径：`android/app/build/outputs/apk/debug/app-debug.apk`

## 接口地址

在 `app/build.gradle` 的 `defaultConfig` 中修改：

```groovy
buildConfigField "String", "API_BASE_URL", "\"http://192.168.0.138\""
```

- **真机**：当前指向局域网服务器 `192.168.0.138`（端口默认 80），需确保手机与电脑同一网络、电脑防火墙放行端口
- **模拟器**：改为 `"http://10.0.2.2"`（模拟器访问宿主机的固定地址）

## 与网页端的对应关系

| 网页端 | 原生端 |
|---|---|
| `public/login.html` + `page-login.js` | `LoginActivity` |
| `POST /api/auth/login` | `AuthApi.login()` |
| `localStorage` 中的登录信息 | `SessionStore`（SharedPreferences） |
| `all.css` 的 `--primary-color` 等变量 | `res/values/colors.xml`、`themes.xml` |
| 深色模式 `body.dark-mode` | `res/values-night/` |

## 说明

- 登录接口返回的 `avatar` 是相对路径（如 `/drive/assets/user/xx.png`），展示时需拼接 `API_BASE_URL`。
- 服务端对 UA 含 `MingXingDrive` 或 Header 含 `MingXingDrive-WebView` 的客户端会拦截管理员登录；原生 App 使用 Header `X-Client-Type: MingxingSchool-Android`，不受该限制。
- 当前允许明文 HTTP（方便局域网调试），上线前应在 `network_security_config.xml` 关闭 `cleartextTrafficPermitted` 并改用 HTTPS。
