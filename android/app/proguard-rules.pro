# 代码混淆规则（当前 release 未开启 minifyEnabled，此文件预留给后续启用）
# 保留 BuildConfig，避免反射访问 API_BASE_URL 时被裁剪
-keep class com.mingxing.school.BuildConfig { *; }
