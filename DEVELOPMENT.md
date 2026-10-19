# 开发与发布

桌面与后台统一版本为 `2.0.0-beta.5`。完整可编辑工程随安装器提供，菜单可以导出；GitHub Release 同时提供源码 ZIP。

## 模块

| 路径 | 作用 |
| --- | --- |
| `public/` | 浅色工作台、轻量动画、分页与懒加载规格 |
| `desktop/` | Electron 主窗口、托盘、隔离 bridge、下载与安装 |
| `desktop/assets/guardian.svg` | 可修改图标源，生成多尺寸 ICO 与 PNG |
| `src/accounts.mjs` | 本机店铺注册、独立资料与授权 |
| `src/updates.mjs` | GitHub 版本选择、严格来源与 SHA256 校验 |
| `src/catalog.mjs` | 只读商品视图，不供执行路径读取 |
| `src/priority-watch.mjs` | 持久活动成员线索；只安排核对优先级，不证明缺失或批准价格 |
| `src/platform.mjs` | 专用浏览器的平台读取与动作 |
| `src/policy.mjs` | SKU 匹配、原价与折扣证明 |
| `src/service.mjs` | 巡检、旧阻塞冷却、新失效优先与独立回读 |
| `src/journal.mjs` | SQLite 任务日志、租约、历史与未知提交 |

## 本地开发

需要 Node 24.18.0 和 PowerShell 7；依赖锁定在 package-lock.json。

```powershell
npm ci
npx playwright install chromium
npm test
npm run test:browser
npm run test:desktop
npm run check
```

`npm start` 启动后台，`npm run desktop` 启动桌面。不要在正式端口上启动第二实例；自动化测试全部使用临时运行目录、独立随机端口与模拟店铺。完整浏览器回归较慢，开发可先运行改动涉及的测试。

```powershell
npm run build:desktop
npm run build:source
```

构建要求本地 Chromium `chromium-1248` 与对应 Node LICENSE。安装包内置运行环境。prepare-desktop 只收集程序源码与默认空配置，不携带 runtime、真实店铺配置、浏览器资料或 SQLite。afterPack 验证每个后端文件、源码和桌面模块，失败不会生成安装器。

## GitHub 更新发布

更新仓库固定为 `qq1395970680-source/doudian-guardian-updates`。Release 标签必须为 `v<package.json版本>`，上传 `DoudianGuardian-Setup-<版本>-x64.exe` 和对应 Source ZIP。先发布 draft 并核对资产，最后发布 Release。程序通过 GitHub REST 的 Release 资产 SHA256、大小与固定仓库路径校验文件；支持 alpha、beta、rc 和正式版本顺序，忽略草稿。

每次功能发布增加版本号，重新执行相关回归与打包校验，再发布新 Release；不替换已经发布的同版本安装器。安装器只替换代码，后台从独立不可变版本目录运行。新桌面等业务空闲且未知提交归零才切换后台，不强杀、不覆盖运行代码、不降级。

## 执行边界

所有价格动作要求当次店铺、商品、当前规格、原价与历史折扣核对。写入前持久记录尝试；崩溃后未知结果只回读、不再次创建。展示快照、外部诊断与验收文件均不是执行命令或批准。明确下架跳过；列表未找到不等于下架。新增规格、原价变化、重复映射均不可当历史缺失忽略。

本程序没有全店秒级 SLA；需要完整读取平台列表及规格。更多店铺、不同机器、平台变化与进一步降价审批界面仍需要对应实证验收。
