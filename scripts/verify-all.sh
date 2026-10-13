#!/bin/bash
# Agentia 全链验证：逐步骤检查退出码（不用 `cmd && echo` —— 那样会吞掉失败）
set -uo pipefail
# 从脚本位置推仓库根 —— 不要硬编码绝对路径（CI / 他人机器上必挂）
cd "$(dirname "$0")/.."

# ⚠️ 本脚本的**步骤数**写在 CI 的 job 名里 —— 而那个名字就是分支保护里的必需状态检查
#    「全链验证（verify-all 8 步）」。加/减一步都得同时改 workflow 的 job name **和** 分支保护，
#    否则 PR 会卡死等一个永不出现的检查。所以新增的检查一律**折进已有步骤**，不加步骤。
#
#    这次就是照这条规矩做的：lint 折进第 1 步，而不是变成第 9 步。
#
# ── 用法（2026-10-14 加分片）──────────────────────────────────────────────────
#
#   bash scripts/verify-all.sh            # 缺省 = 全链（与 CI **逐字同一条链**）
#   bash scripts/verify-all.sh rapid      # 只跑静态三步：类型 / lint / 两处类型检查
#
# 为什么要分片：**不给人一个官方子集，他就会自己手敲其中两条命令** —— 而那些手敲的命令
# 与链上那条迟早分叉（本仓踩过：lint 只活在 CI 的独立 job 里，于是「本地全绿、CI 挂 Biome」
# 真的发生过）。分片把「先跑一点」变成**有名字、有自证**的一件事，而它跑的就是 `steps` 里
# **同一条**命令 —— 不存在第二份命令清单。
#
# ⚠️ 三条边界，改本脚本前先读：
#   ① **CI 永远跑缺省（全链）**。分片只服务本地（`.githooks/pre-push`）与「改一处想快点验」；
#   ② 分片**不改** CI job 名里那个数字 —— 那个数字是步骤总数，不是被选中的步数；
#   ③ 分片**不是门禁**：跑 `rapid` 全绿**不等于**可以推 PR，它只覆盖静态检查那三步。
shard="${1:-all}"
case "$shard" in
  all | rapid) ;;
  *)
    # ⚠️ `$shard` 后面紧跟全角字符时必须写成 `${shard}` —— 否则 bash 会把「（可用」当成
    #    变量名的一部分（`shard（可用：...: unbound variable`）。本仓踩过同款。
    echo "✖ 未知分片：${shard}（可用：all / rapid —— 见本脚本顶部「用法」）"
    exit 2
    ;;
esac

steps=(
  # 第 1 步 = 类型检查 + lint。lint 此前只活在 CI 的独立 job 里，本地这条链不跑它 ——
  # 于是「本地 8/8 全绿、CI 挂 Biome」**真的发生过**（2026-09-14：本地全绿，CI 的 lint job
  # 在新写的源码与测试上挂了 4 条格式 error）。折进已有步骤有两个好处：job 名不必改，
  # 且 lint 从此落在**必需检查**里面 —— 新开一个非必需 job 反而是更弱的保证。
  # 2026-09-20：从「只报 error」翻成**零告警**。此前 `npm run lint`/`biome ci` 都是
  # 「没 error 就绿」—— 存量 93 warnings + 12 infos 照样过闸门。翻严的配套：
  #   ① 存量清零（PR #84）；② info 级规则在 biome.jsonc 里升到 warn（--error-on-warnings
  #   **不管 info**）；③ 三处样式表用带理由的 biome-ignore-all 关掉误报型的 noDescendingSpecificity。
  "npm run typecheck && npx biome ci . --error-on-warnings"
  "npm run build"
  "npm run typecheck:types"
  "npm run typecheck:tests"
  "npm run build:cli"
  "npm test"
  "npm run e2e"
  # 第 8 步 = 构建官网 + **按产物形状**核 agent 可读性（404.html 硬 404 / robots+sitemap /
  # llms.txt 绝对链接与页面覆盖 / llms-full.txt 单源一致 / 每页 llms 指引形态）。
  # 折进本步而不是新开第 9 步 —— 理由见顶部注释（步骤数写在 CI 必需检查名里）。
  # 2026-09-21：这六类问题当时**全是线上实际存在的**，且没有一条是本仓测试能发现的
  #（源码绿、线上照样在骗 agent：soft 404 + 根相对 llms.txt 链接）。
  "npm run build:website && node scripts/check-website-agent-readiness.mjs"
)

