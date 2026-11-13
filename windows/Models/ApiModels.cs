using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MingxingSchool.Desktop.Models;

/// <summary>
/// 兼容“数字或字符串”的文本转换器：积分等字段在服务端可能以超大整数字符串返回。
/// </summary>
public sealed class FlexibleStringConverter : JsonConverter<string>
{
    /// <summary>
    /// 读取字符串、数字或 null，统一转为字符串，避免反序列化失败。
    /// </summary>
    public override string Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString() ?? string.Empty,
            JsonTokenType.Number => ReadRawNumber(ref reader),
            JsonTokenType.Null => string.Empty,
            JsonTokenType.True => "true",
            JsonTokenType.False => "false",
            _ => string.Empty,
        };

    /// <summary>
    /// 读取数字 token 的原始文本，避免超大整数被 decimal/long 截断。
    /// </summary>
    private static string ReadRawNumber(ref Utf8JsonReader reader)
    {
        if (!reader.HasValueSequence)
        {
            return Encoding.UTF8.GetString(reader.ValueSpan);
        }
        var sb = new StringBuilder();
        foreach (var segment in reader.ValueSequence)
        {
            sb.Append(Encoding.UTF8.GetString(segment.Span));
        }
        return sb.ToString();
    }

    /// <summary>
    /// 写出为普通字符串。
    /// </summary>
    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}

/// <summary>
/// 登录接口返回结构。
/// </summary>
public sealed class LoginResultDto
{
    /// <summary>是否登录成功</summary>
    public bool Success { get; set; }
    /// <summary>服务端中文提示</summary>
    public string Message { get; set; } = string.Empty;
    /// <summary>登录姓名</summary>
    public string Username { get; set; } = string.Empty;
    /// <summary>是否管理员</summary>
    public bool IsAdmin { get; set; }
    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;
    /// <summary>头像地址（可为空）</summary>
    public string? Avatar { get; set; }
    /// <summary>Bearer 会话令牌</summary>
    public string Token { get; set; } = string.Empty;
}

/// <summary>
/// 当前登录用户信息（/api/me）。
/// </summary>
public sealed class MeDto
{
    /// <summary>是否已登录</summary>
    public bool LoggedIn { get; set; }
    /// <summary>用户 ID</summary>
    public string? UserId { get; set; }
    /// <summary>姓名</summary>
    public string? Name { get; set; }
    /// <summary>是否管理员</summary>
    public bool IsAdmin { get; set; }
    /// <summary>积分（可能为超大数字字符串）</summary>
    [JsonConverter(typeof(FlexibleStringConverter))]
    public string Points { get; set; } = "0";
    /// <summary>头像地址</summary>
    public string? Avatar { get; set; }
}

/// <summary>
/// 通用成功/失败响应。
/// </summary>
public sealed class SimpleResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>中文提示</summary>
    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// 用户列表（/api/users）。
/// </summary>
public sealed class UserListResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>用户数组</summary>
    public List<UserDto> Users { get; set; } = new();
}

/// <summary>
/// 用户条目（管理员列表）。
/// </summary>
public sealed class UserDto
{
    /// <summary>用户 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>姓名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>角色：admin / user</summary>
    public string Role { get; set; } = "user";
    /// <summary>积分（可能为超大数字字符串）</summary>
    [JsonConverter(typeof(FlexibleStringConverter))]
    public string Points { get; set; } = "0";
    /// <summary>'picture' 表示有图片头像，null 表示没有</summary>
    public string? Avatar { get; set; }
}

/// <summary>
/// 邮箱绑定信息。
/// </summary>
public sealed class MailBindingDto
{
    /// <summary>绑定邮箱，空字符串表示未绑定</summary>
    public string Email { get; set; } = string.Empty;
    /// <summary>绑定时间（ISO）</summary>
    public string BoundAt { get; set; } = string.Empty;
}

