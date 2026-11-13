; 明星学校 WPF 客户端 —— Inno Setup 安装脚本（框架依赖版）
; 目标：Win11 x64，安装到 Program Files，附带开始菜单/桌面快捷方式，
;       安装前检测 .NET 10 桌面运行时，缺失则提示前往官网下载。

#define MyAppName "明星学校"
#define MyAppNameEn "MingxingSchool"
#define MyAppVersion "0.1"
#define MyAppPublisher "MingxingSchool"
#define MyAppExeName "MingxingSchool.Desktop.exe"

[Setup]
; 应用唯一标识（GUID），升级时保持不变
AppId={{9D2E1B6C-3A7F-4E5A-9B1C-2D3E4F5A6B7C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppNameEn}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 输出文件存放目录与文件名
OutputDir=D:\MingxingSchool\application
OutputBaseFilename=Windows-x64-MingXingSchool-setup-{#MyAppVersion}
; 压缩与界面
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; 仅 x64（发布产物为 win-x64）
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 需管理员权限（写 Program Files）
PrivilegesRequired=admin
; 卸载项使用应用图标
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "D:\MingxingSchool\windows\installer\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
; 发布目录下的全部文件（含 exe/dll/runtimeconfig/deps）
Source: "D:\MingxingSchool\windows\publish\framework\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
// 检测是否安装有 .NET 10 桌面运行时（Microsoft.WindowsDesktop.App 10.x）。
// 采用「物理目录」检测：运行时无论以何种方式安装，标准位置都会有
// %ProgramFiles%\dotnet\shared\Microsoft.WindowsDesktop.App\<版本号> 目录。
// 此前用注册表键检测，但某些非标准安装方式（如 dotnet-install 脚本）不写注册表，
// 会导致已装运行时却误报「未检测到」，故改为目录探测。
function HasDotNetDesktop10(): Boolean;
var
  BaseDir: string;
  FindRec: TFindRec;
begin
  Result := False;
  // 64 位 Program Files（x64/arm64 运行时默认位置）
  BaseDir := ExpandConstant('{pf}\dotnet\shared\Microsoft.WindowsDesktop.App');
  if DirExists(BaseDir) and FindFirst(BaseDir + '\10*', FindRec) then
  begin
    Result := True;
    FindClose(FindRec);
    Exit;
  end;
  // 32 位 Program Files（x86 运行时）
  BaseDir := ExpandConstant('{pf32}\dotnet\shared\Microsoft.WindowsDesktop.App');
  if DirExists(BaseDir) and FindFirst(BaseDir + '\10*', FindRec) then
  begin
    Result := True;
    FindClose(FindRec);
    Exit;
  end;
end;

// 框架依赖模式下，目标机器若缺 .NET 10 桌面运行时会导致程序无法启动。
// 在安装开始前提前拦截并给出下载指引。
function InitializeSetup(): Boolean;
begin
  Result := True;
  if HasDotNetDesktop10() then
    Exit;
  MsgBox('未检测到 .NET 10 桌面运行时。' + #13#10#13#10 +
         '本客户端需要安装 ".NET Desktop Runtime 10.x (Windows x64)" 才能运行。' + #13#10 +
         '请前往微软官网下载安装后，再重新运行本安装程序。' + #13#10#13#10 +
         'https://dotnet.microsoft.com/download/dotnet/10.0', mbError, MB_OK);
  Result := False;
end;