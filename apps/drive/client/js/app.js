/** 应用挂载前缀：明星学校主应用把网盘挂在 /drive */
const APP_BASE = '/drive';

const App = {
    username: null,
    userId: null,
    currentPage: 'login',
    locales: null,

    async init() {
        // 加载语言文件
        await this.loadLocales();

        window.addEventListener('popstate', (e) => this.handlePopState(e));

        this.username = localStorage.getItem('username');
        this.userId = localStorage.getItem('userId');

        const route = this.parseUrl();

        // 网盘自带设置页已收口到主项目 /settings（头像、外观统一在主项目维护）
        if (route.page === 'settings') {
            window.location.href = '/settings';
            return;
        }

        if (route.page === 'login') {
            if (this.username) {
                this.currentPage = 'files';
                history.replaceState({}, '', APP_BASE + '/files');
            } else {
                // 未登录：跳统一登录页，登录后回到网盘文件页
                window.location.href = '/login?next=' + encodeURIComponent('/drive/files');
                return;
            }
        } else if (route.page === 'files') {
            if (!this.username) {
                // 未登录：跳统一登录页，登录后回到当前想访问的页面
                window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
                return;
            } else {
                this.currentPage = route.page;
            }
        }

        // 初始化 currentFolderPath
        if (route.folderPath) {
            this.currentFolderPath = route.folderPath;
            localStorage.setItem('currentFolderPath', route.folderPath);
        } else if (localStorage.getItem('currentFolderPath')) {
            // 如果 URL 中没有路径，但 localStorage 中有，使用 localStorage 中的值
            this.currentFolderPath = localStorage.getItem('currentFolderPath');
        } else {
            // 默认使用根目录，稍后从服务器获取
            this.currentFolderPath = null;
        }

        // 初始化深色模式
        const isDarkMode = localStorage.getItem('darkMode') === 'true';
        if (isDarkMode) {
            document.body.classList.add('dark-mode');
        }

        // 获取文件根目录
        await this.loadFilesRoot();

        this.render();
    },

    /**
     * 从服务器获取文件根目录
     */
    async loadFilesRoot() {
        try {
            const response = await fetch(APP_BASE + '/api/files/root');
            const data = await response.json();
            if (data.success) {
                this.filesRoot = data.root;
                // 如果 currentFolderPath 为 null，设置默认路径
                if (!this.currentFolderPath) {
                    this.currentFolderPath = this.filesRoot;
                }
            }
        } catch (error) {
            console.error(this.locales.app.errors.loadFilesRootFailed, error);
            // 使用默认值
            this.filesRoot = '';
            if (!this.currentFolderPath) {
                this.currentFolderPath = '';
            }
        }
    },

    /**
     * 加载语言文件
     * 优先跟随全站统一语言设置（I18n.lang），旧 localStorage.lang 作为兜底
     */
    async loadLocales() {
        // 全站共享语言（来自主站设置页），保证网盘与主站使用同一种语言
        const sharedLang = window.I18n && window.I18n.lang;
        // 兼容旧版本地语言键，默认简体中文
        const savedLang = sharedLang
            ? (sharedLang === 'en-US' ? 'en_us' : 'zh_cn')
            : (localStorage.getItem('lang') || 'zh_cn');
        const langFile = savedLang === 'en_us' ? 'en_us.json' : 'zh_cn.json';

        try {
            const response = await fetch(APP_BASE + `/assets/lang/${langFile}`);
            this.locales = await response.json();
        } catch (error) {
            console.error('加载语言文件失败:', error);
            // 使用默认文本（中文），内置 fallback
            this.locales = this.getDefaultLocales();
        }

        await this.applySiteTitle();
    },

    /**
     * 标签页标题统一为站点名，并跟随全站语言
     */
    async applySiteTitle() {
        if (window.I18n && window.I18n.ready) {
            try { await window.I18n.ready(); } catch (e) { /* 语言包异常时忽略 */ }
            document.title = window.I18n.t('app.name', null, '明星学校');
            return;
        }
        document.title = '明星学校';                        // 共享 i18n 不可用时回退中文站点名
    },

    /**
     * 获取默认语言包（仅在语言文件加载失败时使用）
     * @returns {object} 默认中文语言对象
     */
    getDefaultLocales() {
        return {
            app: { 
                name: '明星云网盘', 
                title: '明星云网盘', 
                version: '1.0.2-beta-2', 
                storagePath: './files',
                errors: { loadFilesRootFailed: '获取文件根目录失败' }
            },
            login: {
                title: '明星云网盘',
                subtitle: '登录以继续使用',
                submitBtn: '登 录',
                errorMsg: '登录失败，请检查姓名和学号'
            },
            files: { loading: '', empty: '没有文件', networkError: '网络错误' }
        };
    },

    navigate(page, folderPath = null) {
        this.currentPage = page;
        this.currentFolderPath = folderPath;

        /** 浏览器地址栏 URL（带挂载前缀） */
        let url = APP_BASE + '/';
        if (page === 'files') {
            if (folderPath) {
                const filesRoot = this.filesRoot;
                let relativePath = folderPath.replace(filesRoot, '').replace(/\\/g, '/');
                if (!relativePath.startsWith('/')) {
                    relativePath = '/' + relativePath;
                }
                url = APP_BASE + '/files' + relativePath;
                localStorage.setItem('currentFolderPath', folderPath);
                this.addToHistory(folderPath);
            } else {
                url = APP_BASE + '/files';
                localStorage.removeItem('currentFolderPath');
                this.addToHistory(null);
            }
        } else if (page === 'login') {
            // 登录页已统一到主应用 /login
            window.location.href = '/login';
            return;
        }

        history.pushState({ page, folderPath }, '', url);
        this.render();
    },

    handlePopState(e) {
        if (e.state) {
            this.currentPage = e.state.page;
            if (e.state.folderPath) {
                this.currentFolderPath = e.state.folderPath;
            }
            this.render();
        }
    },

    parseUrl() {
        let path = window.location.pathname;
        // 去掉挂载前缀，得到网盘应用内路径
        if (path.startsWith(APP_BASE)) path = path.slice(APP_BASE.length) || '/';

        if (path === '/login') {
            return { page: 'login' };
        } else if (path === '/settings') {
            return { page: 'settings' };
        } else if (path.startsWith('/files')) {
            if (path === '/files') {
                return { page: 'files', folderPath: null };
            } else {
                const relativePath = decodeURIComponent(path.slice(7));
                const filesRoot = this.filesRoot;
                const folderPath = filesRoot + relativePath.replace(/\//g, '\\');
                return { page: 'files', folderPath };
            }
        }

        return { page: 'login' };
    },

    render() {
        const app = document.getElementById('app');
        app.innerHTML = '';

        switch (this.currentPage) {
            case 'files':
                this.renderFilesPage(app);
                break;
        }
    },


    async renderFilesPage(container) {
        const mainContainer = document.createElement('div');
        mainContainer.className = 'main-container';

        const sidebar = this.createSidebar('files');
        const mainContent = document.createElement('main');
        mainContent.className = 'main-content';

        const topbar = this.createTopbar();
        const contentArea = document.createElement('div');
        contentArea.className = 'content-area';

        const toolbar = this.createToolbar();
        const fileGrid = document.createElement('div');
        fileGrid.className = 'file-grid';
        fileGrid.id = 'fileGrid';

        contentArea.appendChild(toolbar);
        contentArea.appendChild(fileGrid);
        mainContent.appendChild(topbar);
        mainContent.appendChild(contentArea);
        mainContainer.appendChild(sidebar);
        mainContainer.appendChild(mainContent);
        container.appendChild(mainContainer);

        this.fileGridEl = fileGrid;
        this.fileGridEl.innerHTML = '<div class="loading"></div>';

        await this.loadFiles(this.currentFolderPath);
    },

    /**
     * 创建侧边栏（72px，模仿多邻国风格，遵循 docs/侧边栏和顶栏.html）
     * 设置入口已收口到主项目 /settings，这里只保留"文件"导航项，Logo 点击回门户
     * @param {string} page 当前页面标识，用于高亮对应导航项
     * @returns {HTMLElement} 侧边栏元素
     */
    createSidebar(page) {
        const sidebar = document.createElement('div');
        sidebar.className = 'sidebar';

        // 顶部 Logo：仅展示，不可点击跳转
        const header = document.createElement('div');   // Logo 容器（居中）
        header.className = 'sidebar-header';
        const logo = document.createElement('span');    // Logo（仅展示，不可点击跳转）
        logo.title = '明星云网盘';
        logo.className = 'sidebar-logo';
        logo.style.overflow = 'hidden';
        const logoImg = document.createElement('img');  // 网盘专属图标
        logoImg.src = APP_BASE + '/assets/icon.png';
        logoImg.alt = '明星学校';
        logoImg.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        logo.appendChild(logoImg);
        header.appendChild(logo);
        sidebar.appendChild(header);

        // 导航区：文件（唯一导航项，设置已上收主项目）
        const nav = document.createElement('div');      // 导航项容器（纵向排列）
        nav.className = 'sidebar-nav';
        const filesItem = document.createElement('div'); // "文件"导航项
        filesItem.className = 'nav-item' + (page === 'files' ? ' active' : '');
        filesItem.title = (this.locales.sidebar && this.locales.sidebar.files) || '文件';
        filesItem.innerHTML = this.getIcon('folder');
        filesItem.addEventListener('click', () => this.navigate('files'));
        nav.appendChild(filesItem);
        sidebar.appendChild(nav);

        return sidebar;
    },

    /**
     * 创建顶部栏（60px，右侧用户头像 + 用户名，顶栏不显示标题文字）
     * 头像读取统一登录写入的 localStorage（avatarImage/avatarColor），修改头像请前往主项目 /settings
     * @returns {HTMLElement} 顶部栏元素
     */
    createTopbar() {
        const topbar = document.createElement('div');
        topbar.className = 'topbar';

        // 右侧：用户头像（名字悬浮 title 查看），顶栏不显示标题文字
        const userInfo = document.createElement('div'); // 用户信息容器
        userInfo.className = 'user-info';

        const avatar = document.createElement('div');   // 用户头像（已上传显示图片，否则平台默认头像）
        avatar.className = 'user-avatar';
        avatar.title = this.username || '';             // 悬浮头像显示名字（title 组件）
        const avatarImage = localStorage.getItem('avatarImage'); // 自定义头像图片地址（统一登录写入）
        const img = document.createElement('img');      // 头像图片元素
        img.src = avatarImage || '/assets/home/default-avatar.png';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
        avatar.appendChild(img);

        const name = document.createElement('span');    // 用户名：桌面端隐藏，小屏显示在头像旁
        name.className = 'user-name';
        name.textContent = this.username || '';

        userInfo.appendChild(avatar);
        userInfo.appendChild(name);
        topbar.appendChild(userInfo);

        return topbar;
    },

    createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'toolbar';

        const addressBar = this.createAddressBar();
        toolbar.appendChild(addressBar);

        const actionButtons = document.createElement('div');
        actionButtons.className = 'toolbar-actions';

        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'toolbar-btn';
        uploadBtn.innerHTML = this.getIcon('upload') + `<span>${this.locales.toolbar.upload}</span>`;
        uploadBtn.addEventListener('click', () => document.getElementById('fileInput').click());

        const newFolderBtn = document.createElement('button');
        newFolderBtn.className = 'toolbar-btn';
        newFolderBtn.innerHTML = this.getIcon('folder-plus') + `<span>${this.locales.toolbar.newFolder}</span>`;
        newFolderBtn.addEventListener('click', () => this.showNewFolderModal());

        actionButtons.appendChild(uploadBtn);
        actionButtons.appendChild(newFolderBtn);
        toolbar.appendChild(actionButtons);

        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'file';
        hiddenInput.className = 'hidden-input';
        hiddenInput.id = 'fileInput';
        hiddenInput.addEventListener('change', (e) => this.handleFileUpload(e));
        toolbar.appendChild(hiddenInput);

        return toolbar;
    },

    createAddressBar() {
        const addressBar = document.createElement('div');
        addressBar.className = 'address-bar';

        const navButtons = document.createElement('div');
        navButtons.className = 'nav-buttons';

        const backBtn = document.createElement('button');
        backBtn.className = 'nav-btn';
        backBtn.innerHTML = this.getIcon('arrow-left');
        backBtn.title = this.locales.toolbar.back;
        backBtn.disabled = !this.canGoBack();
        backBtn.addEventListener('click', () => this.goBack());

        const forwardBtn = document.createElement('button');
        forwardBtn.className = 'nav-btn';
        forwardBtn.innerHTML = this.getIcon('arrow-right');
        forwardBtn.title = this.locales.toolbar.forward;
        forwardBtn.disabled = !this.canGoForward();
        forwardBtn.addEventListener('click', () => this.goForward());

        const upBtn = document.createElement('button');
        upBtn.className = 'nav-btn';
        upBtn.innerHTML = this.getIcon('arrow-up');
        upBtn.title = this.locales.toolbar.up;
        upBtn.disabled = !this.canGoUp();
        upBtn.addEventListener('click', () => this.goUp());

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'nav-btn';
        refreshBtn.innerHTML = this.getIcon('refresh');
        refreshBtn.title = this.locales.toolbar.refresh;
        refreshBtn.addEventListener('click', () => this.loadFiles(this.currentFolderPath));

        navButtons.appendChild(backBtn);
        navButtons.appendChild(forwardBtn);
        navButtons.appendChild(upBtn);
        navButtons.appendChild(refreshBtn);

        const breadcrumbs = document.createElement('div');
        breadcrumbs.className = 'breadcrumbs';
        breadcrumbs.innerHTML = this.renderBreadcrumbs();

        const searchBox = document.createElement('div');
        searchBox.className = 'search-box';
        searchBox.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.35-4.35"></path>
            </svg>
            <input type="text" id="searchInput" placeholder="${this.locales.toolbar.search}" class="search-input">
        `;

        const searchInput = searchBox.querySelector('.search-input');
        searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));

        addressBar.appendChild(navButtons);
        addressBar.appendChild(breadcrumbs);
        addressBar.appendChild(searchBox);

        return addressBar;
    },

    getIcon(name) {
        const icons = {
            'folder': '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M6.72 4.15c.45 0 .67 0 .81.11.05.04.1.08.14.13.11.16.11.39.11.84v.92c0 .75 0 1.13-.2.14-.06.08-.13.16-.21.22-.26.19-.64.2-1.39-.01H4c-.75 0-1.13-.01-1.39-.2-.08-.06-.15-.13-.21-.22-.2-.38-.19-.74-.19-1.49V5.23c0-.45 0-.68.11-.84.04-.05.09-.09.14-.13.14-.11.36-.11.81-.11h3.44zm-2.32.8c-.33 0-.6.27-.6.6s.27.6.6.6h1.2c.33 0 .6-.27.6-.6s-.27-.6-.6-.6h-1.2zm3.52-2.1c.33 0 .6.27.6.6s-.27.6-.6.6H2.4c-.33 0-.6-.27-.6-.6s.27-.6.6-.6h5.52z"></path></svg>',
            'upload': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
            'folder-plus': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>',
            'download': '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M7.3 6.95c.39 0 .7 0 .7.39s-.31.7-.7.7H2.7c-.39 0-.7-.31-.7-.7s.31-.39.7-.39h4.6zm-2.1-5.3c.33 0 .6.27.6.6v.12c0 .32 0 .48.08.59.01.02.02.03.04.05.1.09.28.11.64.14.19.02.31.04.39.12.11.1.18.25.19.41.01.24-.23.52-.71 1.08l-.57.65c-.38.44-.57.66-.81.68-.03.01-.07.01-.11.01s-.08 0-.11-.01c-.24-.02-.43-.24-.81-.68l-.57-.65c-.48-.56-.72-.84-.71-1.08.01-.16.08-.31.19-.41.08-.08.2-.1.39-.12.36-.03.54-.05.64-.14.02-.02.03-.03.04-.05.08-.11.08-.27.08-.59V2.25c0-.33.27-.6.6-.6h.4z"></path></svg>',
            'edit': '<svg viewBox="0 0 1024 1024" fill="currentColor"><path d="M841.5 230.2c-20.1 0-36.4 16.3-36.4 36.4s16.3 36.4 36.4 36.4c33.4 0 60.6 27.2 60.6 60.6v270.9c0 33.4-27.2 60.6-60.6 60.6-20.1 0-36.4 16.3-36.4 36.4s16.3 36.4 36.4 36.4c73.6 0 133.4-59.8 133.4-133.4V363.6c0-73.6-59.8-133.4-133.4-133.4zM594.9 731.5c0-20.1-16.3-36.4-36.4-36.4H182.5c-33.4 0-60.6-27.2-60.6-60.6V363.6c0-33.4 27.2-60.6 60.6-60.6h378c20.1 0 36.4-16.3 36.4-36.4s-16.3-36.4-36.4-36.4H182.5c-73.6 0-133.4 59.9-133.4 133.4v270.9c0 73.5 59.8 133.4 133.4 133.4h376c20.1 0 36.4-16.3 36.4-36.4zM851.6 936.5H742.7V91.5h133.1c20.1 0 36.4-16.3 36.4-36.4s-16.3-36.4-36.4-36.4H560.5c-20.1 0-36.4 16.3-36.4 36.4s16.3 36.4 36.4 36.4h109.4v845H536.3c-20.1 0-36.4 16.3-36.4 36.4s16.3 36.4 36.4 36.4h315.3c20.1 0 36.4-16.3 36.4-36.4s-16.3-36.4-36.4-36.4z"></path></svg>',
            'info': '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5.14 4.06c.32.07.56.35.56.69v1.88c0 .12.07.22.16.3.15.13.24.32.24.54 0 .39-.31.7-.7.7H4.6c-.39 0-.7-.31-.7-.7 0-.22.09-.41.24-.54.08-.08.16-.18.16-.3v-1.06c0-.12-.07-.22-.16-.3-.15-.13-.24-.32-.24-.54 0-.39.31-.7.7-.7h.5c.05 0 .09.01.14.02zM4.9 1.85c.44 0 .8.36.8.8s-.36.8-.8.8-.8-.36-.8-.8.36-.8.8-.8z"></path></svg>',
            'trash': '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5.5 2.05c.26 0 .48.17.57.4.04.1.13.2.24.2h.9c.33 0 .6.27.6.6s-.27.6-.6.6c-.1.03-.19.11-.19.22l-.11 2.1c-.04.81-.06 1.21-.3 1.48-.03.04-.07.08-.12.11-.28.23-.68.23-1.5.23h-.6c-.8 0-1.2-.01-1.48-.23-.04-.03-.08-.07-.12-.11-.24-.27-.26-.67-.3-1.48l-.11-2.1c0-.11-.09-.19-.19-.22-.23-.08-.4-.31-.4-.57s.17-.5.4-.5h.9c.11 0 .2.09.24.2.09-.23.31-.4.57-.4zm-1.39 2.1c-.25.01-.44.22-.44.47l.04 1.9c.01.25.2.45.45.44.25-.01.44-.22.44-.47l-.04-1.9c0-.25-.2-.45-.45-.44zm1.77 0c-.25-.01-.46.17-.46.43l.04 1.89c0 .25.2.45.45.46.25.01.44-.17.44-.42l-.04-1.9c0-.25-.19-.45-.43-.46z"></path></svg>',
            'arrow-left': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"></path><polyline points="12 19 5 12 12 5"></polyline></svg>',
            'arrow-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"></path><polyline points="12 5 19 12 12 19"></polyline></svg>',
            'arrow-up': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"></path><polyline points="5 12 12 5 19 12"></polyline></svg>',
            'refresh': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>'
        };
        return icons[name] || '';
    },

    renderBreadcrumbs() {
        const filesRoot = this.filesRoot;
        let path = this.currentFolderPath || filesRoot;
        let relativePath = path.replace(filesRoot, '').replace(/\\/g, '/');
        
        if (!relativePath || relativePath === '/') {
            return `<span class="breadcrumb-item active">${this.locales.toolbar.rootDir}</span>`;
        }
        
        if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
        }
        
        const parts = relativePath.split('/').filter(p => p);
        let currentPath = filesRoot;
        let html = `<span class="breadcrumb-item" data-path="">${this.locales.toolbar.rootDir}</span>`;
        
        parts.forEach((part, index) => {
            currentPath += '\\' + part;
            const isLast = index === parts.length - 1;
            html += `<span class="breadcrumb-separator">/</span>`;
            html += `<span class="breadcrumb-item ${isLast ? 'active' : ''}" data-path="${currentPath}">${part}</span>`;
        });
        
        return html;
    },

    handleSearch(keyword) {
        const fileItems = document.querySelectorAll('.file-item');
        fileItems.forEach(item => {
            const name = item.dataset.name.toLowerCase();
            if (keyword.trim() === '' || name.includes(keyword.toLowerCase())) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    },

    historyStack: [],
    historyIndex: -1,

    addToHistory(path) {
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
        }
        this.historyStack.push(path);
        this.historyIndex = this.historyStack.length - 1;
    },

    canGoBack() {
        return this.historyIndex > 0;
    },

    canGoForward() {
        return this.historyIndex < this.historyStack.length - 1;
    },

    canGoUp() {
        const filesRoot = this.filesRoot;
        return this.currentFolderPath && this.currentFolderPath !== filesRoot;
    },

    goBack() {
        if (this.canGoBack()) {
            this.historyIndex--;
            const path = this.historyStack[this.historyIndex];
            this.navigate('files', path);
        }
    },

    goForward() {
        if (this.canGoForward()) {
            this.historyIndex++;
            const path = this.historyStack[this.historyIndex];
            this.navigate('files', path);
        }
    },

    goUp() {
        if (this.canGoUp()) {
            const parentPath = this.currentFolderPath.substring(0, this.currentFolderPath.lastIndexOf('\\'));
            this.navigate('files', parentPath);
        }
    },

    setupBreadcrumbEvents() {
        const breadcrumbItems = document.querySelectorAll('.breadcrumb-item');
        breadcrumbItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const path = e.target.dataset.path;
                if (path !== undefined) {
                    this.navigate('files', path === '' ? null : path);
                }
            });
        });
    },

    async loadFiles(folderPath = null) {
        this.currentFolderPath = folderPath;

        if (!this.fileGridEl) return;

        this.fileGridEl.innerHTML = '<div class="loading"></div>';

        try {
            let url = APP_BASE + '/api/files/list';
            if (folderPath) {
                const filesRoot = this.filesRoot;
                let relativePath = folderPath.replace(filesRoot, '').replace(/\\/g, '/');
                if (!relativePath.startsWith('/')) {
                    relativePath = '/' + relativePath;
                }
                url = APP_BASE + `/api/files/list?folder=${encodeURIComponent(relativePath)}`;
            }

            const response = await fetch(url);
            const data = await response.json();

            if (data.success) {
                this.renderFileList(data.folders, data.files);
                this.setupContextMenu();
                this.setupBreadcrumbEvents();
            } else {
                this.fileGridEl.innerHTML = `<div class="empty-state"><p>${this.locales.toolbar.noFiles}</p></div>`;
            }
        } catch (error) {
            this.fileGridEl.innerHTML = `<div class="empty-state"><p>${this.locales.toolbar.networkError}</p></div>`;
        }
    },

    renderFileList(folders, files) {
        const fileGrid = this.fileGridEl;
        fileGrid.innerHTML = '';

        if (folders.length === 0 && files.length === 0) {
            fileGrid.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <p>${this.locales.toolbar.noFiles}</p>
                </div>
            `;
            return;
        }

        folders.forEach(folder => {
            const item = this.createFileItem(folder.name, folder.path, true);
            fileGrid.appendChild(item);
        });

        files.forEach(file => {
            const item = this.createFileItem(file.name, file.path, false, file.size);
            fileGrid.appendChild(item);
        });
    },

    createFileItem(name, path, isDirectory, size) {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.dataset.name = name;
        item.dataset.path = path;
        item.dataset.isDirectory = isDirectory;

        const icon = isDirectory ? this.getFolderIcon() : this.getFileIcon(name);

        item.innerHTML = `
            <div class="file-icon">${icon}</div>
            <div class="file-name" title="${name}">${name}</div>
        `;

        item.addEventListener('dblclick', () => {
            if (isDirectory) {
                this.navigate('files', path);
            }
        });

        return item;
    },

    getFolderIcon() {
        return '<svg viewBox="0 0 24 24" fill="#F5A623" stroke="#E89B00" stroke-width="1"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    },

    getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const colors = {
            'jpg': '#E74C3C', 'jpeg': '#E74C3C', 'png': '#E74C3C', 'gif': '#E74C3C', 'bmp': '#E74C3C',
            'pdf': '#E74C3C',
            'doc': '#3498DB', 'docx': '#3498DB',
            'xls': '#27AE60', 'xlsx': '#27AE60',
            'ppt': '#E67E22', 'pptx': '#E67E22',
            'zip': '#9B59B6', 'rar': '#9B59B6', '7z': '#9B59B6',
            'txt': '#95A5A6'
        };
        const color = colors[ext] || '#95A5A6';

        return `<svg viewBox="0 0 24 24" fill="${color}" stroke="${color}" stroke-width="1"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
    },

    /**
     * 设置右键菜单，支持鼠标右键和触摸屏长按
     */
    setupContextMenu() {
        let touchTimer = null;          // 长按定时器
        let touchStartX = 0;            // 触摸起始 X 坐标
        let touchStartY = 0;            // 触摸起始 Y 坐标
        let isLongPress = false;        // 本次触摸是否触发了长按
        let touchInProgress = false;    // 是否正在进行触摸操作（用于屏蔽系统 contextmenu）
        const LONG_PRESS_DELAY = 500;   // 长按时长阈值（毫秒）
        const MOVE_TOLERANCE = 10;      // 允许的手指移动距离阈值（像素）

        // 点击空白处关闭菜单
        document.onclick = () => {
            // 长按触发菜单后，touchend 会连带触发一次 click，需忽略该次点击
            if (isLongPress) {
                isLongPress = false;
                return;
            }
            const menu = document.getElementById('contextMenu');
            if (menu) menu.classList.remove('show');
        };

        // 全局右键菜单处理：非文件页面阻止默认右键
        document.oncontextmenu = (e) => {
            if (this.currentPage !== 'files') {
                e.preventDefault();
                return false;
            }

            const contentArea = document.querySelector('.content-area');
            if (!contentArea || !contentArea.contains(e.target)) {
                e.preventDefault();
                return false;
            }
        };

        const contentArea = document.querySelector('.content-area');
        if (contentArea) {
            // 鼠标右键菜单
            contentArea.oncontextmenu = (e) => {
                if (this.currentPage !== 'files') {
                    e.preventDefault();
                    return;
                }

                // 触摸操作期间系统可能自动触发 contextmenu，交给长按逻辑处理，避免重复
                if (touchInProgress) {
                    e.preventDefault();
                    return;
                }

                e.preventDefault();
                this._handleContextMenu(e.clientX, e.clientY, e.target);
            };

            // 触摸开始：记录位置并启动长按定时器
            contentArea.addEventListener('touchstart', (e) => {
                if (this.currentPage !== 'files') return;
                // 仅处理单指触摸
                if (e.touches.length !== 1) return;
                const touch = e.touches[0];
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                isLongPress = false;
                touchInProgress = true;

                if (touchTimer) clearTimeout(touchTimer);

                touchTimer = setTimeout(() => {
                    isLongPress = true;
                    this._handleContextMenu(touchStartX, touchStartY, e.target);
                }, LONG_PRESS_DELAY);
            }, { passive: true });

            // 触摸移动：超出容差则取消长按（视为滑动）
            contentArea.addEventListener('touchmove', (e) => {
                if (!touchTimer) return;
                const touch = e.touches[0];
                const dx = touch.clientX - touchStartX;
                const dy = touch.clientY - touchStartY;
                if (Math.hypot(dx, dy) > MOVE_TOLERANCE) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
            }, { passive: true });

            // 触摸结束/取消：清除定时器并重置触摸状态
            const endTouch = () => {
                if (touchTimer) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
                // 延迟重置 touchInProgress，使随后可能触发的系统 contextmenu 能被识别并拦截
                setTimeout(() => { touchInProgress = false; }, 300);
            };
            contentArea.addEventListener('touchend', endTouch);
            contentArea.addEventListener('touchcancel', endTouch);
        }
    },

    /**
     * 统一处理右键菜单显示（鼠标右键与触摸长按共用）
     * @param {number} x - 菜单显示的 X 坐标
     * @param {number} y - 菜单显示的 Y 坐标
     * @param {Element} target - 触发事件的目标元素
     */
    _handleContextMenu(x, y, target) {
        const fileItem = target.closest('.file-item');
        if (fileItem) {
            this.selectedItem = {
                name: fileItem.dataset.name,
                path: fileItem.dataset.path,
                isDirectory: fileItem.dataset.isDirectory === 'true'
            };
            this.showContextMenu(x, y);
        } else {
            this.selectedItem = null;
            this.showEmptyContextMenu(x, y);
        }
    },

    showContextMenu(x, y) {
        let menu = document.getElementById('contextMenu');

        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'contextMenu';
            menu.className = 'context-menu';
            document.body.appendChild(menu);
        }

        menu.innerHTML = `
            <div class="context-menu-item" data-action="download">
                ${this.getIcon('download')}
                <span>${this.locales.contextMenu.download}</span>
            </div>
            <div class="context-menu-item" data-action="rename">
                ${this.getIcon('edit')}
                <span>${this.locales.contextMenu.rename}</span>
            </div>
            <div class="context-menu-item" data-action="info">
                ${this.getIcon('info')}
                <span>${this.locales.contextMenu.info}</span>
            </div>
            <div class="context-menu-item danger" data-action="delete">
                ${this.getIcon('trash')}
                <span>${this.locales.contextMenu.delete}</span>
            </div>
        `;

        menu.querySelector('[data-action="download"]').style.display = this.selectedItem.isDirectory ? 'none' : 'flex';

        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                this.handleContextAction(item.dataset.action);
            };
        });

        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.classList.add('show');
    },

    showEmptyContextMenu(x, y) {
        let menu = document.getElementById('contextMenu');

        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'contextMenu';
            menu.className = 'context-menu';
            document.body.appendChild(menu);
        }

        menu.innerHTML = `
            <div class="context-menu-item" data-action="upload">
                ${this.getIcon('upload')}
                <span>${this.locales.contextMenu.uploadFile}</span>
            </div>
            <div class="context-menu-item" data-action="newfolder">
                ${this.getIcon('folder-plus')}
                <span>${this.locales.contextMenu.newFolder}</span>
            </div>
            <div class="context-menu-item" data-action="folderinfo">
                ${this.getIcon('info')}
                <span>${this.locales.contextMenu.info}</span>
            </div>
        `;

        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                this.handleEmptyContextAction(item.dataset.action);
            };
        });

        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.classList.add('show');
    },

    async handleContextAction(action) {
        document.getElementById('contextMenu').classList.remove('show');

        if (!this.selectedItem) return;

        switch (action) {
            case 'download':
                this.downloadFile(this.selectedItem.path);
                break;
            case 'rename':
                this.showRenameModal();
                break;
            case 'info':
                this.showFileInfo(this.selectedItem.path);
                break;
            case 'delete':
                this.deleteItem(this.selectedItem.path);
                break;
        }
    },

    handleEmptyContextAction(action) {
        document.getElementById('contextMenu').classList.remove('show');

        switch (action) {
            case 'upload':
                document.getElementById('fileInput').click();
                break;
            case 'newfolder':
                this.showNewFolderModal();
                break;
            case 'folderinfo':
                this.showFolderInfo();
                break;
        }
    },

    downloadFile(path) {
        const a = document.createElement('a');
        a.href = APP_BASE + `/api/files/download?path=${encodeURIComponent(path)}`;
        a.download = this.selectedItem.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    },

    showNewFolderModal() {
        const modal = this.createModal(this.locales.modals.newFolder.title, `
            <input type="text" class="modal-input" id="folderNameInput" placeholder="${this.locales.modals.newFolder.placeholder}" value="${this.locales.modals.newFolder.defaultName}">
        `, [
            { text: this.locales.modals.newFolder.cancel, class: 'btn-column5', action: 'cancel' },
            { text: this.locales.modals.newFolder.confirm, class: 'btn-column2', action: 'confirm' }
        ]);

        modal.querySelector('[data-action="confirm"]').onclick = () => this.createNewFolder();
        modal.querySelector('[data-action="cancel"]').onclick = () => this.closeModal();

        document.body.appendChild(modal);
        setTimeout(() => {
            document.getElementById('folderNameInput').focus();
            document.getElementById('folderNameInput').select();
        }, 0);
    },

    async createNewFolder() {
        const name = document.getElementById('folderNameInput').value.trim();

        if (!name) {
            this.showMessage(this.locales.modals.message.hint, this.locales.modals.message.pleaseEnterFolderName, 'info');
            return;
        }

        try {
            const response = await fetch(APP_BASE + '/api/files/newfolder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parent: this.currentFolderPath })
            });
            const data = await response.json();

            if (data.success) {
                this.closeModal();
                await this.loadFiles(this.currentFolderPath);
            } else {
                this.showMessage(this.locales.modals.message.error, data.message || this.locales.modals.message.newFolderFailed, 'error');
            }
        } catch (error) {
            this.showMessage(this.locales.modals.message.error, this.locales.modals.message.newFolderFailed, 'error');
        }
    },

    showRenameModal() {
        const modal = this.createModal(this.locales.modals.rename.title, `
            <input type="text" class="modal-input" id="newNameInput" placeholder="${this.locales.modals.rename.placeholder}" value="${this.selectedItem.name}">
        `, [
            { text: this.locales.modals.rename.cancel, class: 'btn-column5', action: 'cancel' },
            { text: this.locales.modals.rename.confirm, class: 'btn-column2', action: 'confirm' }
        ]);

        modal.querySelector('[data-action="confirm"]').onclick = () => this.confirmRename();
        modal.querySelector('[data-action="cancel"]').onclick = () => this.closeModal();

        document.body.appendChild(modal);
        setTimeout(() => {
            document.getElementById('newNameInput').focus();
            document.getElementById('newNameInput').select();
        }, 0);
    },

    async confirmRename() {
        const newName = document.getElementById('newNameInput').value.trim();

        if (!newName) {
            this.showMessage(this.locales.modals.message.hint, this.locales.modals.rename.pleaseEnterNewName, 'info');
            return;
        }

        try {
            const response = await fetch(APP_BASE + '/api/files/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPath: this.selectedItem.path, newName })
            });
            const data = await response.json();

            if (data.success) {
                this.closeModal();
                await this.loadFiles(this.currentFolderPath);
            } else {
                this.showMessage(this.locales.modals.message.error, data.message || this.locales.modals.rename.renameFailed, 'error');
            }
        } catch (error) {
            this.showMessage(this.locales.modals.message.error, this.locales.modals.rename.renameFailed, 'error');
        }
    },

    async showFileInfo(path) {
        try {
            const response = await fetch(APP_BASE + `/api/files/info?path=${encodeURIComponent(path)}`);
            const data = await response.json();

            if (data.success) {
                const info = data.info;

                const nameParts = info.name.split('.');
                const extension = nameParts.length > 1 ? nameParts.pop() : '';
                const baseName = nameParts.join('.');

                let fileType = info.isDirectory ? this.locales.fileTypes.folder : this.locales.fileTypes.file;
                let fileTypeDetail = '';
                if (!info.isDirectory && extension) {
                    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
                    const videoExtensions = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'];
                    const audioExtensions = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'];
                    const docExtensions = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt'];

                    if (imageExtensions.includes(extension.toLowerCase())) {
                        fileType = this.locales.fileTypes.image;
                    } else if (videoExtensions.includes(extension.toLowerCase())) {
                        fileType = this.locales.fileTypes.video;
                    } else if (audioExtensions.includes(extension.toLowerCase())) {
                        fileType = this.locales.fileTypes.audio;
                    } else if (docExtensions.includes(extension.toLowerCase())) {
                        fileType = this.locales.fileTypes.document;
                    }
                    fileTypeDetail = ` (.${extension})`;
                }

                const filesRoot = this.filesRoot;
                let location = info.path.replace(filesRoot, '').replace(/\\/g, '/');
                if (!location || location === '/') {
                    location = this.locales.toolbar.rootDir;
                } else {
                    if (!location.startsWith('/')) location = '/' + location;
                    location = this.locales.toolbar.rootDir + location;
                }

                const blockSize = 512;
                const blocks = Math.ceil(info.size / blockSize);
                const allocatedSize = blocks * blockSize;

                const formatSizeWithBytes = (size) => {
                    return `${this.formatFileSize(size)} (${size.toLocaleString()} ${this.locales.fileTypes.bytes})`;
                };

                const formatDateTime = (dateStr) => {
                    const date = new Date(dateStr);
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    const hours = String(date.getHours()).padStart(2, '0');
                    const minutes = String(date.getMinutes()).padStart(2, '0');
                    const seconds = String(date.getSeconds()).padStart(2, '0');
                    return `${year}${this.locales.dateFormat.year}${month}${this.locales.dateFormat.month}${day}${this.locales.dateFormat.day}${this.locales.dateFormat.separator}${hours}:${minutes}:${seconds}`;
                };

                const modal = this.createModal(this.locales.modals.info.fileInfo, `
                    <div class="file-detail">
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.fileName}</span>
                            <span class="detail-value">${info.isDirectory ? info.name : baseName}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.fileType}</span>
                            <span class="detail-value">${fileType}${fileTypeDetail}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.location}</span>
                            <span class="detail-value">${location}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.size}</span>
                            <span class="detail-value">${info.isDirectory ? '-' : formatSizeWithBytes(info.size)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.allocatedSize}</span>
                            <span class="detail-value">${info.isDirectory ? '-' : formatSizeWithBytes(allocatedSize)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.created}</span>
                            <span class="detail-value">${formatDateTime(info.created)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.modified}</span>
                            <span class="detail-value">${formatDateTime(info.modified)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.accessed}</span>
                            <span class="detail-value">${formatDateTime(info.accessed)}</span>
                        </div>
                    </div>
                `, [
                    { text: this.locales.modals.info.close, class: 'btn-column5', action: 'close' }
                ]);

                modal.querySelector('[data-action="close"]').onclick = () => this.closeModal();
                document.body.appendChild(modal);
            } else {
                this.showMessage(this.locales.modals.message.error, data.message || this.locales.modals.info.getInfoFailed, 'error');
            }
        } catch (error) {
            this.showMessage(this.locales.modals.message.error, this.locales.modals.info.getInfoFailed, 'error');
        }
    },

    showToast(message, type = 'info') {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                toast.classList.add('show');
            });
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    },

    showMessage(title, message, type = 'info') {
        this.showToast(message, type);
    },

    async showFolderInfo() {
        const filesRoot = this.filesRoot;
        if (!this.currentFolderPath || this.currentFolderPath === filesRoot) {
            this.showMessage(this.locales.modals.message.hint, this.locales.modals.message.rootDirNoInfo, 'info');
            return;
        }

        try {
            const response = await fetch(APP_BASE + `/api/files/info?path=${encodeURIComponent(this.currentFolderPath || '')}`);
            const data = await response.json();

            if (data.success) {
                const info = data.info;

                const filesRoot = this.filesRoot;
                let location = info.path.replace(filesRoot, '').replace(/\\/g, '/');
                if (!location || location === '/') {
                    location = this.locales.toolbar.rootDir;
                } else {
                    if (!location.startsWith('/')) location = '/' + location;
                    location = this.locales.toolbar.rootDir + location;
                }

                const formatDateTime = (dateStr) => {
                    const date = new Date(dateStr);
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    const hours = String(date.getHours()).padStart(2, '0');
                    const minutes = String(date.getMinutes()).padStart(2, '0');
                    const seconds = String(date.getSeconds()).padStart(2, '0');
                    return `${year}${this.locales.dateFormat.year}${month}${this.locales.dateFormat.month}${day}${this.locales.dateFormat.day}${this.locales.dateFormat.separator}${hours}:${minutes}:${seconds}`;
                };

                const modal = this.createModal(this.locales.modals.info.folderInfo, `
                    <div class="file-detail">
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.folderName}</span>
                            <span class="detail-value">${info.name}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.location}</span>
                            <span class="detail-value">${location}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.created}</span>
                            <span class="detail-value">${formatDateTime(info.created)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.modified}</span>
                            <span class="detail-value">${formatDateTime(info.modified)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">${this.locales.modals.info.accessed}</span>
                            <span class="detail-value">${formatDateTime(info.accessed)}</span>
                        </div>
                    </div>
                `, [
                    { text: this.locales.modals.info.close, class: 'btn-column5', action: 'close' }
                ]);

                modal.querySelector('[data-action="close"]').onclick = () => this.closeModal();
                document.body.appendChild(modal);
            } else {
                this.showMessage(this.locales.modals.message.error, data.message || this.locales.modals.info.getFolderInfoFailed, 'error');
            }
        } catch (error) {
            this.showMessage(this.locales.modals.message.error, this.locales.modals.info.getFolderInfoFailed, 'error');
        }
    },

    async deleteItem(path) {
        const confirmMsg = this.selectedItem.isDirectory
            ? this.locales.modals.delete.confirmDeleteFolder.replace('{name}', this.selectedItem.name)
            : this.locales.modals.delete.confirmDeleteFile.replace('{name}', this.selectedItem.name);

        const modal = this.createModal(this.locales.modals.delete.title, `
            <p style="color: var(--danger-color); margin-bottom: 10px;">${confirmMsg}</p>
            <p style="font-size: 14px; color: var(--text-secondary);">${this.locales.modals.delete.cannotUndo}</p>
        `, [
            { text: this.locales.modals.delete.cancel, class: 'btn-column5', action: 'cancel' },
            { text: this.locales.modals.delete.confirm, class: 'btn-column4', action: 'confirm' }
        ]);

        modal.querySelector('[data-action="confirm"]').onclick = async () => {
            try {
                const response = await fetch(APP_BASE + '/api/files/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path })
                });
                const data = await response.json();

                if (data.success) {
                    await this.loadFiles(this.currentFolderPath);
                    this.closeModal();
                } else {
                    this.showMessage(this.locales.modals.message.error, data.message || this.locales.modals.delete.deleteFailed, 'error');
                }
            } catch (error) {
                this.showMessage(this.locales.modals.message.error, this.locales.modals.delete.networkError, 'error');
            }
        };
        modal.querySelector('[data-action="cancel"]').onclick = () => this.closeModal();

        document.body.appendChild(modal);
    },

    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);
        if (this.currentFolderPath) {
            formData.append('folder', this.currentFolderPath);
        }

        try {
            const response = await fetch(APP_BASE + '/api/files/upload', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (data.success) {
                await this.loadFiles(this.currentFolderPath);
            } else {
                this.showMessage(this.locales.modals.message.error, data.message || this.locales.modals.message.uploadFailed, 'error');
            }
        } catch (error) {
            this.showMessage(this.locales.modals.message.error, this.locales.modals.message.uploadFailed, 'error');
        }

        e.target.value = '';
    },

    createModal(title, content, buttons) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        const titleEl = document.createElement('h3');
        titleEl.className = 'modal-title';
        titleEl.textContent = title;

        const contentEl = document.createElement('div');
        contentEl.innerHTML = content;

        const btnContainer = document.createElement('div');
        btnContainer.className = 'modal-buttons';

        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.className = `btn ${btn.class}`;
            button.textContent = btn.text;
            button.dataset.action = btn.action;
            btnContainer.appendChild(button);
        });

        modal.appendChild(titleEl);
        modal.appendChild(contentEl);
        modal.appendChild(btnContainer);
        overlay.appendChild(modal);

        // 先添加到DOM
        document.body.appendChild(overlay);

        // 强制浏览器重排，确保过渡效果生效
        // 先触发一次重排，然后在下次动画帧添加active类
        overlay.offsetHeight;
        requestAnimationFrame(() => {
            setTimeout(() => {
                overlay.classList.add('active');
            }, 10);
        });

        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                this.closeModal();
            }
        });

        // 阻止弹窗内部点击冒泡
        modal.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // ESC键关闭
        const escHandler = (e) => {
            if (e.key === 'Escape' || e.key === 'ESC') {
                this.closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // 禁止背景滚动
        document.body.style.overflow = 'hidden';

        return overlay;
    },


    closeModal() {
        const overlay = document.querySelector('.modal-overlay.active');
        if (overlay) {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 300);
        }
        document.body.style.overflow = '';
    },

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('zh-CN');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