/// <summary>
/// 单用户邮箱绑定响应（/api/mail/me 或管理员绑定接口）。
/// </summary>
public sealed class MailBindingResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>中文提示</summary>
    public string Message { get; set; } = string.Empty;
    /// <summary>绑定结果</summary>
    public MailBindingDto? Binding { get; set; }
}

/// <summary>
/// 邮件服务器配置（授权码只返回是否已设置）。
/// </summary>
public sealed class MailConfigDto
{
    /// <summary>SMTP 主机</summary>
    public string Host { get; set; } = string.Empty;
    /// <summary>端口</summary>
    public int Port { get; set; } = 465;
    /// <summary>是否 SSL/TLS</summary>
    public bool Secure { get; set; } = true;
    /// <summary>登录邮箱账号</summary>
    public string User { get; set; } = string.Empty;
    /// <summary>发件人显示名</summary>
    public string FromName { get; set; } = string.Empty;
    /// <summary>发件人地址</summary>
    public string FromAddress { get; set; } = string.Empty;
    /// <summary>是否已保存授权码</summary>
    public bool HasPassword { get; set; }
    /// <summary>最后更新时间</summary>
    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>
/// 邮件配置响应。
/// </summary>
public sealed class MailConfigResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>中文提示</summary>
    public string Message { get; set; } = string.Empty;
    /// <summary>配置内容</summary>
    public MailConfigDto? Config { get; set; }
}

/// <summary>
/// 所有用户的邮箱绑定（管理员）。
/// </summary>
public sealed class MailBindingsResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>绑定列表</summary>
    public List<MailBindingItemDto> Bindings { get; set; } = new();
}

/// <summary>
/// 单条邮箱绑定。
/// </summary>
public sealed class MailBindingItemDto
{
    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;
    /// <summary>邮箱</summary>
    public string Email { get; set; } = string.Empty;
    /// <summary>绑定时间</summary>
    public string BoundAt { get; set; } = string.Empty;
}

/// <summary>
/// 可接收处罚邮件的学生列表。
/// </summary>
public sealed class MailStudentsResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>学生数组</summary>
    public List<MailStudentDto> Students { get; set; } = new();
}

/// <summary>
/// 已绑定邮箱的学生。
/// </summary>
public sealed class MailStudentDto
{
    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;
    /// <summary>姓名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>邮箱</summary>
    public string Email { get; set; } = string.Empty;
}

/// <summary>
/// 网盘根目录响应。
/// </summary>
public sealed class DriveRootResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>根目录绝对路径</summary>
    public string Root { get; set; } = string.Empty;
}

/// <summary>
/// 网盘文件条目。
/// </summary>
public sealed class DriveFileDto
{
    /// <summary>文件名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>绝对路径</summary>
    public string Path { get; set; } = string.Empty;
    /// <summary>字节大小</summary>
    public long Size { get; set; }
    /// <summary>创建时间</summary>
    public DateTime Created { get; set; }
    /// <summary>修改时间</summary>
    public DateTime Modified { get; set; }
}

/// <summary>
/// 网盘文件夹条目。
/// </summary>
public sealed class DriveFolderDto
{
    /// <summary>文件夹名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>绝对路径</summary>
    public string Path { get; set; } = string.Empty;
    /// <summary>创建时间</summary>
    public DateTime Created { get; set; }
    /// <summary>修改时间</summary>
    public DateTime Modified { get; set; }
}

/// <summary>
/// 网盘目录列表。
/// </summary>
public sealed class DriveListResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>文件数组</summary>
    public List<DriveFileDto> Files { get; set; } = new();
    /// <summary>文件夹数组</summary>
    public List<DriveFolderDto> Folders { get; set; } = new();
}

/// <summary>
/// 上传接口返回的文件信息。
/// </summary>
public sealed class DriveUploadedFileDto
{
    /// <summary>文件名</summary>
    public string OriginalName { get; set; } = string.Empty;
    /// <summary>目标绝对路径</summary>
    public string Path { get; set; } = string.Empty;
}

