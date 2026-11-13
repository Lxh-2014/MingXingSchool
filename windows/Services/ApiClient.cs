using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// 接口调用异常：携带 HTTP 状态码与服务端中文提示。
/// </summary>
public sealed class ApiException : Exception
{
    /// <summary>HTTP 状态码（0 表示网络异常）</summary>
    public int StatusCode { get; }

    /// <summary>业务错误码（部分接口返回）</summary>
    public string? ErrorCode { get; }

    /// <summary>
    /// 构造异常对象。
    /// </summary>
    public ApiException(string message, int statusCode = 0, string? errorCode = null) : base(message)
    {
        StatusCode = statusCode;
        ErrorCode = errorCode;
    }
}

/// <summary>
/// 统一 HTTP 客户端：负责 Bearer 鉴权、Cookie 会话、JSON 解析与中文错误提取。
/// 说明：网盘/转盘/广播/商店的子接口只认 cookie，因此必须启用 CookieContainer。
/// </summary>
public sealed class ApiClient : IDisposable
{
    /// <summary>全局 JSON 选项：宽松解析、忽略大小写、允许数字字符串</summary>
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
        AllowTrailingCommas = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>共享 Cookie 容器：登录 cookie 会被自动带到子应用请求</summary>
    private readonly CookieContainer _cookies = new();

    /// <summary>主请求客户端（100 秒超时）</summary>
    private readonly HttpClient _http;

    /// <summary>长请求客户端（无超时，用于 SSE 与大文件）</summary>
    private readonly HttpClient _longHttp;

    /// <summary>当前服务端地址（不含结尾斜杠）</summary>
    private string _baseUrl;

    /// <summary>构造客户端并初始化两个 HttpClientHandler。
    /// 两个 Handler 共享同一个 CookieContainer，保证会话一致。</summary>
    public ApiClient(string baseUrl)
    {
        _baseUrl = Normalize(baseUrl);

        var handler = new HttpClientHandler
        {
            UseCookies = true,
            CookieContainer = _cookies,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            AllowAutoRedirect = true,
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(100) };

        var longHandler = new HttpClientHandler
        {
            UseCookies = true,
            CookieContainer = _cookies,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            AllowAutoRedirect = true,
        };
        _longHttp = new HttpClient(longHandler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    /// <summary>当前服务端地址（例如 http://localhost）</summary>
    public string BaseUrl => _baseUrl;

    /// <summary>Bearer 令牌（登录后由 AuthService 写入）</summary>
    public string? Token { get; private set; }

    /// <summary>
    /// 切换服务端地址：只影响后续请求，Cookie 仍按域名保存。
    /// </summary>
    public void SetBaseUrl(string baseUrl)
    {
        _baseUrl = Normalize(baseUrl);
        SyncTokenCookie();
    }

    /// <summary>
    /// 写入登录令牌，同时写入同值的会话 Cookie。
    /// 说明：转盘/广播等子应用接口只认 cookie（token=xxx），仅带 Bearer 会被判未登录。
    /// </summary>
    public void SetToken(string? token)
    {
        Token = token;
        SyncTokenCookie();
    }

    /// <summary>
    /// 把当前令牌同步为服务端域下的 token cookie，保证子应用接口鉴权通过。
    /// </summary>
    private void SyncTokenCookie()
    {
        try
        {
            var uri = new Uri(_baseUrl);
            if (string.IsNullOrWhiteSpace(Token))
            {
                _cookies.Add(uri, new Cookie("token", string.Empty) { Path = "/", Expires = DateTime.Now.AddDays(-1) });
                return;
            }
            _cookies.Add(uri, new Cookie("token", Token) { Path = "/" });
        }
        catch (CookieException)
        {
            // 同名 Cookie 冲突时忽略（后续请求仍会带 Bearer）
        }
        catch (UriFormatException)
        {
            // 地址异常时忽略
        }
    }

    /// <summary>
    /// 统一 URL 规范化：补 http:// 并去掉尾部斜杠。
    /// </summary>
    public static string Normalize(string? baseUrl)
    {
        var value = (baseUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            return "http://localhost";
        }
        if (!value.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !value.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            value = "http://" + value;
        }
        return value.TrimEnd('/');
    }

    /// <summary>
    /// 拼接绝对地址。
    /// </summary>
    public Uri BuildUri(string path)
        => new(_baseUrl + "/" + path.TrimStart('/'), UriKind.Absolute);

    /// <summary>
    /// 构造带鉴权头的请求。
    /// </summary>
    public HttpRequestMessage CreateRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, BuildUri(path));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("X-Client-Type", "MingxingSchool-Desktop");
        if (!string.IsNullOrWhiteSpace(Token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        }
        return request;
    }

    /// <summary>
    /// 发送 JSON 请求并反序列化响应。
    /// </summary>
    public async Task<T> SendAsync<T>(HttpMethod method, string path, object? body = null, CancellationToken ct = default)
    {
        using var request = CreateRequest(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw BuildException(text, (int)response.StatusCode);
        }
        return Deserialize<T>(text);
    }

    /// <summary>
    /// 发送请求但不关心响应体（例如登出）。
    /// </summary>
    public async Task SendNoContentAsync(HttpMethod method, string path, object? body = null, CancellationToken ct = default)
    {
        using var request = CreateRequest(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw BuildException(text, (int)response.StatusCode);
        }
    }

    /// <summary>
    /// 下载原始字节（用于头像、商品图等需要鉴权的静态资源）。
    /// </summary>
    public async Task<byte[]> GetBytesAsync(string path, CancellationToken ct = default)
    {
        using var request = CreateRequest(HttpMethod.Get, path);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException("资源加载失败", (int)response.StatusCode);
        }
        return await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// 流式下载文件到本地路径。
    /// </summary>
    /// <param name="path">服务端路径（含查询参数）</param>
    /// <param name="destination">本地保存路径</param>
    /// <param name="progress">进度回调（0~1）</param>
    /// <param name="ct">取消令牌</param>
    public async Task DownloadAsync(string path, string destination, Action<double>? progress, CancellationToken ct = default)
    {
        using var request = CreateRequest(HttpMethod.Get, path);
        using var response = await _longHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw BuildException(text, (int)response.StatusCode);
        }

        var total = response.Content.Headers.ContentLength ?? -1;
        await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
        var buffer = new byte[81920];                    // 复制缓冲区
        long copied = 0;                                 // 已复制字节数
        int read;
        while ((read = await source.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            copied += read;
            if (total > 0)
            {
                progress?.Invoke((double)copied / total);
            }
        }
    }

    /// <summary>
    /// 上传文件（multipart/form-data），返回响应 JSON。
    /// </summary>
    public async Task<T> UploadFileAsync<T>(string path, string filePath, string fieldName, IDictionary<string, string>? fields = null, CancellationToken ct = default)
    {
        using var request = CreateRequest(HttpMethod.Post, path);
        using var content = new MultipartFormDataContent();
        await using var stream = File.OpenRead(filePath);
        var fileContent = new StreamContent(stream);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        content.Add(fileContent, fieldName, Path.GetFileName(filePath));
        if (fields is not null)
        {
            foreach (var pair in fields)
            {
                content.Add(new StringContent(pair.Value, Encoding.UTF8), pair.Key);
            }
        }
        request.Content = content;

        using var response = await _longHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw BuildException(text, (int)response.StatusCode);
        }
        return Deserialize<T>(text);
    }

