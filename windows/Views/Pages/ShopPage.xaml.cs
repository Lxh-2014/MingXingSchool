using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;
using MingxingSchool.Desktop.Views;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 星商店：按网页端样式还原（逛店 / 店铺详情 / 购物车 / 我的订单 / 我的店铺）。
/// 复用商店后端 /shop/api/* 接口，套餐商品支持按分组选择后加购。
/// </summary>
public partial class ShopPage : UserControl
{
    /// <summary>商店内部视图枚举，用于统一切换显隐</summary>
    private enum ShopViewKind
    {
        Home,        // 逛店
        Shop,        // 店铺详情
        Cart,        // 购物车
        Orders,      // 我的订单
        OrderDetail, // 订单详情
        MyShops      // 我的店铺
    }

    /// <summary>逛店页店铺卡片数据源</summary>
    private readonly ObservableCollection<ShopCardRow> _shopCards = new();
    /// <summary>店铺详情页商品卡片数据源</summary>
    private readonly ObservableCollection<GoodsRow> _goods = new();
    /// <summary>购物车按店铺分组数据源</summary>
    private readonly ObservableCollection<CartGroupRow> _cartGroups = new();
    /// <summary>我的订单卡片数据源</summary>
    private readonly ObservableCollection<OrderCardRow> _orderCards = new();
    /// <summary>我的店铺卡片数据源</summary>
    private readonly ObservableCollection<MyShopRow> _myShopRows = new();

    /// <summary>逛店页全部可见店铺（来自 /shops）</summary>
    private List<ShopDto> _allShops = new();
    /// <summary>全部可见商品（来自 /products，用于按店铺筛选）</summary>
    private List<ProductDto> _allProducts = new();
    /// <summary>当前登录用户的订单原始数据（用于点击卡片打开详情）</summary>
    private List<OrderDto> _myOrders = new();

    /// <summary>逛店页当前分类（空串表示「全部」）</summary>
    private string _homeCategory = string.Empty;
    /// <summary>逛店页当前搜索关键词</summary>
    private string _homeKeyword = string.Empty;
    /// <summary>店铺详情页当前商品分类（空串表示「全部」）</summary>
    private string _shopCategory = string.Empty;
    /// <summary>当前打开的店铺（店铺详情页）</summary>
    private ShopDto? _currentShop;
    /// <summary>购物车总件数（用于顶部角标）</summary>
    private int _cartCount;
    /// <summary>数据是否已首次加载</summary>
    private bool _initialized;
    /// <summary>正在批量重建分类胶囊时置真，避免触发重复刷新</summary>
    private bool _buildingChips;

    /// <summary>构造函数：绑定各视图数据源，首次显示时加载数据。</summary>
    public ShopPage()
    {
        InitializeComponent();
        ShopGrid.ItemsSource = _shopCards;
        GoodsGrid.ItemsSource = _goods;
        CartGroups.ItemsSource = _cartGroups;
        OrdersList.ItemsSource = _orderCards;
        MyShopList.ItemsSource = _myShopRows;

        Loaded += async (_, _) =>
        {
            if (_initialized)
            {
                return;
            }
            _initialized = true;
            await InitializeAsync();
        };
    }

    /// <summary>
    /// 首次加载：拉取店铺、商品与购物车角标，并渲染逛店页。
    /// </summary>
    private async Task InitializeAsync()
    {
        await Task.WhenAll(LoadCatalogAsync(), RefreshCartBadgeAsync());
    }