# 每步的名字 —— **分片按名字选步，不按下标**。下标会在插入/重排步骤时**静默错位**：那时
# 分片跑的是别的步骤，而它照样打印「全绿」。名字与 `steps` 一一对应，条数不等即当场失败。
#
# ⚠️ 这份清单**只给分片用**（CI 与缺省路径都不读它）。步骤名不必与命令里的词一一对应，
# 但**不许重名** —— 重名会让分片选到两个下标（顺序上的第一个），而另一个被静默跳过。
step_names=(
  "typecheck+lint"
  "build"
  "types"
  "tests-types"
  "build-cli"
  "test"
  "e2e"
  "website"
)
if [ "${#steps[@]}" -ne "${#step_names[@]}" ]; then
  echo "✖ steps 有 ${#steps[@]} 条、step_names 有 ${#step_names[@]} 条 —— 加/删步骤时两处都要改，否则分片按名字选步会错位"
  exit 2
fi

# 分片定义：`名字列表`，空格分隔。`rapid` = 静态检查三步（秒级、零网络、不需要构建产物）。
if [ "$shard" = all ]; then
  selected=()
  for i in "${!steps[@]}"; do selected+=("$i"); done
else
  case "$shard" in
    rapid) shard_want="typecheck+lint types tests-types" ;;
  esac
  selected=()
  missed=""
  for name in $shard_want; do
    found=""
    for i in "${!step_names[@]}"; do
      if [ "${step_names[$i]}" = "$name" ]; then
        found="$i"
        break
      fi
    done
    if [ -z "$found" ]; then
      missed="$missed $name"
    else
      selected+=("$found")
    fi
  done
  # ⚠️ 选不到就**响亮失败**，两条都查：
  #   ① 名字不存在（步骤改名了）—— 否则分片会「跑得少」而没人知道；
  #   ② 选到 0 步 —— 那会跑完什么都不做然后打印「全绿」，**正是 pre-push 钩子最坏的失效形态**
  #      （它看起来验过了）。宁可红。
  if [ -n "$missed" ]; then
    echo "✖ 分片 '$shard' 里的这些步骤名不存在：$missed —— 步骤改名了？分片定义已失效"
    exit 2
  fi
  if [ "${#selected[@]}" -eq 0 ]; then
    echo "✖ 分片 '$shard' 一个步骤都没选到 —— 它会跑完什么都不做然后报绿，故此处判失败"
    exit 2
  fi
fi

fail=0
for i in "${selected[@]}"; do
  s="${steps[$i]}"
  # ⚠️ 步骤经 `bash -c` 执行，**不要**写成 `if out=$($s 2>&1)`：$s 是词展开，
  #    里面的 shell 运算符（`&&`）不会生效，而是原样变成**命令的实参** ——
  #    第 1 步挤 `npm run typecheck && npx biome ci .` 时就成了
  #    `tsc --noEmit -p tsconfig.json "&&" "npx" "biome" "ci" "."` ⇒ TS5042。
  #    走 `bash -c` 后每个步骤就是一条完整的命令行，可以带 `&&`。
  if out=$(bash -c "$s" 2>&1); then
    echo "  OK   $s"
  else
    echo "  FAIL $s"
    # 失败定位：这里把整段输出捕获进了 $out，若只 tail 尾部，恰好会把
    # 「哪条测试挂了」的标记行冲掉 —— CI 上就只剩一个 exit 1，谁也查不出是谁。
    # 先按 node:test / tsc / biome 的标记抽出关键行，再补尾部上下文。
    # ⚠️ 除了**断言失败**，还有两类非断言的失败，只抓 `not ok` / `AssertionError` 会丢原因：
    #   ① 测试被 runner **cancel**（`failureType: cancelledByParent` + `Promise resolution is
    #      still pending but the event loop has already resolved`，统计里是 `# cancelled N`
    #      而 `# fail 0`）—— 2026-09-14 那次就是这么丢的；
    #   ② biome 的诊断（本地链现在也跑它）首行是
    #      `路径:行:列 lint/分类/规则  FIXABLE  ━━` 或 `路径 format ━━`，**不带 `✖`**
    #      （`✖ File content differs…` 在下一行）—— 只比对 `✖` 等于又丢一次文件名。
    echo "$out" |
      # biome 的诊断首行**带 ANSI 颜色码**（路径与 `format` 之间夹着 `\033[0m`），
      # 直接锚定「路径 format ━━」会失配 —— 先剥色再抽标记行。
      # 尾部上下文保持原样（CI 日志照样有颜色，只是我们匹配时不看它）。
      sed $'s/\033\\[[0-9;]*m//g' |
      grep -aE '✖|✗|not ok|# fail|# cancelled|AssertionError|error TS[0-9]+|Error:|✘|failureType|cancelledByParent|event loop has already resolved|Found [0-9]+ errors?|Some errors were emitted|^[^ ]+ +(format|lint|syntax|assist).*━' |
      head -20 | sed 's/^/    ➜ /'
    echo "$out" | tail -30 | sed 's/^/       /'
    fail=1
  fi
