# 安装说明（通用版）

本仓库根目录就是**可直接安装的插件包**，不再需要进子目录。

## 一条命令安装

```sh
# Web profile
dsh plugin --profile web add "github:tonyyang115-gif/dsh-workbuddy-connect#<commit-sha>"

# Desktop profile
dsh plugin --profile desktop add "github:tonyyang115-gif/dsh-workbuddy-connect#<commit-sha>"
```

把 `<commit-sha>` 换成 release tag 对应的 40 位 commit（推荐钉死，避免 HEAD 漂移）。
也可以直接用 tag 名：`github:tonyyang115-gif/dsh-workbuddy-connect#v0.7.9`。

## 装完还差一步：注册为 bundle

`dsh plugin add` 只负责把包装进 `node_modules`，**不会**自动写进 `dsh.profile.bundles`。
在 profile 的 `package.json` 里补上：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-workbuddy-connect"
      ]
    }
  }
}
```

然后完全退出并重启 DSH。模型选择器里出现 `WorkBuddy` 分组即成功。

## 可能遇到的两个报错

### 1. `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts`

pnpm 11+ 的构建脚本门禁，**包其实已经装好了**，只是命令返回 exit 1。
在 profile 的 `pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  '@google/genai': true
  protobufjs: true
```

然后重跑安装命令，会变成干净的 exit 0。

### 2. 关于版本号

本包声明了 `engines.dsh: "^0.2.1-rc.2"`，覆盖整个 DSH 0.2 线
（0.2.1-rc.2 起，到 0.2.x 全部，0.3.0 会被正确拒绝）。

这条声明**优先于所有 `peerDependencies`**——DSH 的
`evaluatePluginCompatibility()` 一旦看到 `engines.dsh` 就直接用它判定，
不再逐个检查 `@deepseek-ai/dsh-*` 的 peer 范围。

所以 DSH 从 0.2.1 升级到 0.2.x 的任何版本，本插件都不需要改。

## 兼容版本

| DSH 内核 | 状态 |
|---|---|
| 0.2.1-rc.2 / 0.2.1-rc.3 | ✅ |
| 0.2.2-rc.1 及以上 0.2.x | ✅ |
| 0.3.0+ | ❌ 需更新插件 |

## 手动打包（不想走 github: 时）

```sh
git clone --depth 1 https://github.com/tonyyang115-gif/dsh-workbuddy-connect.git
cd dsh-workbuddy-connect
npm pack                    # 注意：用 npm pack，不要用 pnpm pack
dsh plugin --profile web add "file:$(pwd)/dsh-workbuddy-connect-0.7.9+dshfix.6.tgz"
```

> **必须用 `npm pack`，不要用 `pnpm pack`。**
> `pnpm pack` 会剥掉版本号里的 build metadata（`0.7.9+dshfix.6` → `0.7.9`），
> 导致插件自检报「版本不一致，请重新安装」，而这个提示会一直挂着。
> `npm pack` 会完整保留。

`lib/` 已随仓库提交，无需自行构建。`prepack` 脚本会检测 `tsdown` 是否存在：
装了就重新构建，没装就直接用已提交的 `lib/`。

## 目录说明

| 路径 | 内容 |
|---|---|
| `package.json` / `lib/` / `src/` / `cordis.patch.yml` | 插件本体（仓库根即安装源） |
| `reference/upstream/` | 上游原始源码快照，仅供对照 |
| `reference/UPSTREAM.md` | 来源与验证记录 |
| `reference/ARCHIVE-README.md` | 原「源码存档」版 README |
