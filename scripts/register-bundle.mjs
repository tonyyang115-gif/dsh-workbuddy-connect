#!/usr/bin/env node
/**
 * register-bundle.mjs — 把已安装的 DSH 插件注册进 profile 的 dsh.profile.bundles
 *
 * 为什么需要它：
 *   `dsh plugin add` 只把包写进 node_modules 与 dependencies，不会写
 *   dsh.profile.bundles。而 dsh-app-boot 只加载 bundles 列表里的包
 *   （dsh-app-boot/lib/index.js:1796 `const bundles = ...dsh?.profile?.bundles ?? []`），
 *   所以不注册 = 装了但完全不加载，模型列表里看不到。
 *
 * 与"手改 package.json"的区别：
 *   本脚本会先用 Node 自己的解析规则验证包真的能解析到（等价于
 *   resolveBundleDir 的 profileDir 锚点），并校验它有 dsh.bundle 声明。
 *   解析失败会被 boot 静默跳过（只进 skippedBundles，无报错），
 *   所以这里必须提前拦住。
 *
 * 用法：
 *   node scripts/register-bundle.mjs                       # 自动探测 profile
 *   node scripts/register-bundle.mjs --profile desktop
 *   node scripts/register-bundle.mjs --profile desktop web  # 注册多个
 *   node scripts/register-bundle.mjs --profile desktop --dry-run
 *   node scripts/register-bundle.mjs --list                 # 列出所有 profile
 *   node scripts/register-bundle.mjs --profile desktop --remove
 *
 * 退出码：0 成功（含"已经注册过"），1 出错。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const BUNDLE_NAME = 'dsh-workbuddy-connect';
const HERE = dirname(fileURLToPath(import.meta.url));

// ── 参数解析 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { profiles: [], dryRun: false, list: false, remove: false, name: BUNDLE_NAME, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') {
      // 吃掉后面所有非 -- 开头的值，支持 --profile a b c
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.profiles.push(argv[++i]);
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list') out.list = true;
    else if (a === '--remove') out.remove = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { fail(`未知参数：${a}（--help 查看用法）`); }
  }
  if (!out.list && out.profiles.length === 0) out.profiles = detectProfiles();
  return out;
}

function printHelp() {
  console.log(`用法：
  node scripts/register-bundle.mjs [选项]

选项：
  --profile <名字...>   指定 profile（可多个）。省略则自动选
  --list                列出本机所有 profile 及其 bundles 状态
  --remove              从 bundles 移除（不删包）
  --name <包名>         要注册的包名，默认 ${BUNDLE_NAME}
  --dry-run             只显示将做什么，不写文件
  --quiet               减少输出
  -h, --help            显示本帮助`);
}

const c = {
  ok:   (s) => process.stdout.write(`  \x1b[32m✓\x1b[0m ${s}\n`),
  info: (s) => process.stdout.write(`  ${s}\n`),
  warn: (s) => process.stdout.write(`  \x1b[33m!\x1b[0m ${s}\n`),
  err:  (s) => process.stdout.write(`  \x1b[31m✗\x1b[0m ${s}\n`),
  head: (s) => process.stdout.write(`\n\x1b[1m${s}\x1b[0m\n`),
};

function fail(msg, code = 1) {
  process.stderr.write(`\x1b[31m错误：\x1b[0m ${msg}\n`);
  process.exit(code);
}

// ── DSH_HOME 与 profile 发现 ──────────────────────────────────────────
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function profilesRoot() {
  return join(dshHome(), 'profiles');
}

function listProfiles() {
  const root = profilesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(root, name, 'package.json')))
    .sort();
}

/**
 * 自动选 profile：
 *   1. 本机有工作目录痕迹的 desktop（dependencies 里有本插件）
 *   2. 否则报错，让用户显式 --profile
 */