    /// <summary>
    /// 订阅 SSE 事件流；连接断开或取消时返回。
    /// </summary>
    /// <param name="path">SSE 接口路径</param>
    /// <param name="onEvent">事件名与数据回调</param>
    /// <param name="ct">取消令牌</param>
    public async Task SubscribeSseAsync(string path, Action<string, string> onEvent, CancellationToken ct)
    {
        using var request = CreateRequest(HttpMethod.Get, path);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var response = await _longHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw BuildException(text, (int)response.StatusCode);
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var eventName = "message";                        // 当前事件名
        var data = new StringBuilder();                   // 当前事件数据（可能多行）
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null)
            {
                break;
            }
            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line[6..].Trim();
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (data.Length > 0)
                {
                    data.Append('\n');
                }
                data.Append(line[5..].TrimStart());
            }
            else if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    onEvent(eventName, data.ToString());
                    data.Clear();
                    eventName = "message";
                }
            }
            // 其余为 ": ping" 心跳或 "retry:" 指令，忽略
        }
    }

    /// <summary>
    /// 从响应文本反序列化；空响应返回默认实例。
    /// </summary>
    public static T Deserialize<T>(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return Activator.CreateInstance<T>();
        }
        try
        {
            return JsonSerializer.Deserialize<T>(text, JsonOptions) ?? Activator.CreateInstance<T>();
        }
        catch (JsonException ex)
        {
            throw new ApiException("服务器返回了无法解析的数据：" + ex.Message);
        }
    }

    /// <summary>
    /// 从错误响应中提取中文提示。
    /// </summary>
    public static ApiException BuildException(string text, int statusCode)
    {
        var message = string.Empty;                       // 最终展示的中文提示
        string? code = null;                              // 业务错误码
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
            {
                message = msg.GetString() ?? string.Empty;
            }
            else if (root.TryGetProperty("error", out var err))
            {
                if (err.ValueKind == JsonValueKind.String)
                {
                    message = err.GetString() ?? string.Empty;
                }
                else if (err.ValueKind == JsonValueKind.Object)
                {
                    if (err.TryGetProperty("message", out var em) && em.ValueKind == JsonValueKind.String)
                    {
                        message = em.GetString() ?? string.Empty;
                    }
                    if (err.TryGetProperty("code", out var ec) && ec.ValueKind == JsonValueKind.String)
                    {
                        code = ec.GetString();
                    }
                }
            }
        }
        catch (JsonException)
        {
            // 非 JSON 错误响应：保留状态码提示
        }

        if (string.IsNullOrWhiteSpace(message))
        {
            message = statusCode switch
            {
                401 => "未登录或登录已过期，请重新登录",
                403 => "没有权限执行该操作",
                404 => "请求的资源不存在",
                _ => $"请求失败（HTTP {statusCode}）",
            };
        }
        return new ApiException(message, statusCode, code);
    }

    /// <summary>
    /// 释放两个 HttpClient。
    /// </summary>
    public void Dispose()
    {
        _http.Dispose();
        _longHttp.Dispose();
    }
}
