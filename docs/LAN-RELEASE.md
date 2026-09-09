# 局域网版本发行

`lan` 分支提供 Windows x64 独立运行包；`main` 是 GitHub Pages + Supabase 互联网版本。局域网包在 GitHub 仓库的 [Releases](https://github.com/inewhero/Foreign-land/releases) 下载，选择带 `lan-v` 前缀的版本。

## 下载后使用

1. 下载 `.zip` 并完整解压到可写目录。
2. 双击 `启动实验.cmd`。包内包含 Node.js，无需安装 Node.js 或运行 npm。
3. 主试电脑与被试设备连接同一个局域网，使用主试端显示的二维码加入。首次防火墙提示允许专用网络。
4. 结束后先导出数据，再运行 `停止实验.cmd`，最后运行 `备份数据.cmd`。

数据库保存于解压目录的 `data/experiment.sqlite`。升级应解压到新目录，保留旧目录及数据备份，不要覆盖正在运行的实验。详细操作见包内《实验人员使用说明》。

使用 PowerShell 验证 ZIP：`Get-FileHash -Algorithm SHA256 -LiteralPath '下载的文件.zip'`，将结果与同名 `.sha256.txt` 内容比较。

## 维护者发布

在 `lan` 分支更新 `package.json` 版本并同步锁文件，提交并推送，然后在该提交创建对应标签：

```powershell
git switch lan
git pull --ff-only origin lan
git tag -a lan-v0.1.0 -m "LAN Windows release 0.1.0"
git push origin lan-v0.1.0
```

标签版本必须与 `package.json` 一致。工作流要求标签恰好指向远端 `lan` 当前提交，且不能同时是 `main` 当前提交；推送标签后请等校验完成再推进 `lan`。这也意味着旧标签重跑时，若 `lan` 已推进会被拒绝，应发布新的版本。

GitHub Actions 在 Windows x64 runner 上安装 Node.js 24，执行 `npm ci`、测试、正式序列校验，然后调用 `scripts/package-field.ps1 -SkipChecks`。该脚本仍执行完整生产构建；`-SkipChecks` 仅跳过已单独执行的测试与序列校验。成功后校验 ZIP 的 SHA256，将 ZIP 与校验文件上传到 Actions artifacts 和 GitHub Release。局域网发行不会占用仓库的 Latest 标记。

## 打包范围与限制

- 当前只发行 Windows x64，不支持 macOS/Linux 原生启动。
- 包含完整 `node_modules`（包括运行 TypeScript 服务所需的 `tsx`），压缩包体积较大。不要使用 `npm ci --omit=dev`，否则启动器缺少依赖。
- 打包脚本只新建空 `data`，不复制开发机的实验数据库或 `.env`。运行时数据库保存在本机，不会上传 Supabase。
- 自动流程验证测试、序列、构建和校验和；实际手机接入、防火墙、WiFi 隔离以及 Windows 首次启动仍需现场预演。
- 发布权限由仓库 Actions 的 `contents: write` 提供；无需个人访问令牌。若仓库规则禁止 Actions 创建 Release，需由仓库管理员调整相应规则。