    /// <summary>
    /// 拉取店铺与商品全量数据（逛店页与店铺详情共用）。
    /// </summary>
    private async Task LoadCatalogAsync()
    {
        try
        {
            var shopRes = await AppServices.Api.SendAsync<ShopEnvelope<List<ShopDto>>>(HttpMethod.Get, "/shop/api/shops");
            var productRes = await AppServices.Api.SendAsync<ShopEnvelope<List<ProductDto>>>(HttpMethod.Get, "/shop/api/products");
            _allShops = shopRes.Data ?? new List<ShopDto>();
            _allProducts = productRes.Data ?? new List<ProductDto>();
            BuildHomeChips();
            PaintHome();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>
    /// 切换商店内部视图。
    /// </summary>
    /// <param name="kind">目标视图</param>
    private void ShowView(ShopViewKind kind)
    {
        HomeView.Visibility = kind == ShopViewKind.Home ? Visibility.Visible : Visibility.Collapsed;
        ShopView.Visibility = kind == ShopViewKind.Shop ? Visibility.Visible : Visibility.Collapsed;
        CartView.Visibility = kind == ShopViewKind.Cart ? Visibility.Visible : Visibility.Collapsed;
        OrdersView.Visibility = kind == ShopViewKind.Orders ? Visibility.Visible : Visibility.Collapsed;
        OrderDetailView.Visibility = kind == ShopViewKind.OrderDetail ? Visibility.Visible : Visibility.Collapsed;
        MyShopsView.Visibility = kind == ShopViewKind.MyShops ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// 顶部标签切换：按 Tag 决定进入哪个视图。
    /// </summary>
    private async void ShopTab_Checked(object sender, RoutedEventArgs e)
    {
        if (!_initialized || (sender as RadioButton)?.Tag is not string tag)
        {
            return;
        }
        switch (tag)
        {
            case "home":
                ShowView(ShopViewKind.Home);
                _homeKeyword = string.Empty;
                HomeSearch.Text = string.Empty;
                PaintHome();
                break;
            case "cart":
                ShowView(ShopViewKind.Cart);
                await LoadCartAsync();
                break;
            case "orders":
                ShowView(ShopViewKind.Orders);
                await LoadOrdersAsync();
                break;
            case "myshops":
                ShowView(ShopViewKind.MyShops);
                await LoadMyShopsAsync();
                break;
        }
    }

    /* ==================== 逛店 ==================== */

    /// <summary>
    /// 重建逛店页分类胶囊：全部 + 各店铺分类。
    /// </summary>
    private void BuildHomeChips()
    {
        _buildingChips = true;
        HomeChips.Children.Clear();
        _homeCategory = string.Empty;

        var cats = new List<string> { "全部" };                      // 胶囊文案集合
        foreach (var shop in _allShops)
        {
            var cat = string.IsNullOrWhiteSpace(shop.Category) ? "综合" : shop.Category;
            if (!cats.Contains(cat))
            {
                cats.Add(cat);
            }
        }

        foreach (var cat in cats)
        {
            var chip = new RadioButton
            {
                Style = (Style)FindResource("SpChip"),
                Content = cat,
                Tag = cat == "全部" ? string.Empty : cat,
                GroupName = "HomeChip",
                IsChecked = cat == "全部",
            };
            chip.Checked += HomeChip_Checked;
            HomeChips.Children.Add(chip);
        }
        _buildingChips = false;
    }

    /// <summary>点击分类胶囊：按分类重新渲染店铺卡片。</summary>
    private void HomeChip_Checked(object sender, RoutedEventArgs e)
    {
        if (_buildingChips || (sender as RadioButton)?.Tag is not string cat)
        {
            return;
        }
        _homeCategory = cat;
        PaintHome();
    }

    /// <summary>搜索框输入：实时按关键词过滤店铺。</summary>
    private void HomeSearch_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (!_initialized)
        {
            return;
        }
        _homeKeyword = HomeSearch.Text.Trim();
        PaintHome();
    }

    /// <summary>
    /// 按分类与关键词过滤后重绘逛店页店铺卡片。
    /// 关键词同时匹配店铺名、简介与店内商品名（与网页端一致）。
    /// </summary>
    private void PaintHome()
    {
        _shopCards.Clear();

        var keyword = _homeKeyword;                                   // 搜索关键词
        var filtered = _allShops.Where(s =>
        {
            var cat = string.IsNullOrWhiteSpace(s.Category) ? "综合" : s.Category;
            if (_homeCategory.Length > 0 && cat != _homeCategory)
            {
                return false;
            }
            if (keyword.Length == 0)
            {
                return true;
            }
            if (s.Name.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
                s.Description.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            return _allProducts.Any(p => p.ShopId == s.Id && p.Name.Contains(keyword, StringComparison.OrdinalIgnoreCase));
        }).ToList();

        foreach (var shop in filtered)
        {
            var count = _allProducts.Count(p => p.ShopId == shop.Id);  // 店内商品数
            var row = new ShopCardRow
            {
                Name = shop.Name,
                Description = string.IsNullOrWhiteSpace(shop.Description) ? "这家店还没有写简介～" : shop.Description,
                Category = string.IsNullOrWhiteSpace(shop.Category) ? "综合" : shop.Category,
                Emoji = string.IsNullOrWhiteSpace(shop.Emoji) ? "🏬" : shop.Emoji,
                StatusText = shop.Seized ? "已查封" : (!shop.IsOpen ? "休息中" : string.Empty),
                StatusVisible = shop.Seized || !shop.IsOpen ? Visibility.Visible : Visibility.Collapsed,
                ProductCountText = count + " 件商品",
                Source = shop,
            };
            _shopCards.Add(row);
            LoadCoverAsync(row, shop.Image);
        }

        HomeEmpty.Visibility = _shopCards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>点击店铺卡片：进入店铺详情页。</summary>
    private async void ShopCard_Click(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 1 || (sender as FrameworkElement)?.DataContext is not ShopCardRow row)
        {
            return;
        }
        await OpenShopAsync(row.Source.Id);
    }

    /// <summary>返回逛店页。</summary>
    private void BackToHome_Click(object sender, RoutedEventArgs e)
    {
        ShowView(ShopViewKind.Home);
        _homeKeyword = string.Empty;
        HomeSearch.Text = string.Empty;
        PaintHome();
        TabHome.IsChecked = true;
    }

    /* ==================== 店铺详情 ==================== */

    /// <summary>
    /// 打开指定店铺：渲染店铺头、分类胶囊与商品网格。
    /// </summary>
    /// <param name="shopId">店铺 ID</param>
    private async Task OpenShopAsync(string shopId)
    {
        var shop = _allShops.FirstOrDefault(s => s.Id == shopId);       // 本地缓存中的店铺
        if (shop is null)
        {
            try
            {
                var res = await AppServices.Api.SendAsync<ShopEnvelope<ShopDto>>(HttpMethod.Get, "/shop/api/shops/" + Uri.EscapeDataString(shopId));
                shop = res.Data;
            }
            catch (Exception ex)
            {
                ToastService.Show(ex.Message, ToastKind.Error);
                return;
            }
        }
        if (shop is null)
        {
            return;
        }

        _currentShop = shop;
        ShopHeadName.Text = shop.Name;
        ShopHeadDesc.Text = string.IsNullOrWhiteSpace(shop.Description) ? "这家店还没有写简介～" : shop.Description;
        ShopHeadTagText.Text = string.IsNullOrWhiteSpace(shop.Category) ? "综合" : shop.Category;
        ShopHeadEmoji.Text = string.IsNullOrWhiteSpace(shop.Emoji) ? "🏬" : shop.Emoji;
        ShopHeadCover.Source = null;
        LoadCoverToImageAsync(ShopHeadCover, shop.Image);

        BuildShopChips(shop.Id);
        PaintGoods(shop.Id);
        ShowView(ShopViewKind.Shop);
    }

    /// <summary>
    /// 重建店铺详情页的商品分类胶囊。
    /// </summary>
    /// <param name="shopId">店铺 ID</param>
    private void BuildShopChips(string shopId)
    {
        _buildingChips = true;
        ShopChips.Children.Clear();
        _shopCategory = string.Empty;

        var cats = new List<string> { "全部" };
        foreach (var product in _allProducts.Where(p => p.ShopId == shopId))
        {
            var cat = string.IsNullOrWhiteSpace(product.Category) ? "其他" : product.Category;
            if (!cats.Contains(cat))
            {
                cats.Add(cat);
            }
        }

        foreach (var cat in cats)
        {
            var chip = new RadioButton
            {
                Style = (Style)FindResource("SpChip"),
                Content = cat,
                Tag = cat == "全部" ? string.Empty : cat,
                GroupName = "ShopChip",
                IsChecked = cat == "全部",
            };
            chip.Checked += ShopChip_Checked;
            ShopChips.Children.Add(chip);
        }
        _buildingChips = false;
    }

    /// <summary>点击商品分类胶囊：重新渲染商品。</summary>
    private void ShopChip_Checked(object sender, RoutedEventArgs e)
    {
        if (_buildingChips || _currentShop is null || (sender as RadioButton)?.Tag is not string cat)
        {
            return;
        }
        _shopCategory = cat;
        PaintGoods(_currentShop.Id);
    }

    /// <summary>
    /// 渲染指定店铺的商品卡片（仅展示在售商品）。
    /// </summary>
    /// <param name="shopId">店铺 ID</param>
    private void PaintGoods(string shopId)
    {
        _goods.Clear();
        var list = _allProducts.Where(p => p.ShopId == shopId && p.IsAvailable);
        if (_shopCategory.Length > 0)
        {
            list = list.Where(p => (string.IsNullOrWhiteSpace(p.Category) ? "其他" : p.Category) == _shopCategory);
        }

        foreach (var product in list)
        {
            var row = new GoodsRow
            {
                Name = product.Name,
                Description = string.IsNullOrWhiteSpace(product.Description) ? " " : product.Description,
                Emoji = string.IsNullOrWhiteSpace(product.Emoji) ? "🛒" : product.Emoji,
                PriceText = FormatPoints(product.Price) + " 积分",
                SalesText = product.Sales > 0 ? "已售 " + product.Sales : string.Empty,
                BadgeText = product.IsCombo ? "套餐" : (product.Specs is { Count: > 0 } ? "选规格" : string.Empty),
                BadgeVisible = product.IsCombo || product.Specs is { Count: > 0 } ? Visibility.Visible : Visibility.Collapsed,
                Source = product,
            };
            _goods.Add(row);
            LoadCoverAsync(row, product.Image);
        }

        GoodsEmpty.Visibility = _goods.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /* ==================== 加入购物车（规格 / 套餐） ==================== */

    /// <summary>
    /// 加入购物车：普通商品按规格选择、套餐商品按分组选择，最后 POST /cart。
    /// </summary>
    private async void AddToCart_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not GoodsRow row)
        {
            return;
        }
        var product = row.Source;
        var specs = new List<string>();                                // 已选规格 label
        var combos = new List<Dictionary<string, object>>();            // 套餐选择明细

        // 普通商品的规格组：每个必选组弹出一次选择框
        if (!product.IsCombo && product.Specs is { Count: > 0 })
        {
            var fields = new List<FormField>();
            foreach (var group in product.Specs)
            {
                var options = group.Options.Select(o =>
                    o.PriceDelta > 0 ? o.Label + "（+" + FormatPoints(o.PriceDelta) + "）" : o.Label).ToList();  // 下拉文案
                if (options.Count == 0)
                {
                    continue;
                }
                fields.Add(new FormField
                {
                    Key = group.Name,
                    Label = group.Name + (group.Required ? "" : "（可选）"),
                    Value = options[0],
                    Choices = options,
                });
            }
            if (fields.Count > 0)
            {
                var result = DialogService.Form("选择规格", product.Name, fields, "加入购物车");
                if (result is null)
                {
                    return;
                }
                foreach (var pair in result)
                {
                    // 去掉加价后缀，只回传选项名
                    var label = pair.Value;
                    var index = label.IndexOf('（');
                    specs.Add(index > 0 ? label[..index] : label);
                }
            }
        }

        // 套餐商品：每个分组按需选件数，逐件弹出选择框
        if (product.IsCombo && product.ComboGroups is { Count: > 0 })
        {
            foreach (var group in product.ComboGroups)
            {
                var options = group.Options.Select(o =>
                    o.PriceDelta > 0 ? o.Label + "（+" + FormatPoints(o.PriceDelta) + "）" : o.Label).ToList();
                if (options.Count == 0)
                {
                    continue;
                }
                for (var i = 0; i < Math.Max(1, group.Count); i++)
                {
                    var title = group.Count > 1 ? $"选择{group.Name}（{i + 1}/{group.Count}）" : "选择" + group.Name;
                    var picked = DialogService.Prompt(title, product.Name, options[0], "请选择一项", false, false, "确定");
                    if (picked is null)
                    {
                        return;
                    }
                    var index = picked.IndexOf('（');
                    var label = index > 0 ? picked[..index] : picked;
                    combos.Add(new Dictionary<string, object>
                    {
                        ["groupName"] = group.Name,
                        ["label"] = label,
                        ["count"] = 1,
                    });
                }
            }
        }

        try
        {
            await AppServices.Api.SendNoContentAsync(HttpMethod.Post, "/shop/api/cart", new
            {
                productId = product.Id,
                specs,
                combo = combos,
                quantity = 1,
            });
            ToastService.Show("已加入购物车", ToastKind.Success);
            await RefreshCartBadgeAsync();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /* ==================== 购物车 ==================== */

    /// <summary>
    /// 载入购物车并按店铺分组渲染。
    /// </summary>
    private async Task LoadCartAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<ShopEnvelope<CartViewDto>>(HttpMethod.Get, "/shop/api/cart");
            ApplyCartView(res.Data);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>
    /// 把购物车视图数据渲染到界面。
    /// </summary>
    /// <param name="view">购物车视图（可能为 null）</param>
    private void ApplyCartView(CartViewDto? view)
    {
        _cartGroups.Clear();
        var items = view?.Items ?? new List<CartItemDto>();
        _cartCount = view?.Count ?? 0;

        foreach (var group in items.GroupBy(i => i.ShopId))
        {
            var groupRow = new CartGroupRow
            {
                ShopName = group.First().ShopName,
                Lines = new ObservableCollection<CartLineRow>(),
            };
            foreach (var item in group)
            {
                var line = new CartLineRow
                {
                    Name = item.Name,
                    Emoji = string.IsNullOrWhiteSpace(item.Emoji) ? "🛒" : item.Emoji,
                    SpecText = JoinSpecText(item),
                    SpecVisible = JoinSpecText(item).Length > 0 ? Visibility.Visible : Visibility.Collapsed,
                    PriceText = FormatPoints(item.UnitPrice) + " 积分",
                    Quantity = item.Quantity,
                    LineKey = item.LineKey,
                };
                groupRow.Lines.Add(line);
                LoadCoverAsync(line, item.Image);
            }
            _cartGroups.Add(groupRow);
        }

        var empty = _cartGroups.Count == 0;
        CartEmpty.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
        CartCheckout.Visibility = empty ? Visibility.Collapsed : Visibility.Visible;
        CartTotalText.Text = FormatPoints(view?.TotalAmount ?? 0) + " 积分";

        CartBadgeText.Text = _cartCount > 99 ? "99+" : _cartCount.ToString();
        CartBadge.Visibility = _cartCount > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// 拼接购物车行的规格 + 套餐说明文本。
    /// </summary>
    private static string JoinSpecText(CartItemDto item)
    {
        var parts = new List<string>();                                 // 非空文本片段
        if (!string.IsNullOrWhiteSpace(item.SpecText))
        {
            parts.Add(item.SpecText);
        }
        if (!string.IsNullOrWhiteSpace(item.ComboText))
        {
            parts.Add(item.ComboText);
        }
        return string.Join(" · ", parts);
    }

    /// <summary>
    /// 只刷新顶部购物车角标（加购 / 下单后调用）。
    /// </summary>
    private async Task RefreshCartBadgeAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<ShopEnvelope<CartViewDto>>(HttpMethod.Get, "/shop/api/cart");
            var count = res.Data?.Count ?? 0;                           // 购物车总件数
            _cartCount = count;
            CartBadgeText.Text = count > 99 ? "99+" : count.ToString();
            CartBadge.Visibility = count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch
        {
            // 角标刷新失败不打断主流程
        }
    }

    /// <summary>购物车减一件（减到 0 即删除该行）。</summary>
    private async void CartDec_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not CartLineRow line)
        {
            return;
        }
        await UpdateCartLineAsync(line.LineKey, line.Quantity - 1);
    }

    /// <summary>购物车加一件。</summary>
    private async void CartInc_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not CartLineRow line)
        {
            return;
        }
        await UpdateCartLineAsync(line.LineKey, line.Quantity + 1);
    }