function detectProfiles() {
  const all = listProfiles();
  if (all.length === 0) fail(`找不到任何 profile：${profilesRoot()} 不存在或为空。请先运行 dsh 创建 profile。`);

  const withPlugin = all.filter((name) => {
    const manifest = readManifest(join(profilesRoot(), name));
    return manifest?.dependencies && Object.hasOwn(manifest.dependencies, BUNDLE_NAME);
  });
  if (withPlugin.length === 1) return withPlugin;
  if (withPlugin.length > 1) {
    c.warn(`多个 profile 已安装 ${BUNDLE_NAME}：${withPlugin.join(', ')}。将全部注册（可用 --profile 指定）。`);
    return withPlugin;
  }
  fail(`没有任何 profile 的 dependencies 里有 ${BUNDLE_NAME}。\n      先执行：dsh plugin --profile <名字> add "github:tonyyang115-gif/dsh-workbuddy-connect"\n      或用 --profile 显式指定要注册的 profile。`);
}

// ── 清单读写 ──────────────────────────────────────────────────────────
function readManifest(profileDir) {
  const p = join(profileDir, 'package.json');
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${p} 不是合法 JSON：${e.message}`);
  }
}

function writeManifest(profileDir, manifest, dryRun) {
  const p = join(profileDir, 'package.json');
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (dryRun) {
    c.info(`（dry-run）将写入 ${p}`);
    return;
  }
  // 备份一次，保留最早的（不覆盖已有备份）
  const bak = p + '.bak-register-bundle';
  if (!existsSync(bak)) copyFileSync(p, bak);
  writeFileSync(p, text, 'utf8');
}

// ── 解析验证（等价于 resolveBundleDir 的 profileDir 锚点）──────────────
/**
 * 用 profile 的 package.json 作锚点，走 Node 的 require 解析路径找包目录。
 * 命中条件：目录下存在 package.json。
 * 这与 dsh-app-boot 的 packageDirFromAnchor 行为一致。
 */
function resolveFromProfile(profileDir, packageName) {
  const anchor = join(profileDir, 'package.json');
  let paths;
  try {
    paths = createRequire(anchor).resolve.paths(packageName) ?? [];
  } catch {
    return undefined;
  }
  for (const searchPath of paths) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/**
 * 校验包能作为 bundle 加载：有 dsh.bundle 声明，且 engines.dsh（若有）不排斥本机 DSH。
 */
function inspectBundle(packageDir) {
  const manifest = readManifest(packageDir);
  if (!manifest) return { ok: false, reason: 'package.json 读不出来' };

  if (!manifest.dsh?.bundle) {
    return { ok: false, reason: 'package.json 没有 dsh.bundle 声明 → boot 会拒绝（"declares no dsh.bundle"）' };
  }

  return {
    ok: true,
    version: manifest.version,
    enginesDsh: manifest.engines?.dsh,
    hasBundlePatch: Boolean(manifest.dsh.bundle.patch),
  };
}

/** 粗判：engines.dsh 是否存在（真正判定交给 boot，这里只提示） */
function describeEngines(enginesDsh) {
  if (!enginesDsh) return '未声明 engines.dsh（将回落到 peerDependencies 检查）';
  return `engines.dsh = ${enginesDsh}（存在此字段时 peerDependencies 全部被忽略）`;
}

// ── 主流程 ────────────────────────────────────────────────────────────
function list() {
  const all = listProfiles();
  c.head(`DSH_HOME = ${dshHome()}`);
  if (all.length === 0) {
    c.warn('没有任何 profile。');
    return;
  }
  const rows = all.map((name) => {
    const dir = join(profilesRoot(), name);
    const manifest = readManifest(dir) ?? {};
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const dep = manifest.dependencies?.[BUNDLE_NAME];
    const registered = bundles.includes(BUNDLE_NAME);
    const resolved = dep ? resolveFromProfile(dir, BUNDLE_NAME) : undefined;
    return { name, dep, registered, resolved, bundleCount: bundles.length };
  });

  const nameW = Math.max(7, ...rows.map((r) => r.name.length));
  c.info(`${'profile'.padEnd(nameW)}  ${'bundles'.padStart(7)}  ${'依赖'.padEnd(6)}  ${'已注册'.padEnd(7)}  可解析`);
  c.info('─'.repeat(nameW + 40));
  for (const r of rows) {
    const depMark = r.dep ? '有' : '无';
    const regMark = r.registered ? '是' : '否';
    const resMark = r.resolved ? '是' : (r.dep ? '否(异常)' : '—');
    c.info(`${r.name.padEnd(nameW)}  ${String(r.bundleCount).padStart(7)}  ${depMark.padEnd(6)}  ${regMark.padEnd(7)}  ${resMark}`);
  }
  console.log('');
  c.info('提示：依赖=有 但 已注册=否 的 profile 需要跑本脚本；已注册=是 但 可解析=否 说明包目录丢了，需重装。');
}

function processProfile(profileName, opts) {
  const dir = join(profilesRoot(), profileName);
  if (!existsSync(dir)) fail(`profile 不存在：${dir}`);

  const label = profileName;
  c.head(`profile: ${label}`);

  const manifest = readManifest(dir);
  if (!manifest) fail(`${dir}/package.json 读不出来`);

  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : [];
  const already = bundles.includes(opts.name);

  // ── 移除模式 ──
  if (opts.remove) {
    if (!already) {
      c.info(`${opts.name} 本来就不在 bundles 里，无需移除。`);
      return true;
    }
    manifest.dsh.profile.bundles = bundles.filter((b) => b !== opts.name);
    writeManifest(dir, manifest, opts.dryRun);
    c.ok(`已从 bundles 移除 ${opts.name}（包仍在 node_modules，未删除）`);
    c.info('重启 DSH 后生效。');
    return true;
  }

  // ── 注册模式：先验证 ──
  const dep = manifest.dependencies?.[opts.name];
  if (!dep) {
    c.err(`dependencies 里没有 ${opts.name}。`);
    c.info(`先安装：dsh plugin --profile ${profileName} add "github:tonyyang115-gif/dsh-workbuddy-connect#good-dsh-0.2.x"`);
    return false;
  }
  c.ok(`dependencies: ${dep}`);

  const packageDir = resolveFromProfile(dir, opts.name);
  if (!packageDir) {
    c.err(`从 profile 解析不到 ${opts.name} 的目录。`);
    c.info(`查过这些路径：${(createRequire(join(dir, 'package.json')).resolve.paths(opts.name) ?? []).join(', ') || '(空)'}`);
    c.info('包没落盘，需要重新安装。');
    return false;
  }
  c.ok(`可解析到 ${packageDir}`);

  const info = inspectBundle(packageDir);
  if (!info.ok) {
    c.err(`这个包不能作为 bundle 加载：${info.reason}`);
    return false;
  }
  c.ok(`dsh.bundle 声明存在，version = ${info.version}`);
  if (!opts.quiet) c.info(`  ${describeEngines(info.enginesDsh)}`);

  // ── 写 bundles ──
  if (already) {
    c.ok(`${opts.name} 已在 bundles 里（位置 #${bundles.indexOf(opts.name) + 1}），无需改动。`);
    return true;
  }

  bundles.push(opts.name);
  manifest.dsh.profile.bundles = bundles;
  writeManifest(dir, manifest, opts.dryRun);
  c.ok(`${opts.dryRun ? '将加入' : '已加入'} bundles（共 ${bundles.length} 项）`);
  if (!opts.dryRun) c.info('  完全退出并重启 DSH 后生效。');
  return true;
}

// ── 入口 ──────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) { list(); return; }

  if (!opts.quiet) {
    c.head(`注册 ${opts.name} → profile bundles`);
    c.info(`DSH_HOME = ${dshHome()}`);
    if (opts.dryRun) c.info('（dry-run 模式：不写任何文件）');
  }

  let allOk = true;
  for (const name of opts.profiles) {
    if (!processProfile(name, opts)) allOk = false;
  }

  if (!opts.quiet) {
    console.log('');
    if (allOk) c.ok('完成。');
    else c.err('有 profile 处理失败，见上面原因。');
  }
  process.exit(allOk ? 0 : 1);
}

main();