/// <summary>
/// 上传响应。
/// </summary>
public sealed class DriveUploadResponse
{
    /// <summary>是否成功</summary>
    public bool Success { get; set; }
    /// <summary>中文提示</summary>
    public string Message { get; set; } = string.Empty;
    /// <summary>文件信息</summary>
    public DriveUploadedFileDto? File { get; set; }
}

/// <summary>
/// 转盘条目（服务端字段含下划线，需显式映射）。
/// </summary>
public sealed class WheelDto
{
    /// <summary>转盘 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>归属用户 ID</summary>
    [JsonPropertyName("user_id")]
    public string UserId { get; set; } = string.Empty;
    /// <summary>创建者显示名</summary>
    [JsonPropertyName("creator_name")]
    public string CreatorName { get; set; } = string.Empty;
    /// <summary>转盘名称</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>选项文本数组</summary>
    public List<string> Options { get; set; } = new();
    /// <summary>自定义配色（可空）</summary>
    public List<string>? Colors { get; set; }
    /// <summary>背景图（可空）</summary>
    [JsonPropertyName("background_image")]
    public string? BackgroundImage { get; set; }
    /// <summary>背景色（可空）</summary>
    [JsonPropertyName("background_color")]
    public string? BackgroundColor { get; set; }
    /// <summary>是否私密</summary>
    [JsonPropertyName("is_private")]
    public bool IsPrivate { get; set; }
    /// <summary>创建时间</summary>
    [JsonPropertyName("created_at")]
    public string CreatedAt { get; set; } = string.Empty;
    /// <summary>更新时间</summary>
    [JsonPropertyName("updated_at")]
    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>
/// 广播频道状态。
/// </summary>
public sealed class ChannelStateDto
{
    /// <summary>频道英文 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>频道中文名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>图标地址</summary>
    public string Icon { get; set; } = string.Empty;
    /// <summary>主题色</summary>
    public string Color { get; set; } = "#1CB0F6";
    /// <summary>状态：idle / playing / paused</summary>
    public string Status { get; set; } = "idle";
    /// <summary>当前音频 ID</summary>
    public string? AudioId { get; set; }
    /// <summary>当前音频显示名</summary>
    public string? AudioName { get; set; }
    /// <summary>当前音频文件名</summary>
    public string? AudioFile { get; set; }
    /// <summary>音频总时长（秒）</summary>
    public double? DurationSec { get; set; }
    /// <summary>开始播放的时间戳（毫秒）</summary>
    public long? StartedAt { get; set; }
    /// <summary>在线听众数</summary>
    public int Listeners { get; set; }
}

/// <summary>
/// 广播接口统一响应。
/// </summary>
public sealed class BroadcastEnvelope<T>
{
    /// <summary>是否成功</summary>
    public bool Ok { get; set; }
    /// <summary>业务数据</summary>
    public T? Data { get; set; }
    /// <summary>错误详情</summary>
    public BroadcastErrorDto? Error { get; set; }
}

/// <summary>
/// 广播错误。
/// </summary>
public sealed class BroadcastErrorDto
{
    /// <summary>错误码</summary>
    public string Code { get; set; } = string.Empty;
    /// <summary>中文提示</summary>
    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// 音频列表负载。
/// </summary>
public sealed class AudioListPayload
{
    /// <summary>音频数组</summary>
    public List<AudioDto> List { get; set; } = new();
}

/// <summary>
/// 音频文件。
/// </summary>
public sealed class AudioDto
{
    /// <summary>音频 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>显示名（无扩展名）</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>原始文件名</summary>
    public string File { get; set; } = string.Empty;
    /// <summary>字节大小</summary>
    public long Size { get; set; }
    /// <summary>修改时间戳（毫秒）</summary>
    public double Mtime { get; set; }
}

/// <summary>
/// 商店接口统一响应。
/// </summary>
public sealed class ShopEnvelope<T>
{
    /// <summary>是否成功</summary>
    public bool Ok { get; set; }
    /// <summary>业务数据</summary>
    public T? Data { get; set; }
    /// <summary>错误详情</summary>
    public ShopErrorDto? Error { get; set; }
}

/// <summary>
/// 商店错误。
/// </summary>
public sealed class ShopErrorDto
{
    /// <summary>错误码</summary>
    public string Code { get; set; } = string.Empty;
    /// <summary>中文提示</summary>
    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// 商店信息。
/// </summary>
public sealed class ShopDto
{
    /// <summary>店铺 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>店铺名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>简介</summary>
    public string Description { get; set; } = string.Empty;
    /// <summary>分类</summary>
    public string Category { get; set; } = "综合";
    /// <summary>封面图</summary>
    public string Image { get; set; } = string.Empty;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; set; } = "🏬";
    /// <summary>是否营业中</summary>
    public bool IsOpen { get; set; }
    /// <summary>店主 ID</summary>
    public string? OwnerId { get; set; }
    /// <summary>是否被查封</summary>
    public bool Seized { get; set; }
    /// <summary>查封信息</summary>
    public SeizeInfoDto? SeizeInfo { get; set; }
}

/// <summary>
/// 店铺查封信息。
/// </summary>
public sealed class SeizeInfoDto
{
    /// <summary>年级</summary>
    public string Grade { get; set; } = string.Empty;
    /// <summary>班级</summary>
    public string ClassName { get; set; } = string.Empty;
    /// <summary>整改期限</summary>
    public string Deadline { get; set; } = string.Empty;
    /// <summary>违规问题</summary>
    public List<string> Issues { get; set; } = new();
    /// <summary>查封时间</summary>
    public string At { get; set; } = string.Empty;
}

/// <summary>
/// 商品规格组。
/// </summary>
public sealed class SpecGroupDto
{
    /// <summary>规格组名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>是否必选</summary>
    public bool Required { get; set; } = true;
    /// <summary>选项列表</summary>
    public List<SpecOptionDto> Options { get; set; } = new();
}

/// <summary>
/// 规格/套餐选项。
/// </summary>
public sealed class SpecOptionDto
{
    /// <summary>选项名</summary>
    public string Label { get; set; } = string.Empty;
    /// <summary>加价</summary>
    public decimal PriceDelta { get; set; }
}

/// <summary>
/// 套餐分组。
/// </summary>
public sealed class ComboGroupDto
{
    /// <summary>分组名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>需选件数</summary>
    public int Count { get; set; } = 1;
    /// <summary>选项</summary>
    public List<SpecOptionDto> Options { get; set; } = new();
}

/// <summary>
/// 商品。
/// </summary>
public sealed class ProductDto
{
    /// <summary>商品 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>所属店铺 ID</summary>
    public string ShopId { get; set; } = string.Empty;
    /// <summary>商品名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>描述</summary>
    public string Description { get; set; } = string.Empty;
    /// <summary>基础价</summary>
    public decimal Price { get; set; }
    /// <summary>图片</summary>
    public string Image { get; set; } = string.Empty;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; set; } = "🛒";
    /// <summary>分类</summary>
    public string Category { get; set; } = "其他";
    /// <summary>是否在售</summary>
    public bool IsAvailable { get; set; }
    /// <summary>是否套餐</summary>
    public bool IsCombo { get; set; }
    /// <summary>销量</summary>
    public int Sales { get; set; }
    /// <summary>规格组</summary>
    public List<SpecGroupDto>? Specs { get; set; }
    /// <summary>套餐分组</summary>
    public List<ComboGroupDto>? ComboGroups { get; set; }
}

/// <summary>
/// 购物车视图。
/// </summary>
public sealed class CartViewDto
{
    /// <summary>购物车条目</summary>
    public List<CartItemDto> Items { get; set; } = new();
    /// <summary>合计金额</summary>
    public decimal TotalAmount { get; set; }
    /// <summary>总件数</summary>
    public int Count { get; set; }
}

/// <summary>
/// 购物车行。
/// </summary>
public sealed class CartItemDto
{
    /// <summary>行唯一键</summary>
    public string LineKey { get; set; } = string.Empty;
    /// <summary>商品 ID</summary>
    public string ProductId { get; set; } = string.Empty;
    /// <summary>商品名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>原价</summary>
    public decimal BasePrice { get; set; }
    /// <summary>实际单价</summary>
    public decimal UnitPrice { get; set; }
    /// <summary>规格文本</summary>
    public string SpecText { get; set; } = string.Empty;
    /// <summary>套餐文本</summary>
    public string ComboText { get; set; } = string.Empty;
    /// <summary>是否套餐</summary>
    public bool IsCombo { get; set; }
    /// <summary>Emoji</summary>
    public string Emoji { get; set; } = "🛒";
    /// <summary>图片</summary>
    public string Image { get; set; } = string.Empty;
    /// <summary>数量</summary>
    public int Quantity { get; set; }
    /// <summary>店铺 ID</summary>
    public string ShopId { get; set; } = string.Empty;
    /// <summary>店铺名</summary>
    public string ShopName { get; set; } = string.Empty;
}

/// <summary>
/// 订单。
/// </summary>
public sealed class OrderDto
{
    /// <summary>订单 ID</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>买家 ID</summary>
    public string UserId { get; set; } = string.Empty;
    /// <summary>订单项</summary>
    public List<OrderItemDto> Items { get; set; } = new();
    /// <summary>总额</summary>
    public decimal TotalAmount { get; set; }
    /// <summary>状态英文枚举</summary>
    public string Status { get; set; } = "pending";
    /// <summary>状态中文</summary>
    public string StatusText { get; set; } = string.Empty;
    /// <summary>备注</summary>
    public string Note { get; set; } = string.Empty;
    /// <summary>创建时间</summary>
    public string CreatedAt { get; set; } = string.Empty;
    /// <summary>退款状态</summary>
    public string? RefundStatus { get; set; }
    /// <summary>退款金额</summary>
    public decimal? RefundAmount { get; set; }
    /// <summary>退款理由</summary>
    public string? RefundReason { get; set; }
    /// <summary>服务端附加提示（如待取件邮件）</summary>
    public string? MailNotice { get; set; }
}

/// <summary>
/// 订单项。
/// </summary>
public sealed class OrderItemDto
{
    /// <summary>商品 ID</summary>
    public string ProductId { get; set; } = string.Empty;
    /// <summary>商品名</summary>
    public string ProductName { get; set; } = string.Empty;
    /// <summary>成交单价</summary>
    public decimal Price { get; set; }
    /// <summary>数量</summary>
    public int Quantity { get; set; }
    /// <summary>Emoji</summary>
    public string Emoji { get; set; } = "🛒";
    /// <summary>图片</summary>
    public string Image { get; set; } = string.Empty;
    /// <summary>店铺 ID</summary>
    public string ShopId { get; set; } = string.Empty;
    /// <summary>店铺名</summary>
    public string ShopName { get; set; } = string.Empty;
    /// <summary>规格文本</summary>
    public string? SpecText { get; set; }
    /// <summary>套餐文本</summary>
    public string? ComboText { get; set; }
}

/// <summary>
/// 商店统计。
/// </summary>
public sealed class ShopStatsDto
{
    /// <summary>有效订单数</summary>
    public int TotalOrders { get; set; }
    /// <summary>总营业额</summary>
    public decimal TotalRevenue { get; set; }
    /// <summary>今日订单数</summary>
    public int TodayOrders { get; set; }
    /// <summary>热销商品 Top5</summary>
    public List<TopProductDto> TopProducts { get; set; } = new();
}

/// <summary>
/// 热销商品统计项。
/// </summary>
public sealed class TopProductDto
{
    /// <summary>商品名</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>销量</summary>
    public int Sales { get; set; }
}