done

echo "------------------------------"
if [ $fail -eq 0 ]; then
  # 计数**算出来**而不是写死：写死的那个数字在加步骤后会变成假话（而这个数字与 CI 的 job 名
  # 是同一个约定，尤其不能各说各话）。
  if [ "$shard" = all ]; then
    echo "${#selected[@]}/${#steps[@]} 全绿"
  else
    # ⚠️ 分片不许打印「N/N 全绿」那个形状 —— 本仓多处文档抄写的是「8/8 全绿」，
    #    分片打印同样的形状会被读成「全链过了」。这里刻意写成另一种形状。
    echo "分片 ${shard}：${#selected[@]}/${#steps[@]} 步全绿（其余 $(( ${#steps[@]} - ${#selected[@]} )) 步未跑 —— 全链请不带参数跑）"
  fi
  # 本地绿 ≠ CI 绿。下面这几个必需检查不由本链把关 —— 但**本地跑得动**，只是没人替你跑
  # （跑法见 CONTRIBUTING 的坑表）。这里曾写「本地无法等价复现」，而**那句话本身没验过**：
  # 2026-09-26 实测两条都能在本机复现 ——
  #   · 导入下限：`npx node@18 scripts/check-import-floor.mjs` ⇒ 真走到 Node 18.20.8 那条分支
  #     （`node@20` ⇒ 20.20.2），不必改 PATH；本机 Node 是 22，跑它才会看到 22 那条分支。
  #   · e2e:mcp：本机有 uvx ⇒ 走的是**真**第三方 server（`uvx mcp-server-time`，2 个工具）。
  # ⚠️ 注意方向是反的：CI 的 `e2e-mcp` job **必定走回落夹具**（runner 上没有 uvx，见 ci.yml 注释），
  #    所以这里不是「本地弱、CI 强」—— 本机覆盖更强，CI 覆盖的恰好是回落分支。
  # 计数从清单长度算出来，理由同上：写死的数字（这里曾写「3」而清单只列了 2 个）迟早各说各话。
  # 每条形如 `<ci.yml 里的 job id>|<给人看的说明>`：**id 那半截是给机器看的** ——
  # `tests/scripts/verify-all-wiring.test.ts` 拿它核两件事：① 这里不能有**幽灵 id**（ci.yml 里
  # 没有的 job）；② ci.yml 里的 job 不能**漏登**（新加一个必需检查却没人在这里说一声就红）。
  # 所以改 job id / 增删 job 时，这里必须跟着改，而改错会当场红 —— 不用靠人记得。
  ci_only=(
    'lint|lint（Biome）—— 命令与第 1 步相同，本地全绿即已覆盖'
    'e2e-mcp|e2e:mcp —— 本机跑：npm run e2e:mcp'
    'e2e-mcp-server|e2e:mcp:server —— 本机跑：npm run e2e:mcp:server（离线零网络，CI 与本机同一条路）'
    'import-floor|导入下限（Node 18 / 20）—— 本机跑：npx node@18 scripts/check-import-floor.mjs'
  )
  # 分片只覆盖链上的一部分 ⇒ 这段「其余必需检查」的说明对它有误导（它连本链都没跑完）。
  if [ "$shard" = all ]; then
    echo "ℹ 分支保护共 $(( ${#ci_only[@]} + 1 )) 个必需检查 —— 本链 = verify，另有 ${#ci_only[@]} 个："
    # `${arr[@]#*|}` = 逐元素去掉 `|` 之前的那半截（id），只打印给人看的部分。
    printf '   · %s\n' "${ci_only[@]#*|}"
  fi
else
  echo "有步骤失败"
fi
exit $fail