    /// <summary>
    /// 修改购物车行数量（quantity ≤ 0 表示删除），并用返回的购物车视图重绘。
    /// </summary>
    private async Task UpdateCartLineAsync(string lineKey, int quantity)
    {
        try
        {
            var res = await AppServices.Api.SendAsync<ShopEnvelope<CartViewDto>>(
                HttpMethod.Put,
                "/shop/api/cart/line/" + Uri.EscapeDataString(lineKey),
                new { quantity });
            ApplyCartView(res.Data);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>提交订单：清空购物车并跳转我的订单。</summary>
    private async void SubmitOrder_Click(object sender, RoutedEventArgs e)
    {
        if (_cartCount == 0)
        {
            ToastService.Show("购物车是空的，先去挑点好物吧", ToastKind.Info);
            return;
        }
        if (!DialogService.Confirm("提交订单", "确认用当前积分下单吗？下单后积分立即扣除。", "提交订单"))
        {
            return;
        }
        try
        {
            await AppServices.Api.SendNoContentAsync(HttpMethod.Post, "/shop/api/orders", new
            {
                note = CartNote.Text.Trim(),
            });
            CartNote.Text = string.Empty;
            await RefreshCartBadgeAsync();
            ToastService.Show("下单成功，等待店家确认", ToastKind.Success);
            TabOrders.IsChecked = true;
            await LoadOrdersAsync();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /* ==================== 我的订单 ==================== */

    /// <summary>
    /// 载入我的订单并渲染卡片列表。
    /// </summary>
    private async Task LoadOrdersAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<ShopEnvelope<List<OrderDto>>>(HttpMethod.Get, "/shop/api/orders");
            _myOrders = res.Data ?? new List<OrderDto>();
            _orderCards.Clear();

            foreach (var order in _myOrders)
            {
                var first = order.Items.FirstOrDefault();                // 首个商品（用于缩略图与名称）
                var totalQty = order.Items.Sum(i => i.Quantity);          // 商品总件数
                var row = new OrderCardRow
                {
                    IdText = "订单号 " + order.Id,
                    StatusText = string.IsNullOrWhiteSpace(order.StatusText) ? StatusTextOf(order.Status) : order.StatusText,
                    StatusBrush = StatusColorOf(order.Status),
                    RefundText = order.RefundStatus == "pending" ? "退款审核中" :
                                 order.RefundStatus == "rejected" ? "退款被拒绝" : string.Empty,
                    RefundVisible = order.RefundStatus is "pending" or "rejected" ? Visibility.Visible : Visibility.Collapsed,
                    Emoji = first is null || string.IsNullOrWhiteSpace(first.Emoji) ? "🛒" : first.Emoji,
                    FirstName = first?.ProductName ?? "（商品已删除）",
                    MoreText = "等 " + order.Items.Count + " 件",
                    MoreVisible = order.Items.Count > 1 ? Visibility.Visible : Visibility.Collapsed,
                    TimeText = FormatTime(order.CreatedAt),
                    CountText = "共 " + totalQty + " 件",
                    TotalText = FormatPoints(order.TotalAmount) + " 积分",
                    Source = order,
                };
                _orderCards.Add(row);
                LoadCoverAsync(row, first?.Image ?? string.Empty);
            }

            OrdersEmpty.Visibility = _orderCards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>点击订单卡片：打开订单详情。</summary>
    private void OrderCard_Click(object sender, MouseButtonEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not OrderCardRow row)
        {
            return;
        }
        ShowOrderDetail(row.Source);
    }

    /// <summary>返回我的订单列表。</summary>
    private void BackToOrders_Click(object sender, RoutedEventArgs e)
    {
        ShowView(ShopViewKind.Orders);
    }

    /// <summary>
    /// 渲染订单详情（订单头 + 商品清单 + 备注/时间/合计 + 操作按钮），全部用代码构建。
    /// </summary>
    /// <param name="order">订单数据</param>
    private void ShowOrderDetail(OrderDto order)
    {
        OrderDetailHost.Children.Clear();

        // ---- 订单头卡片：订单号 + 状态 ----
        var head = CreateCard();
        var headRow = new DockPanel { LastChildFill = false };
        var idBlock = new TextBlock
        {
            Text = "订单号 " + order.Id,
            FontSize = 13,
            Foreground = Brush("TextSecondaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        DockPanel.SetDock(idBlock, Dock.Left);
        var statusBadge = new Border
        {
            Background = new SolidColorBrush(Color.FromRgb(0xFF, 0xF4, 0xE5)),
            CornerRadius = new CornerRadius(9),
            Padding = new Thickness(8, 2, 8, 2),
            Child = new TextBlock
            {
                Text = string.IsNullOrWhiteSpace(order.StatusText) ? StatusTextOf(order.Status) : order.StatusText,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = StatusColorOf(order.Status),
            },
        };
        DockPanel.SetDock(statusBadge, Dock.Right);   // 状态徽标右对齐，避免被 LastChildFill 拉伸
        statusBadge.VerticalAlignment = VerticalAlignment.Center;
        headRow.Children.Add(idBlock);
        headRow.Children.Add(statusBadge);
        head.Child = headRow;
        OrderDetailHost.Children.Add(head);

        // ---- 商品清单 ----
        var itemsCard = CreateCard();
        var itemsPanel = new StackPanel();
        foreach (var item in order.Items)
        {
            var linePanel = new DockPanel { Margin = new Thickness(0, 6, 0, 6), LastChildFill = true };
            var emoji = new TextBlock
            {
                Text = string.IsNullOrWhiteSpace(item.Emoji) ? "🛒" : item.Emoji,
                FontFamily = new FontFamily("Segoe UI Emoji"),   // 彩色 emoji 字体（WPF 为单色，统一用主色着色）
                Foreground = Brush("PrimaryBrush"),
                FontSize = 22,
                Width = 40,
                VerticalAlignment = VerticalAlignment.Center,
            };
            DockPanel.SetDock(emoji, Dock.Left);
            var price = new TextBlock
            {
                Text = FormatPoints(item.Price * item.Quantity) + " 积分",
                FontSize = 13,
                Foreground = new SolidColorBrush(Color.FromRgb(0xE8, 0x59, 0x0C)),
                VerticalAlignment = VerticalAlignment.Center,
            };
            DockPanel.SetDock(price, Dock.Right);
            var info = new StackPanel { Margin = new Thickness(10, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center };
            info.Children.Add(new TextBlock
            {
                Text = item.ProductName,
                FontSize = 14,
                Foreground = Brush("TextPrimaryBrush"),
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            var specText = string.Join(" · ", new[] { item.SpecText, item.ComboText }.Where(t => !string.IsNullOrWhiteSpace(t)));
            if (specText.Length > 0)
            {
                info.Children.Add(new TextBlock
                {
                    Text = specText,
                    FontSize = 12,
                    Margin = new Thickness(0, 3, 0, 0),
                    Foreground = Brush("TextSecondaryBrush"),
                });
            }
            info.Children.Add(new TextBlock
            {
                Text = "× " + item.Quantity + "　" + item.ShopName,
                FontSize = 12,
                Margin = new Thickness(0, 3, 0, 0),
                Foreground = Brush("TextSecondaryBrush"),
            });
            linePanel.Children.Add(emoji);
            linePanel.Children.Add(price);
            linePanel.Children.Add(info);
            itemsPanel.Children.Add(linePanel);
        }
        itemsCard.Child = itemsPanel;
        OrderDetailHost.Children.Add(itemsCard);

        // ---- 备注 / 时间 / 合计 ----
        var metaCard = CreateCard();
        var metaPanel = new StackPanel();
        metaPanel.Children.Add(MetaLine("下单时间", FormatTime(order.CreatedAt)));
        if (!string.IsNullOrWhiteSpace(order.Note))
        {
            metaPanel.Children.Add(MetaLine("备注", order.Note));
        }
        if (!string.IsNullOrWhiteSpace(order.RefundStatus))
        {
            var refundText = order.RefundStatus switch
            {
                "pending" => "退款审核中，申请金额 " + FormatPoints(order.RefundAmount ?? order.TotalAmount) + " 积分",
                "approved" => "已退款，已返还 " + FormatPoints(order.RefundAmount ?? order.TotalAmount) + " 积分",
                "rejected" => "退款申请被拒绝",
                _ => string.Empty,
            };
            if (refundText.Length > 0)
            {
                metaPanel.Children.Add(MetaLine("退款", refundText));
            }
        }
        var totalLine = new DockPanel { Margin = new Thickness(0, 10, 0, 0), LastChildFill = true };
        var totalLabel = new TextBlock
        {
            Text = "合计",
            FontSize = 14,
            Foreground = Brush("TextPrimaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        DockPanel.SetDock(totalLabel, Dock.Left);
        totalLine.Children.Add(totalLabel);
        totalLine.Children.Add(new TextBlock
        {
            Text = FormatPoints(order.TotalAmount) + " 积分",
            FontSize = 18,
            FontWeight = FontWeights.Bold,
            Foreground = new SolidColorBrush(Color.FromRgb(0xE8, 0x59, 0x0C)),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
        });
        metaPanel.Children.Add(totalLine);
        metaCard.Child = metaPanel;
        OrderDetailHost.Children.Add(metaCard);

        // ---- 操作按钮：取消 / 申请退款 ----
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 0) };
        if (order.Status == "pending")
        {
            var cancelBtn = new Button
            {
                Content = "取消订单",
                Style = (Style)FindResource("GrayButton"),
                Margin = new Thickness(0, 0, 10, 0),
            };
            cancelBtn.Click += async (_, _) => await CancelOrderAsync(order);
            actions.Children.Add(cancelBtn);
        }
        var canRefund = order.Status is not ("cancelled" or "refunded") &&
                        order.RefundStatus is not ("pending" or "approved");
        if (canRefund)
        {
            var refundBtn = new Button
            {
                Content = order.RefundStatus == "rejected" ? "再次申请退款" : "申请退款",
                Style = (Style)FindResource("DangerButton"),
            };
            refundBtn.Click += async (_, _) => await ApplyRefundAsync(order);
            actions.Children.Add(refundBtn);
        }
        if (actions.Children.Count > 0)
        {
            OrderDetailHost.Children.Add(actions);
        }

        ShowView(ShopViewKind.OrderDetail);
    }

    /// <summary>取消待确认订单。</summary>
    private async Task CancelOrderAsync(OrderDto order)
    {
        if (!DialogService.Confirm("取消订单", "确定取消该订单吗？积分会原路退回。", "取消订单"))
        {
            return;
        }
        try
        {
            await AppServices.Api.SendNoContentAsync(HttpMethod.Post, "/shop/api/orders/" + Uri.EscapeDataString(order.Id) + "/cancel");
            ToastService.Show("订单已取消", ToastKind.Success);
            await LoadOrdersAsync();
            ShowView(ShopViewKind.Orders);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>提交退款申请（需管理员审核）。</summary>
    private async Task ApplyRefundAsync(OrderDto order)
    {
        var reason = DialogService.Prompt("申请退款", "请填写退款理由，管理员审核通过后才会返还积分。", "", "例如：买错了 / 商品有问题");
        if (string.IsNullOrWhiteSpace(reason))
        {
            return;
        }
        try
        {
            await AppServices.Api.SendNoContentAsync(
                HttpMethod.Post,
                "/shop/api/orders/" + Uri.EscapeDataString(order.Id) + "/refund",
                new { reason });
            ToastService.Show("退款申请已提交，等待管理员审核", ToastKind.Success);
            await LoadOrdersAsync();
            ShowView(ShopViewKind.Orders);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /* ==================== 我的店铺 ==================== */

    /// <summary>
    /// 载入当前用户名下的店铺（含休息中 / 查封的店）。
    /// </summary>
    private async Task LoadMyShopsAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<ShopEnvelope<List<ShopDto>>>(HttpMethod.Get, "/shop/api/shops?mine=1");
            var shops = res.Data ?? new List<ShopDto>();
            _myShopRows.Clear();

            foreach (var shop in shops)
            {
                var count = _allProducts.Count(p => p.ShopId == shop.Id); // 店内商品数
                var row = new MyShopRow
                {
                    Name = shop.Name,
                    Sub = (string.IsNullOrWhiteSpace(shop.Description) ? "还没有写简介" : shop.Description) + " · " + count + " 件商品",
                    Emoji = string.IsNullOrWhiteSpace(shop.Emoji) ? "🏬" : shop.Emoji,
                    StatusText = shop.Seized ? "已查封" : (shop.IsOpen ? "营业中" : "休息中"),
                    StatusBrush = shop.Seized
                        ? new SolidColorBrush(Color.FromRgb(0xC4, 0x00, 0x00))
                        : shop.IsOpen
                            ? new SolidColorBrush(Color.FromRgb(0x1F, 0x7A, 0x4D))
                            : new SolidColorBrush(Color.FromRgb(0x99, 0x6A, 0x00)),
                    StatusBackgroundBrush = shop.Seized
                        ? new SolidColorBrush(Color.FromRgb(0xFF, 0xEE, 0xEE))
                        : shop.IsOpen
                            ? new SolidColorBrush(Color.FromRgb(0xE8, 0xF7, 0xEE))
                            : new SolidColorBrush(Color.FromRgb(0xFF, 0xF6, 0xE0)),
                    Source = shop,
                };
                _myShopRows.Add(row);
                LoadCoverAsync(row, shop.Image);
            }

            MyShopsEmpty.Visibility = _myShopRows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>点击「管理商品」：打开该店铺的商品列表。</summary>
    private async void ManageShop_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not MyShopRow row)
        {
            return;
        }
        await OpenShopAsync(row.Source.Id);
    }

    /// <summary>点击营业状态标签：切换营业 / 休息（已查封的店不可切换）。</summary>
    private async void ToggleShopStatus_Click(object sender, MouseButtonEventArgs e)
    {
        e.Handled = true;
        if ((sender as FrameworkElement)?.DataContext is not MyShopRow row || row.Source.Seized)
        {
            return;
        }
        try
        {
            await AppServices.Api.SendNoContentAsync(
                HttpMethod.Put,
                "/shop/api/shops/" + Uri.EscapeDataString(row.Source.Id),
                new
                {
                    name = row.Source.Name,
                    description = row.Source.Description,
                    category = row.Source.Category,
                    image = row.Source.Image,
                    emoji = row.Source.Emoji,
                    isOpen = !row.Source.IsOpen,
                });
            ToastService.Show(row.Source.IsOpen ? "已切换为休息中" : "已开始营业", ToastKind.Success);
            await LoadCatalogAsync();
            await LoadMyShopsAsync();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /* ==================== 通用辅助 ==================== */

    /// <summary>
    /// 异步加载封面图并写入行对象（路径以 / 开头时带令牌下载字节）。
    /// </summary>
    private static async void LoadCoverAsync(ShopRowBase row, string path)
    {
        var image = await LoadImageAsync(path);
        if (image is not null)
        {
            row.Cover = image;
        }
    }

    /// <summary>异步把封面图写入指定 Image 控件。</summary>
    private static async void LoadCoverToImageAsync(Image target, string path)
    {
        var image = await LoadImageAsync(path);
        if (image is not null)
        {
            target.Source = image;
        }
    }

    /// <summary>
    /// 加载图片：服务端相对路径走带鉴权的字节下载，其它按普通 URI 加载。
    /// </summary>
    private static async Task<ImageSource?> LoadImageAsync(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }
        try
        {
            var bmp = new BitmapImage();
            bmp.BeginInit();
            if (path.StartsWith('/'))
            {
                var bytes = await AppServices.Api.GetBytesAsync(path);
                bmp.StreamSource = new MemoryStream(bytes);
            }
            else
            {
                bmp.UriSource = new Uri(path, UriKind.RelativeOrAbsolute);
            }
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.EndInit();
            bmp.Freeze();
            return bmp;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>创建统一样式的详情卡片容器。</summary>
    private Border CreateCard()
    {
        return new Border
        {
            Background = Brush("CardBrush"),
            BorderBrush = Brush("BorderBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(18, 16, 18, 16),
            Margin = new Thickness(0, 0, 0, 14),
        };
    }

    /// <summary>创建「标签：值」一行文字。</summary>
    private TextBlock MetaLine(string label, string value)
    {
        return new TextBlock
        {
            Text = label + "：" + value,
            FontSize = 13,
            Margin = new Thickness(0, 0, 0, 6),
            Foreground = Brush("TextSecondaryBrush"),
            TextWrapping = TextWrapping.Wrap,
        };
    }

    /// <summary>按主题键取画刷（找不到时回退黑色）。</summary>
    private Brush Brush(string key)
    {
        var found = TryFindResource(key);
        return found as Brush ?? Brushes.Black;
    }

    /// <summary>订单状态英文枚举转中文。</summary>
    private static string StatusTextOf(string status) => status switch
    {
        "pending" => "待确认",
        "confirmed" => "已确认",
        "delivering" => "待取货",
        "completed" => "已完成",
        "cancelled" => "已取消",
        "refunded" => "已退款",
        _ => status,
    };

    /// <summary>订单状态对应的徽标文字颜色。</summary>
    private static Brush StatusColorOf(string status) => status switch
    {
        "pending" => new SolidColorBrush(Color.FromRgb(0xB2, 0x6A, 0x00)),
        "confirmed" => new SolidColorBrush(Color.FromRgb(0x1A, 0x73, 0xE8)),
        "delivering" => new SolidColorBrush(Color.FromRgb(0x7A, 0x4D, 0xD1)),
        "completed" => new SolidColorBrush(Color.FromRgb(0x1F, 0x7A, 0x4D)),
        "cancelled" => new SolidColorBrush(Color.FromRgb(0xC4, 0x00, 0x00)),
        "refunded" => new SolidColorBrush(Color.FromRgb(0xC4, 0x00, 0x00)),
        _ => new SolidColorBrush(Color.FromRgb(0x66, 0x66, 0x66)),
    };

    /// <summary>积分数量格式化：去掉多余的小数零（与网页端 fmtPoints 一致）。</summary>
    private static string FormatPoints(decimal value)
    {
        var text = value.ToString("0.####");
        return text;
    }

    /// <summary>把 ISO 时间转成「yyyy-MM-dd HH:mm」。</summary>
    private static string FormatTime(string iso)
    {
        if (string.IsNullOrWhiteSpace(iso))
        {
            return string.Empty;
        }
        return DateTime.TryParse(iso, out var dt) ? dt.ToString("yyyy-MM-dd HH:mm") : iso.Replace('T', ' ')[..Math.Min(16, iso.Length)];
    }
}

/// <summary>
/// 商店卡片行基类：只含异步回填的封面图属性。
/// </summary>
public abstract class ShopRowBase : INotifyPropertyChanged
{
    /// <summary>属性变更事件（供 WPF 绑定刷新封面）</summary>
    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>触发属性变更通知</summary>
    protected void Raise(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    /// <summary>封面图（为空时显示 Emoji）</summary>
    private ImageSource? _cover;
    public ImageSource? Cover
    {
        get => _cover;
        set
        {
            _cover = value;
            Raise(nameof(Cover));
        }
    }
}

/// <summary>逛店页店铺卡片。</summary>
public sealed class ShopCardRow : ShopRowBase
{
    /// <summary>店铺名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>简介</summary>
    public string Description { get; init; } = string.Empty;
    /// <summary>分类</summary>
    public string Category { get; init; } = string.Empty;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; init; } = "🏬";
    /// <summary>状态文字（休息中 / 已查封，空串表示不显示）</summary>
    public string StatusText { get; init; } = string.Empty;
    /// <summary>状态标签是否显示</summary>
    public Visibility StatusVisible { get; init; } = Visibility.Collapsed;
    /// <summary>商品件数文字</summary>
    public string ProductCountText { get; init; } = string.Empty;
    /// <summary>原始店铺数据</summary>
    public ShopDto Source { get; init; } = new();
}

/// <summary>店铺详情页商品卡片。</summary>
public sealed class GoodsRow : ShopRowBase
{
    /// <summary>商品名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>描述</summary>
    public string Description { get; init; } = string.Empty;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; init; } = "🛒";
    /// <summary>价格文字</summary>
    public string PriceText { get; init; } = string.Empty;
    /// <summary>销量文字</summary>
    public string SalesText { get; init; } = string.Empty;
    /// <summary>规格/套餐提示文字</summary>
    public string BadgeText { get; init; } = string.Empty;
    /// <summary>提示标签是否显示</summary>
    public Visibility BadgeVisible { get; init; } = Visibility.Collapsed;
    /// <summary>原始商品数据</summary>
    public ProductDto Source { get; init; } = new();
}

/// <summary>购物车店铺分组。</summary>
public sealed class CartGroupRow
{
    /// <summary>店铺名</summary>
    public string ShopName { get; init; } = string.Empty;
    /// <summary>该店铺下的购物车行</summary>
    public ObservableCollection<CartLineRow> Lines { get; init; } = new();
}

/// <summary>购物车行。</summary>
public sealed class CartLineRow : ShopRowBase
{
    /// <summary>商品名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; init; } = "🛒";
    /// <summary>规格 + 套餐说明</summary>
    public string SpecText { get; init; } = string.Empty;
    /// <summary>规格文本是否显示</summary>
    public Visibility SpecVisible { get; init; } = Visibility.Collapsed;
    /// <summary>单价文字</summary>
    public string PriceText { get; init; } = string.Empty;
    /// <summary>数量</summary>
    public int Quantity { get; init; }
    /// <summary>购物车行唯一键（改量 / 删除用）</summary>
    public string LineKey { get; init; } = string.Empty;
}

/// <summary>订单卡片。</summary>
public sealed class OrderCardRow : ShopRowBase
{
    /// <summary>订单号文字</summary>
    public string IdText { get; init; } = string.Empty;
    /// <summary>状态文字</summary>
    public string StatusText { get; init; } = string.Empty;
    /// <summary>状态文字颜色</summary>
    public Brush StatusBrush { get; init; } = Brushes.Gray;
    /// <summary>退款状态文字</summary>
    public string RefundText { get; init; } = string.Empty;
    /// <summary>退款标签是否显示</summary>
    public Visibility RefundVisible { get; init; } = Visibility.Collapsed;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; init; } = "🛒";
    /// <summary>首个商品名</summary>
    public string FirstName { get; init; } = string.Empty;
    /// <summary>「等 N 件」文字</summary>
    public string MoreText { get; init; } = string.Empty;
    /// <summary>「等 N 件」是否显示</summary>
    public Visibility MoreVisible { get; init; } = Visibility.Collapsed;
    /// <summary>下单时间</summary>
    public string TimeText { get; init; } = string.Empty;
    /// <summary>件数文字</summary>
    public string CountText { get; init; } = string.Empty;
    /// <summary>合计文字</summary>
    public string TotalText { get; init; } = string.Empty;
    /// <summary>原始订单数据</summary>
    public OrderDto Source { get; init; } = new();
}

/// <summary>我的店铺卡片。</summary>
public sealed class MyShopRow : ShopRowBase
{
    /// <summary>店铺名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>副标题（简介 + 商品数）</summary>
    public string Sub { get; init; } = string.Empty;
    /// <summary>Emoji 图标</summary>
    public string Emoji { get; init; } = "🏬";
    /// <summary>营业状态文字</summary>
    public string StatusText { get; init; } = string.Empty;
    /// <summary>营业状态文字颜色</summary>
    public Brush StatusBrush { get; init; } = Brushes.Gray;
    /// <summary>营业状态底色</summary>
    public Brush StatusBackgroundBrush { get; init; } = Brushes.Transparent;
    /// <summary>原始店铺数据</summary>
    public ShopDto Source { get; init; } = new();
}
